-- Deleting your own things from the homepage, and an admin who can delete anyone's.
--
-- * is_admin(): true for an account whose app_metadata has role = 'admin'. app_metadata
--   can only be set server-side (SQL or the dashboard), never by the user.
-- * A jam (session) is deleted by its creator or an admin: sessions.deleted_at is set and
--   every page leaves it out. Its rows and audio stay.
-- * A take is deleted by its author or an admin with delete_thread_take(): it becomes
--   'deleted' like delete_take() does, and the app removes its audio file from Storage.
--   Replies played on top of it stay, with their own audio. Original tracks, mixes and
--   new parts are not deleted this way (parts carry layers, see delete_take()).
-- * A written comment is deleted by its author or an admin with delete_thread_comment():
--   deleted_at is set and the text is cleared; replies to it stay.
-- Rows are kept rather than deleted (see "Nothing is deleted" in CLAUDE.md).

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public, auth
as $$
  select exists (
    select 1 from auth.users u
    where u.id = auth.uid() and u.raw_app_meta_data ->> 'role' = 'admin'
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

alter table public.sessions add column deleted_at timestamptz;
alter table public.thread_comments add column deleted_at timestamptz;

alter table public.thread_comments drop constraint thread_comments_body_check;
alter table public.thread_comments add constraint thread_comments_body_check
  check (deleted_at is not null or char_length(body) between 1 and 500);

create or replace function public.delete_jam(p_session uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  s sessions;
begin
  select * into s from sessions where id = p_session for update;
  if not found then raise exception 'Jam not found'; end if;
  if s.host_id is distinct from auth.uid() and not is_admin() then
    raise exception 'Only the creator can delete this jam';
  end if;
  update sessions set deleted_at = coalesce(deleted_at, now()) where id = p_session;
end;
$$;

create or replace function public.delete_thread_take(p_take uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  t takes;
begin
  select * into t from takes where id = p_take for update;
  if not found then raise exception 'Take not found'; end if;
  if t.status = 'deleted' then return; end if;
  if t.author_id is distinct from auth.uid() and not is_admin() then
    raise exception 'You can only delete your own takes';
  end if;
  if t.role_id in ('seed', 'mix', 'part') then
    raise exception 'Delete this in the song view';
  end if;
  update takes set status = 'deleted', joined_at = null where id = p_take;
end;
$$;

create or replace function public.delete_thread_comment(p_comment uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  c thread_comments;
begin
  select * into c from thread_comments where id = p_comment for update;
  if not found then raise exception 'Comment not found'; end if;
  if c.author_id is distinct from auth.uid() and not is_admin() then
    raise exception 'You can only delete your own comments';
  end if;
  update thread_comments set deleted_at = coalesce(deleted_at, now()), body = '' where id = p_comment;
end;
$$;

revoke all on function public.delete_jam(uuid) from public, anon;
revoke all on function public.delete_thread_take(uuid) from public, anon;
revoke all on function public.delete_thread_comment(uuid) from public, anon;
grant execute on function public.delete_jam(uuid) to authenticated;
grant execute on function public.delete_thread_take(uuid) to authenticated;
grant execute on function public.delete_thread_comment(uuid) to authenticated;

-- Removing a file from Storage needs select and delete on its object: your own folder,
-- or any file for an admin, and only once its take is deleted, so no live audio can go
-- missing. (The bucket is public-read for playback either way.)
create policy "see your own audio objects" on storage.objects
  for select to authenticated
  using (bucket_id = 'takes' and ((storage.foldername(name))[2] = auth.uid()::text or public.is_admin()));

create policy "delete the audio of a deleted take" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'takes'
    and ((storage.foldername(name))[2] = auth.uid()::text or public.is_admin())
    and exists (select 1 from public.takes t where t.storage_path = objects.name and t.status = 'deleted')
  );

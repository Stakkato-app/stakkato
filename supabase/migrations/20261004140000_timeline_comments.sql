-- Comments on the timeline, SoundCloud style: anyone in a session pins a short comment to a
-- moment in the song. at_sec is measured from the start of the original track, so a comment
-- stays on the same music when new parts are added before it (a comment on a part before
-- the original track has a negative at_sec).
--
-- Like everything in a session, comments are readable by everyone. Anyone signed in (also
-- anonymously) can comment while the session is open; after release they are frozen.
-- Nothing is deleted: the creator hides a comment with hide_comment().

create table public.comments (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.sessions (id) on delete cascade,
  author_id   uuid not null references auth.users (id) on delete cascade,
  author_name text not null check (char_length(author_name) between 1 and 60),
  body        text not null check (char_length(body) between 1 and 500),
  at_sec      real not null,
  hidden      boolean not null default false,
  created_at  timestamptz not null default now()
);

create index comments_session_idx on public.comments (session_id);

alter table public.comments enable row level security;

create policy "comments are readable" on public.comments
  for select to anon, authenticated using (true);

create policy "comment on an open session" on public.comments
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and hidden = false
    and exists (select 1 from public.sessions s where s.id = comments.session_id and s.status = 'open')
  );

-- The creator hides a comment (it stays in the table, the app filters it out).
create or replace function public.hide_comment(p_comment uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  c comments;
  s sessions;
begin
  select * into c from comments where id = p_comment for update;
  if not found then raise exception 'Comment not found'; end if;
  select * into s from sessions where id = c.session_id;
  if s.host_id is distinct from auth.uid() then raise exception 'Only the creator can hide comments'; end if;
  update comments set hidden = true where id = p_comment;
end;
$$;

revoke all on function public.hide_comment(uuid) from public, anon;
grant execute on function public.hide_comment(uuid) to authenticated;

alter publication supabase_realtime add table public.comments;

-- The person who recorded an own take (one made for their own version, status 'own') can
-- delete it themselves, also after the song is released. Everything else stays as before:
-- only the creator deletes takes, while the session is open, never the original track.

create or replace function public.delete_take(p_take uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  t takes;
  s sessions;
begin
  select * into t from takes where id = p_take for update;
  if not found then raise exception 'Take not found'; end if;
  if t.status = 'deleted' then return; end if;

  if t.status = 'own' and t.author_id = auth.uid() then
    update takes set status = 'deleted', joined_at = null where id = p_take;
    return;
  end if;

  select * into s from sessions where id = t.session_id;
  if s.host_id is distinct from auth.uid() then raise exception 'Only the creator can delete takes'; end if;
  if s.status <> 'open' then raise exception 'The session is closed'; end if;
  if t.role_id = 'seed' then raise exception 'The original track cannot be deleted, replace it instead'; end if;

  update takes set status = 'deleted', joined_at = null where id = p_take;
  if t.role_id = 'part' then
    update takes set status = 'deleted', joined_at = null where section_id = p_take and status <> 'deleted';
  end if;
end;
$$;

revoke all on function public.delete_take(uuid) from public, anon;
grant execute on function public.delete_take(uuid) to authenticated;

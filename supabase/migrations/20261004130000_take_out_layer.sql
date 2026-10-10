-- The creator takes a layer back out of the project. Unlike delete_take() the take stays
-- usable: it goes to the archive with reason 'removed', so anyone can still pick it for
-- their own version (and the creator can't let it back in without it being sent again).

create or replace function public.take_out_layer(p_take uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  t takes;
  s sessions;
begin
  select * into t from takes where id = p_take for update;
  if not found then raise exception 'Take not found'; end if;

  select * into s from sessions where id = t.session_id;
  if s.host_id is distinct from auth.uid() then raise exception 'Only the creator can take layers out of the project'; end if;
  if s.status <> 'open' then raise exception 'The session is closed'; end if;
  if t.role_id in ('seed', 'mix', 'part') then raise exception 'That is not a layer'; end if;
  if t.status <> 'in' then raise exception 'That layer is not in the project'; end if;

  update takes set status = 'archived', archive_reason = 'removed', joined_at = null where id = p_take;
end;
$$;

revoke all on function public.take_out_layer(uuid) from public, anon;
grant execute on function public.take_out_layer(uuid) to authenticated;

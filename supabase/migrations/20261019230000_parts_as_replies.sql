-- New parts are replies, not pitches.
--
-- Making the song longer used to be a pitch to the creator: nobody could play on a new part
-- until the creator kept it. Now a new part is a reply in the thread like any take: anyone can
-- layer on it right away (one person can even send the part and its layers in one go), and the
-- creator decides later what goes in the song.
--
-- 1. "send a take": a layer may sit on a new part that is still waiting, not only on a kept one.
-- 2. let_in(): adding such a layer to the song brings its part into the song too.
-- Both are copies of the versions in 20261017120000_accounts.sql with only those lines changed.

drop policy "send a take" on public.takes;
create policy "send a take" on public.takes
  for insert to authenticated
  with check (
    author_id = auth.uid() and public.has_account()
    and joined_at is null and archive_reason is null
    and fade_in = 0 and fade_out = 0 and xfade = 0
    and split_part(storage_path, '/', 1) = session_id::text
    and split_part(storage_path, '/', 2) = auth.uid()::text
    and (section_id is null or exists (
      select 1 from public.takes p
      where p.id = takes.section_id and p.session_id = takes.session_id and p.role_id = 'part' and p.status in ('in', 'waiting')))
    and exists (
      select 1 from public.sessions s
      where s.id = takes.session_id and (
        (takes.role_id = 'seed' and takes.status = 'seed' and s.host_id = auth.uid() and s.status = 'open')
        or (takes.role_id not in ('seed', 'mix') and takes.status = 'waiting' and s.status = 'open')
        or (takes.role_id not in ('seed', 'mix', 'part') and takes.status = 'own' and takes.section_id is null)
        or (takes.role_id = 'mix' and takes.status = 'mix' and s.status = 'released')))
  );

create or replace function public.let_in(p_take uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  t      takes;
  s      sessions;
  cap    int;
  n      int;
  out_id uuid;
begin
  perform public.require_account();
  select * into t from takes where id = p_take for update;
  if not found then raise exception 'Take not found'; end if;

  select * into s from sessions where id = t.session_id for update;
  if s.host_id is distinct from auth.uid() then raise exception 'Only the creator can let takes in'; end if;
  if s.status <> 'open' then raise exception 'The session is closed'; end if;
  if t.status <> 'waiting' then raise exception 'That take is not waiting'; end if;

  if t.role_id = 'part' then
    update takes set status = 'in', joined_at = now() where id = p_take;
    return;
  end if;

  if t.section_id is not null then
    -- a layer on a new part nobody added yet brings that part into the song with it
    update takes set status = 'in', joined_at = now()
      where id = t.section_id and role_id = 'part' and status = 'waiting' and session_id = t.session_id;
    if not exists (
      select 1 from takes p where p.id = t.section_id and p.role_id = 'part' and p.status = 'in'
    ) then
      raise exception 'The part this layer plays on is not in the song';
    end if;
  end if;

  cap := public.section_cap(t.session_id, t.role_id, t.section_id);
  if cap < 1 then raise exception 'The original track plays that part, so there is no spot to let a layer into'; end if;

  select count(*) into n from takes
    where session_id = t.session_id and role_id = t.role_id and status = 'in'
      and section_id is not distinct from t.section_id;

  if n >= cap then
    select id into out_id from takes
      where session_id = t.session_id and role_id = t.role_id and status = 'in'
        and section_id is not distinct from t.section_id
      order by joined_at asc limit 1;
    update takes set status = 'waiting', joined_at = null where id = out_id;
  end if;

  update takes set status = 'in', joined_at = now() where id = p_take;
end;
$$;

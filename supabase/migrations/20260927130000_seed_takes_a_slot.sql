-- The seed's instrument takes up one slot in that role. A seed that is rhythm guitar
-- (1 slot) leaves no room for guitar takes in the line-up; a seed that is vocals
-- (2 slots) leaves one. Takes can still be sent for a full role and used in versions.

-- Slots left for takes in a role, after the seed.
create or replace function public.role_cap(p_session uuid, p_role text)
returns int
language sql stable security definer set search_path = public
as $$
  select r.slots - case when s.seed_role = p_role then 1 else 0 end
  from roles r, sessions s
  where r.id = p_role and s.id = p_session;
$$;

-- Same as before, but counts the seed's slot, and nobody votes on a take that has no
-- spot to go to.
create or replace function public.can_vote(p_take uuid, p_uid uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  with t as (
    select tk.* from takes tk where tk.id = p_take and tk.status = 'waiting'
  ),
  here as (
    select m.id, m.joined_at from takes m, t
    where m.session_id = t.session_id and m.role_id = t.role_id and m.status = 'in'
  ),
  stake as (
    select h.id from here h
    where (select count(*) from here) >= (select public.role_cap(t.session_id, t.role_id) from t)
    order by h.joined_at asc
    limit 1
  )
  select exists (select 1 from t)
     and (select public.role_cap(t.session_id, t.role_id) from t) > 0
     and exists (select 1 from sessions s, t where s.id = t.session_id and s.status = 'open')
     and exists (
       select 1 from takes m, t
       where m.session_id = t.session_id and m.status = 'in' and m.author_id = p_uid
         and m.id not in (select id from stake)
     );
$$;

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
  select * into t from takes where id = p_take for update;
  if not found then raise exception 'Take not found'; end if;

  select * into s from sessions where id = t.session_id for update;
  if s.host_id is distinct from auth.uid() then raise exception 'Only the host can let takes in'; end if;
  if s.status <> 'open' then raise exception 'The session is closed'; end if;
  if t.status <> 'waiting' then raise exception 'That take is not waiting'; end if;

  cap := public.role_cap(t.session_id, t.role_id);
  if cap < 1 then raise exception 'The seed plays that part, so there is no spot to let a take into'; end if;

  select count(*) into n from takes
    where session_id = t.session_id and role_id = t.role_id and status = 'in';

  if n >= cap then
    select id into out_id from takes
      where session_id = t.session_id and role_id = t.role_id and status = 'in'
      order by joined_at asc limit 1;
    update takes set status = 'waiting', joined_at = null where id = out_id;
  end if;

  update takes set status = 'in', joined_at = now() where id = p_take;
end;
$$;

-- When the host changes what the seed is, the seed claims its slot. If that role is now
-- over its limit, the longest-standing takes go back to the waiting list (same rule as
-- let_in). Changing it after the session is closed would rewrite the release, so no.
create or replace function public.seed_role_claims_slot()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  cap int;
begin
  if new.seed_role is not distinct from old.seed_role then return new; end if;
  if new.status <> 'open' then raise exception 'The session is closed'; end if;
  if new.seed_role is null then return new; end if;

  select slots - 1 into cap from roles where id = new.seed_role;
  update takes set status = 'waiting', joined_at = null
  where id in (
    select id from takes
    where session_id = new.id and role_id = new.seed_role and status = 'in'
    order by joined_at desc
    offset cap
  );
  return new;
end;
$$;

create trigger sessions_seed_role_claims_slot
  after update of seed_role on public.sessions
  for each row execute function public.seed_role_claims_slot();

revoke all on function public.role_cap(uuid, text) from public, anon;
revoke all on function public.seed_role_claims_slot() from public, anon;
grant execute on function public.role_cap(uuid, text) to authenticated;

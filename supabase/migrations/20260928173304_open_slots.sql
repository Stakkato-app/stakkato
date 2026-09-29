-- Open slots per instrument: no per-instrument cap. It stops when the creator decides
-- (same standing decision as the prototype). A null in roles.slots means unlimited;
-- role_cap() and section_cap() pass that null straight through, and every function that
-- reads a cap already treats a null/absent cap as "never full" (see the notes below).

-- ---------------------------------------------------------------------------
-- Slots become nullable; null = unlimited. Every existing role goes unlimited.
-- ---------------------------------------------------------------------------
alter table public.roles alter column slots drop not null;
alter table public.roles drop constraint roles_slots_check;
alter table public.roles add constraint roles_slots_check check (slots is null or slots > 0);

update public.roles set slots = null;

-- ---------------------------------------------------------------------------
-- role_cap(): unlimited stays unlimited regardless of what the seed plays.
-- ---------------------------------------------------------------------------
create or replace function public.role_cap(p_session uuid, p_role text)
returns int
language sql stable security definer set search_path = public
as $$
  select case when r.slots is null then null
              else r.slots - case when s.seed_role = p_role then 1 else 0 end end
  from roles r, sessions s
  where r.id = p_role and s.id = p_session;
$$;

-- section_cap() already delegates to role_cap() for the seed (p_section null) and to
-- roles.slots directly for a kept part, so a null slots value flows through unchanged
-- without any change to the function itself.

-- ---------------------------------------------------------------------------
-- can_vote(): a null cap means nobody is ever "at stake", so nobody can be pushed out
-- by a vote. The old `coalesce(cap, 0) > 0` treated null as 0 (no room, no voting) --
-- now a null cap must read as "always room".
-- ---------------------------------------------------------------------------
create or replace function public.can_vote(p_take uuid, p_uid uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  with t as (
    select tk.* from takes tk where tk.id = p_take and tk.status = 'waiting' and tk.role_id <> 'part'
  ),
  here as (
    select m.id, m.joined_at from takes m, t
    where m.session_id = t.session_id and m.role_id = t.role_id and m.status = 'in'
      and m.section_id is not distinct from t.section_id
  ),
  stake as (
    select h.id from here h
    where (select public.section_cap(t.session_id, t.role_id, t.section_id) from t) is not null
      and (select count(*) from here) >= (select public.section_cap(t.session_id, t.role_id, t.section_id) from t)
    order by h.joined_at asc
    limit 1
  )
  select exists (select 1 from t)
     and (select public.section_cap(t.session_id, t.role_id, t.section_id) from t) is distinct from 0
     and exists (select 1 from sessions s, t where s.id = t.session_id and s.status = 'open')
     and exists (
       select 1 from takes m, t
       where m.session_id = t.session_id and m.status = 'in' and m.author_id = p_uid
         and m.role_id <> 'part'
         and m.id not in (select id from stake)
     );
$$;

-- let_in() already reads correctly with a null cap: `if cap < 1` and `if n >= cap` are
-- both null (falsy) in plpgsql when cap is null, so nobody gets evicted. No change needed.

-- ---------------------------------------------------------------------------
-- seed_role_claims_slot(): guard the eviction offset. `OFFSET NULL` behaves like
-- `OFFSET 0` in Postgres, which would have evicted every take in the role instead of
-- none -- so an unlimited role must return before it gets there.
-- ---------------------------------------------------------------------------
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

  select slots into cap from roles where id = new.seed_role;
  if cap is null then return new; end if;

  update takes set status = 'waiting', joined_at = null
  where id in (
    select id from takes
    where session_id = new.id and role_id = new.seed_role and status = 'in' and section_id is null
    order by joined_at desc
    offset cap - 1
  );
  return new;
end;
$$;

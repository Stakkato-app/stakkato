-- New parts before or after the original track, fades and crossfades, and deleting takes.
--
-- New parts: anyone can pitch a piece of audio of any length that plays before or after
-- the seed (role 'part', status 'waiting'). The host keeps it (status 'in', the song gets
-- longer) or passes on it (status 'archived', reason 'passed'). Layers can be sent for a
-- kept part as well as for the seed; section_id says which (null = the seed).
--
-- Slots now count per section: the seed and every kept part have their own line-up, so
-- letting drums in on an intro doesn't push out the drums on the seed. The seed's own
-- instrument still takes a slot, on the seed only.
--
-- Deleting: the host can delete takes while the session is open. The row stays with
-- status 'deleted' (realtime can't filter DELETE events), the app hides it. The audio
-- file stays in Storage.

-- ---------------------------------------------------------------------------
-- Columns and constraints
-- ---------------------------------------------------------------------------
alter table public.takes drop constraint takes_role_id_check;
alter table public.takes add constraint takes_role_id_check
  check (role_id in ('seed', 'mix', 'part') or role_id in ('drums','guitar','bass','lead','atmos','wild','vocals'));

alter table public.takes drop constraint takes_status_check;
alter table public.takes add constraint takes_status_check
  check (status in ('seed', 'waiting', 'in', 'archived', 'mix', 'deleted'));

alter table public.takes
  add column part_pos   text,
  add column section_id uuid references public.takes (id) on delete cascade,
  add column fade_in    real not null default 0,
  add column fade_out   real not null default 0,
  add column xfade      real not null default 0;

alter table public.takes
  add constraint takes_part_pos_check check ((part_pos in ('before', 'after')) is not false),
  add constraint takes_part_pos_role_check check ((role_id = 'part') = (part_pos is not null)),
  add constraint takes_section_role_check check (section_id is null or role_id not in ('seed', 'mix', 'part')),
  add constraint takes_fades_check check (fade_in >= 0 and fade_out >= 0 and xfade between 0 and 8);

create index takes_section_idx on public.takes (section_id) where section_id is not null;

-- ---------------------------------------------------------------------------
-- Slots per section
-- ---------------------------------------------------------------------------

-- Slots left for takes in a role on one section. On the seed (p_section null) the seed's
-- own instrument takes one (role_cap); on a new part every slot is free.
create or replace function public.section_cap(p_session uuid, p_role text, p_section uuid)
returns int
language sql stable security definer set search_path = public
as $$
  select case when p_section is null then public.role_cap(p_session, p_role)
              else (select r.slots from roles r where r.id = p_role) end;
$$;

-- Same rules as before, counted per section. Nobody votes on new parts.
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
    where (select count(*) from here) >= (select public.section_cap(t.session_id, t.role_id, t.section_id) from t)
    order by h.joined_at asc
    limit 1
  )
  select exists (select 1 from t)
     and coalesce((select public.section_cap(t.session_id, t.role_id, t.section_id) from t), 0) > 0
     and exists (select 1 from sessions s, t where s.id = t.session_id and s.status = 'open')
     and exists (
       select 1 from takes m, t
       where m.session_id = t.session_id and m.status = 'in' and m.author_id = p_uid
         and m.role_id <> 'part'
         and m.id not in (select id from stake)
     );
$$;

-- Host lets a waiting take in. A new part has no slots, keeping it makes the song longer.
-- A layer needs its section to be in the song; if the role is full on that section, the
-- longest-standing take there goes back to the waiting list.
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
  if s.host_id is distinct from auth.uid() then raise exception 'Only the creator can let takes in'; end if;
  if s.status <> 'open' then raise exception 'The session is closed'; end if;
  if t.status <> 'waiting' then raise exception 'That take is not waiting'; end if;

  if t.role_id = 'part' then
    update takes set status = 'in', joined_at = now() where id = p_take;
    return;
  end if;

  if t.section_id is not null and not exists (
    select 1 from takes p where p.id = t.section_id and p.role_id = 'part' and p.status = 'in'
  ) then
    raise exception 'The part this layer plays on is not in the song';
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

-- Host vetoes a waiting layer, or passes on a pitched part.
create or replace function public.veto(p_take uuid)
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
  if s.host_id is distinct from auth.uid() then raise exception 'Only the creator can veto takes'; end if;
  if s.status <> 'open' then raise exception 'The session is closed'; end if;
  if t.status <> 'waiting' then raise exception 'That take is not waiting'; end if;

  update takes
    set status = 'archived', archive_reason = case when t.role_id = 'part' then 'passed' else 'vetoed' end
    where id = p_take;
end;
$$;

-- Host takes a kept part back out of the song. Layers on it stay, but are not heard.
create or replace function public.drop_part(p_take uuid)
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
  if s.host_id is distinct from auth.uid() then raise exception 'Only the creator can change the song'; end if;
  if s.status <> 'open' then raise exception 'The session is closed'; end if;
  if t.role_id <> 'part' or t.status <> 'in' then raise exception 'That is not a part in the song'; end if;

  update takes set status = 'archived', archive_reason = 'passed', joined_at = null where id = p_take;
end;
$$;

-- Host sets the fades on a clip, and the crossfade of a new part. Everyone hears them.
create or replace function public.set_fades(p_take uuid, p_in real, p_out real, p_xfade real)
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
  if s.host_id is distinct from auth.uid() then raise exception 'Only the creator can set fades'; end if;
  if s.status <> 'open' then raise exception 'The session is closed'; end if;
  if t.status = 'deleted' then raise exception 'That take was deleted'; end if;

  update takes set
    fade_in  = greatest(0, least(coalesce(p_in, 0),  t.duration_sec / 2)),
    fade_out = greatest(0, least(coalesce(p_out, 0), t.duration_sec / 2)),
    xfade    = case when t.role_id = 'part' then greatest(0, least(coalesce(p_xfade, 0), 8)) else 0 end
  where id = p_take;
end;
$$;

-- Host deletes a take (never the seed). Deleting a part deletes the layers on it too.
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

  select * into s from sessions where id = t.session_id;
  if s.host_id is distinct from auth.uid() then raise exception 'Only the creator can delete takes'; end if;
  if s.status <> 'open' then raise exception 'The session is closed'; end if;
  if t.role_id = 'seed' then raise exception 'The original track cannot be deleted, replace it instead'; end if;
  if t.status = 'deleted' then return; end if;

  update takes set status = 'deleted', joined_at = null where id = p_take;
  if t.role_id = 'part' then
    update takes set status = 'deleted', joined_at = null where section_id = p_take and status <> 'deleted';
  end if;
end;
$$;

-- The seed's instrument claims its slot on the seed only.
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
    where session_id = new.id and role_id = new.seed_role and status = 'in' and section_id is null
    order by joined_at desc
    offset cap
  );
  return new;
end;
$$;

revoke all on function public.section_cap(uuid, text, uuid) from public, anon;
revoke all on function public.drop_part(uuid) from public, anon;
revoke all on function public.set_fades(uuid, real, real, real) from public, anon;
revoke all on function public.delete_take(uuid) from public, anon;
grant execute on function public.section_cap(uuid, text, uuid) to authenticated;
grant execute on function public.drop_part(uuid) to authenticated;
grant execute on function public.set_fades(uuid, real, real, real) to authenticated;
grant execute on function public.delete_take(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Sending takes: parts need a position, layers on a part need that part to be in the
-- song, and nobody sends a take with fades already set.
-- ---------------------------------------------------------------------------
drop policy "send a take" on public.takes;

create policy "send a take" on public.takes
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and joined_at is null
    and archive_reason is null
    and fade_in = 0 and fade_out = 0 and xfade = 0
    and split_part(storage_path, '/', 1) = session_id::text
    and split_part(storage_path, '/', 2) = auth.uid()::text
    and (
      section_id is null
      or exists (
        select 1 from public.takes p
        where p.id = takes.section_id and p.session_id = takes.session_id
          and p.role_id = 'part' and p.status = 'in'
      )
    )
    and exists (
      select 1 from public.sessions s
      where s.id = takes.session_id
        and (
             (takes.role_id = 'seed' and takes.status = 'seed' and s.host_id = auth.uid() and s.status = 'open')
          or (takes.role_id not in ('seed', 'mix') and takes.status = 'waiting' and s.status = 'open')
          or (takes.role_id = 'mix' and takes.status = 'mix' and s.status = 'released')
        )
    )
  );

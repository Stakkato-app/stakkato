-- Vocals becomes a seventh instrument, and the host can say which instrument the seed is.

-- ---------------------------------------------------------------------------
-- Vocals role. Keep in sync with src/roles.js.
-- ---------------------------------------------------------------------------
insert into public.roles (id, label, slots, sort) values
  ('vocals', 'Vocals', 2, 7);

alter table public.takes drop constraint takes_role_id_check;
alter table public.takes add constraint takes_role_id_check
  check (role_id in ('seed', 'mix') or role_id in ('drums','guitar','bass','lead','atmos','wild','vocals'));

-- ---------------------------------------------------------------------------
-- Which instrument the seed is. Null means not set (a full idea, a mix of things).
-- Lives on the session like tempo and key, so the host can change it through the
-- existing "host edits the session" policy, and it survives replacing the seed.
-- Display only: the seed does not take up a slot in that role.
-- ---------------------------------------------------------------------------
alter table public.sessions
  add column seed_role text references public.roles (id);

-- Riffraff: initial schema
-- Sessions (one song each), takes (audio layers), line-up votes, fan versions, likes and reactions.
-- Every write is tied to auth.uid(). Visitors get an anonymous Supabase user on first load,
-- which can later be upgraded to a real account without losing anything.

-- ---------------------------------------------------------------------------
-- Instrument roles. Slots here are authoritative; src/roles.js mirrors them for display.
-- ---------------------------------------------------------------------------
create table public.roles (
  id     text primary key,
  label  text not null,
  slots  int  not null check (slots > 0),
  sort   int  not null
);

insert into public.roles (id, label, slots, sort) values
  ('drums',  'Drums',         1, 1),
  ('guitar', 'Rhythm guitar', 1, 2),
  ('bass',   'Bass',          1, 3),
  ('lead',   'Lead',          2, 4),
  ('atmos',  'Atmosphere',    2, 5),
  ('wild',   'Wildcard',      2, 6);

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------
create table public.sessions (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique default substr(replace(gen_random_uuid()::text, '-', ''), 1, 10),
  host_id      uuid not null references auth.users (id) on delete cascade,
  title        text not null default 'Untitled' check (char_length(title) <= 120),
  status       text not null default 'open' check (status in ('open', 'released')),
  seed_take_id uuid,
  bpm          int  check (bpm between 20 and 400),
  music_key    text,
  key_alt      text,
  time_sig     text not null default '4/4',
  meta_from    text not null default 'none' check (meta_from in ('none', 'detected', 'you')),
  meta_sure    text,
  created_at   timestamptz not null default now(),
  released_at  timestamptz
);

-- ---------------------------------------------------------------------------
-- Takes: the seed, every submitted layer, and optional mixed versions
-- status: seed | waiting | in | archived | mix
-- ---------------------------------------------------------------------------
create table public.takes (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.sessions (id) on delete cascade,
  author_id      uuid not null references auth.users (id) on delete cascade,
  author_name    text not null check (char_length(author_name) between 1 and 60),
  role_id        text not null check (role_id in ('seed', 'mix') or role_id in ('drums','guitar','bass','lead','atmos','wild')),
  note           text not null default '' check (char_length(note) <= 280),
  status         text not null check (status in ('seed', 'waiting', 'in', 'archived', 'mix')),
  archive_reason text,
  storage_path   text not null,
  file_name      text not null,
  mime_type      text,
  duration_sec   real not null check (duration_sec > 0),
  an_bpm         int,
  an_key         text,
  joined_at      timestamptz,
  created_at     timestamptz not null default now()
);

create index takes_session_idx on public.takes (session_id);

alter table public.sessions
  add constraint sessions_seed_take_fk foreign key (seed_take_id) references public.takes (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Line-up votes on waiting takes (one per voter per take, changeable, never deleted)
-- ---------------------------------------------------------------------------
create table public.votes (
  take_id    uuid not null references public.takes (id) on delete cascade,
  voter_id   uuid not null references auth.users (id) on delete cascade,
  session_id uuid not null references public.sessions (id) on delete cascade,
  value      text not null check (value in ('up', 'down')),
  updated_at timestamptz not null default now(),
  primary key (take_id, voter_id)
);

create index votes_session_idx on public.votes (session_id);

-- ---------------------------------------------------------------------------
-- Fan versions: a choice of takes plus mixer settings. No audio is copied.
-- ---------------------------------------------------------------------------
create table public.versions (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  author_id  uuid not null references auth.users (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 60),
  by_name    text not null check (char_length(by_name) between 1 and 60),
  picks      uuid[] not null default '{}',
  ctl        jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index versions_session_idx on public.versions (session_id);

create table public.version_likes (
  version_id uuid not null references public.versions (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  session_id uuid not null references public.sessions (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (version_id, user_id)
);

create table public.reactions (
  session_id uuid not null references public.sessions (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       text not null check (kind in ('banger', 'mess', 'again')),
  created_at timestamptz not null default now(),
  primary key (session_id, user_id, kind)
);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Can this user vote on this waiting take? They need a take in the line-up of the same
-- session, and that take must not be the one the newcomer would push out.
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
    where (select count(*) from here) >= (select r.slots from roles r, t where r.id = t.role_id)
    order by h.joined_at asc
    limit 1
  )
  select exists (select 1 from t)
     and exists (select 1 from sessions s, t where s.id = t.session_id and s.status = 'open')
     and exists (
       select 1 from takes m, t
       where m.session_id = t.session_id and m.status = 'in' and m.author_id = p_uid
         and m.id not in (select id from stake)
     );
$$;

-- Host lets a waiting take in. If the role is full, the longest-standing take in that
-- role goes back to the waiting list (same rule as the original prototype).
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

  select slots into cap from roles where id = t.role_id;
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

-- Host vetoes a waiting take. It moves to the archive and stays usable in fan versions.
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
  if s.host_id is distinct from auth.uid() then raise exception 'Only the host can veto takes'; end if;
  if s.status <> 'open' then raise exception 'The session is closed'; end if;
  if t.status <> 'waiting' then raise exception 'That take is not waiting'; end if;

  update takes set status = 'archived', archive_reason = 'vetoed' where id = p_take;
end;
$$;

revoke all on function public.can_vote(uuid, uuid) from public, anon;
revoke all on function public.let_in(uuid) from public, anon;
revoke all on function public.veto(uuid) from public, anon;
grant execute on function public.can_vote(uuid, uuid) to authenticated;
grant execute on function public.let_in(uuid) to authenticated;
grant execute on function public.veto(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security
-- Reads are open: anyone with the link sees the session. Writes need a signed-in user
-- (anonymous users count) and are scoped to that user.
-- ---------------------------------------------------------------------------
alter table public.roles         enable row level security;
alter table public.sessions      enable row level security;
alter table public.takes         enable row level security;
alter table public.votes         enable row level security;
alter table public.versions      enable row level security;
alter table public.version_likes enable row level security;
alter table public.reactions     enable row level security;

create policy "roles are readable"         on public.roles         for select to anon, authenticated using (true);
create policy "sessions are readable"      on public.sessions      for select to anon, authenticated using (true);
create policy "takes are readable"         on public.takes         for select to anon, authenticated using (true);
create policy "votes are readable"         on public.votes         for select to anon, authenticated using (true);
create policy "versions are readable"      on public.versions      for select to anon, authenticated using (true);
create policy "likes are readable"         on public.version_likes for select to anon, authenticated using (true);
create policy "reactions are readable"     on public.reactions     for select to anon, authenticated using (true);

-- Sessions: you host what you create; only the host edits it.
create policy "create a session you host" on public.sessions
  for insert to authenticated
  with check (host_id = auth.uid() and status = 'open' and seed_take_id is null);

create policy "host edits the session" on public.sessions
  for update to authenticated
  using (host_id = auth.uid())
  with check (
    host_id = auth.uid()
    and (
      seed_take_id is null
      or exists (
        select 1 from public.takes t
        where t.id = seed_take_id and t.session_id = sessions.id and t.role_id = 'seed'
      )
    )
  );

-- Takes: insert only as yourself, into your own storage folder, in the state that
-- matches the session phase. Status changes go through let_in() and veto().
create policy "send a take" on public.takes
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and joined_at is null
    and archive_reason is null
    and split_part(storage_path, '/', 1) = session_id::text
    and split_part(storage_path, '/', 2) = auth.uid()::text
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

-- Votes
create policy "cast a vote" on public.votes
  for insert to authenticated
  with check (
    voter_id = auth.uid()
    and public.can_vote(take_id, auth.uid())
    and session_id = (select t.session_id from public.takes t where t.id = take_id)
  );

create policy "change your vote" on public.votes
  for update to authenticated
  using (voter_id = auth.uid())
  with check (
    voter_id = auth.uid()
    and public.can_vote(take_id, auth.uid())
    and session_id = (select t.session_id from public.takes t where t.id = take_id)
  );

-- Versions
create policy "save a version" on public.versions
  for insert to authenticated
  with check (author_id = auth.uid());

-- Likes and reactions: one per person, no take-backs (keeps realtime filters simple).
create policy "like a version" on public.version_likes
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and session_id = (select v.session_id from public.versions v where v.id = version_id)
  );

create policy "react to a release" on public.reactions
  for insert to authenticated
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Storage: public bucket for take audio. Path: {session_id}/{user_id}/{file}
-- Uploads go straight from the browser to Supabase, never through Vercel.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('takes', 'takes', true, 52428800, array['audio/*'])
on conflict (id) do nothing;

create policy "upload audio to your own folder" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'takes'
    and (storage.foldername(name))[2] = auth.uid()::text
    and exists (
      select 1 from public.sessions s where s.id::text = (storage.foldername(name))[1]
    )
  );

-- ---------------------------------------------------------------------------
-- Realtime: clients subscribe per session and refetch on any change.
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table
  public.sessions, public.takes, public.votes, public.versions, public.version_likes, public.reactions;

-- Accounts: profiles with a fixed name, and an account to write anything.
--
-- * profiles: one per account (email or Google), keyed by auth.users.id. The name is
--   3 to 24 letters, numbers, dots, dashes or underscores, unique ignoring case, and never
--   changes after it's picked (only admin_rename() fixes one). Readable by everyone; there
--   are no insert/update policies: names are only set by the new-user trigger,
--   pick_username() and admin_rename().
-- * A new email account gets its profile from the username it signed up with
--   (raw_user_meta_data.username); a taken, reserved or invalid name makes the sign-up
--   fail. A Google account gets a profile without a name and picks one with
--   pick_username(). Anonymous users get no profile.
-- * has_account(): signed in, not anonymous, with a named profile. Every insert/update
--   policy and every write function requires it, so listening and reading need nothing
--   and writing needs an account. (While "Confirm email" is on, an unconfirmed email
--   account can't get a session at all.)
-- * author_name / by_name are filled from the author's profile on insert, so names
--   can't be faked and the display code keeps reading the copies.
-- * house_accounts: our own seeding accounts, readable only by the admin.
-- * admin_accounts(): the admin's list of accounts, the only way emails leave the database.
-- Also fixes the thread reply policy, whose check on reply_to_comment compared the
-- comment with itself (c.id = c.reply_to_comment), so replies to a comment were refused.

-- ---------- profiles ----------

create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  username   text check (username ~ '^[A-Za-z0-9._-]{3,24}$'),
  created_at timestamptz not null default now()
);
create unique index profiles_username_lower on public.profiles (lower(username));

alter table public.profiles enable row level security;
create policy "profiles are readable" on public.profiles
  for select to anon, authenticated using (true);

create table public.house_accounts (
  user_id uuid primary key references auth.users (id) on delete cascade
);
alter table public.house_accounts enable row level security;
create policy "the admin sees the house accounts" on public.house_accounts
  for select to authenticated using (public.is_admin());

-- names nobody can pick (pages, routes and words that would look official)
create or replace function public.reserved_username(p_name text)
returns boolean
language sql immutable set search_path = public
as $$
  select lower(p_name) = any (array[
    'admin', 'administrator', 'stakkato', 'stackato', 'riffraff', 'new', 'songs', 'song',
    'settings', 'u', 's', 'auth', 'reset', 'privacy', 'profile', 'account', 'accounts',
    'login', 'logout', 'signin', 'signout', 'signup', 'register', 'api', 'www', 'mail',
    'hello', 'help', 'support', 'noreply', 'no-reply', 'root', 'system', 'staff',
    'moderator', 'mod', 'official', 'team', 'about', 'terms', 'jams', 'jam', 'session',
    'me', 'null', 'undefined', 'anonymous', 'everyone'
  ]);
$$;

-- why a name can't be picked: null when it can, else 'invalid', 'reserved' or 'taken'
create or replace function public.username_problem(p_name text, p_self uuid default null)
returns text
language sql stable security definer set search_path = public
as $$
  select case
    when p_name is null or p_name !~ '^[A-Za-z0-9._-]{3,24}$' then 'invalid'
    when public.reserved_username(p_name) then 'reserved'
    when exists (select 1 from profiles p
                 where lower(p.username) = lower(p_name) and p.id is distinct from p_self) then 'taken'
  end;
$$;

-- the live check in the sign-up and pick-name forms: { ok, reason, suggestions }.
-- p_hints are extra words to build suggestions from (a Google account's full name).
create or replace function public.username_check(p_name text, p_hints text[] default '{}')
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  problem text := public.username_problem(p_name);
  base    text := left(regexp_replace(coalesce(p_name, ''), '[^A-Za-z0-9._-]', '', 'g'), 18);
  hint    text;
  cands   text[] := '{}';
  picks   text[] := '{}';
  c       text;
  i       int;
begin
  if problem is null then
    return jsonb_build_object('ok', true, 'reason', null, 'suggestions', '[]'::jsonb);
  end if;
  if problem = 'invalid' then
    return jsonb_build_object('ok', false, 'reason', problem, 'suggestions', '[]'::jsonb);
  end if;
  -- an initial from every other word of the hints: Mira + "Mira Kowalski" -> Mira.K
  foreach hint in array coalesce(p_hints, '{}') loop
    foreach c in array regexp_split_to_array(btrim(coalesce(hint, '')), '\s+') loop
      c := regexp_replace(c, '[^A-Za-z0-9]', '', 'g');
      if c <> '' and lower(c) <> lower(base) then cands := cands || (base || '.' || upper(left(c, 1))); end if;
    end loop;
  end loop;
  cands := cands || (lower(base) || '_plays') || (base || '2');
  for i in 3..9 loop cands := cands || (base || i::text); end loop;
  cands := cands || (base || '_music');
  foreach c in array cands loop
    exit when cardinality(picks) >= 3;
    if public.username_problem(c) is null and not (c = any (picks)) then picks := picks || c; end if;
  end loop;
  return jsonb_build_object('ok', false, 'reason', problem, 'suggestions', to_jsonb(picks));
end;
$$;

-- the name an account shows up with; null for anonymous users and accounts without a name yet
create or replace function public.has_account()
returns boolean
language sql stable security definer set search_path = public
as $$
  select auth.uid() is not null
     and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
     and exists (select 1 from profiles p where p.id = auth.uid() and p.username is not null);
$$;

-- the check at the top of every write function
create or replace function public.require_account()
returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.has_account() then
    raise exception 'You need an account for that. Sign up or sign in, then try again.';
  end if;
end;
$$;

-- after Google: pick your name, once
create or replace function public.pick_username(p_name text)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  problem text;
  current text;
begin
  if auth.uid() is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'Sign up or sign in first.';
  end if;
  select username into current from profiles where id = auth.uid() for update;
  if current is not null then raise exception 'You already have a name: %', current; end if;
  p_name := btrim(p_name);
  problem := public.username_problem(p_name);
  if problem = 'invalid' then raise exception 'Names are 3 to 24 letters, numbers, dots, dashes or underscores.'; end if;
  if problem = 'reserved' then raise exception '% is kept for Stakkato itself. Pick another name.', p_name; end if;
  if problem is not null then raise exception 'Someone already plays as %. Pick another name.', p_name; end if;
  insert into profiles (id, username) values (auth.uid(), p_name)
    on conflict (id) do update set username = excluded.username;
  return p_name;
end;
$$;

-- every new account (email or Google) gets a profile; anonymous users don't
create or replace function public.make_profile()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  name    text := nullif(btrim(new.raw_user_meta_data ->> 'username'), '');
  problem text;
begin
  if coalesce(new.is_anonymous, false) then return new; end if;
  if name is not null then
    problem := public.username_problem(name);
    if problem is not null then raise exception 'username_%', problem; end if;
  end if;
  insert into profiles (id, username) values (new.id, name) on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created_make_profile
  after insert on auth.users
  for each row execute function public.make_profile();

-- the names on takes, comments and versions come from the author's profile
create or replace function public.fill_author_name()
returns trigger
language plpgsql set search_path = public
as $$
declare
  name text;
begin
  select p.username into name from profiles p where p.id = new.author_id;
  if name is not null then
    if tg_table_name = 'versions' then new.by_name := name; else new.author_name := name; end if;
  end if;
  return new;
end;
$$;

create trigger takes_fill_author_name before insert on public.takes
  for each row execute function public.fill_author_name();
create trigger comments_fill_author_name before insert on public.comments
  for each row execute function public.fill_author_name();
create trigger thread_comments_fill_author_name before insert on public.thread_comments
  for each row execute function public.fill_author_name();
create trigger versions_fill_author_name before insert on public.versions
  for each row execute function public.fill_author_name();

-- ---------- admin ----------

-- fixes a name by hand, and the copies on that person's takes, comments and versions
create or replace function public.admin_rename(p_user uuid, p_name text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  problem text;
begin
  if not public.is_admin() then raise exception 'Only the admin can rename accounts'; end if;
  p_name := btrim(p_name);
  problem := public.username_problem(p_name, p_user);
  if problem = 'invalid' then raise exception 'Names are 3 to 24 letters, numbers, dots, dashes or underscores.'; end if;
  if problem = 'taken' then raise exception 'Someone already plays as %', p_name; end if;
  update profiles set username = p_name where id = p_user;
  if not found then raise exception 'That account has no profile'; end if;
  update takes set author_name = p_name where author_id = p_user;
  update comments set author_name = p_name where author_id = p_user;
  update thread_comments set author_name = p_name where author_id = p_user;
  update versions set by_name = p_name where author_id = p_user;
end;
$$;

create or replace function public.admin_accounts()
returns table (
  id uuid, username text, email text, signed_up_with text, providers text[],
  email_confirmed_at timestamptz, created_at timestamptz, last_sign_in_at timestamptz,
  jams int, takes int, house boolean
)
language plpgsql stable security definer set search_path = public, auth
as $$
begin
  if not public.is_admin() then raise exception 'Only the admin can list accounts'; end if;
  return query
  select u.id, p.username, u.email::text,
    (select i.provider from auth.identities i where i.user_id = u.id order by i.created_at limit 1),
    coalesce((select array_agg(distinct i.provider order by i.provider) from auth.identities i where i.user_id = u.id), '{}'),
    u.email_confirmed_at, u.created_at, u.last_sign_in_at,
    (select count(*)::int from sessions s where s.host_id = u.id and s.deleted_at is null),
    (select count(*)::int from public.takes t where t.author_id = u.id and t.status <> 'deleted' and t.role_id <> 'seed'),
    exists (select 1 from house_accounts h where h.user_id = u.id)
  from auth.users u
  left join profiles p on p.id = u.id
  where not coalesce(u.is_anonymous, false)
  order by u.created_at desc;
end;
$$;

revoke all on function public.reserved_username(text) from public;
revoke all on function public.username_problem(text, uuid) from public;
revoke all on function public.username_check(text, text[]) from public;
revoke all on function public.has_account() from public;
revoke all on function public.require_account() from public, anon;
revoke all on function public.pick_username(text) from public, anon;
revoke all on function public.make_profile() from public, anon, authenticated;
revoke all on function public.fill_author_name() from public, anon, authenticated;
revoke all on function public.admin_rename(uuid, text) from public, anon;
revoke all on function public.admin_accounts() from public, anon;
grant execute on function public.reserved_username(text) to anon, authenticated;
grant execute on function public.username_problem(text, uuid) to anon, authenticated;
grant execute on function public.username_check(text, text[]) to anon, authenticated;
grant execute on function public.has_account() to anon, authenticated;
grant execute on function public.require_account() to authenticated;
grant execute on function public.pick_username(text) to authenticated;
grant execute on function public.admin_rename(uuid, text) to authenticated;
grant execute on function public.admin_accounts() to authenticated;

-- the accounts that exist today keep the name in their user_metadata
-- ('admin' is reserved but already exists, so it's inserted here rather than picked)
insert into public.profiles (id, username)
select u.id, u.raw_user_meta_data ->> 'username'
from auth.users u
where not coalesce(u.is_anonymous, false)
  and u.raw_user_meta_data ->> 'username' ~ '^[A-Za-z0-9._-]{3,24}$'
on conflict (id) do nothing;

-- ---------- policies: every insert and update needs an account ----------

drop policy "create a session you host" on public.sessions;
create policy "create a session you host" on public.sessions
  for insert to authenticated
  with check (host_id = auth.uid() and status = 'open' and seed_take_id is null and public.has_account());

drop policy "host edits the session" on public.sessions;
create policy "host edits the session" on public.sessions
  for update to authenticated
  using (host_id = auth.uid() and public.has_account())
  with check (
    host_id = auth.uid() and public.has_account()
    and (seed_take_id is null or exists (
      select 1 from public.takes t
      where t.id = sessions.seed_take_id and t.session_id = sessions.id and t.role_id = 'seed'))
  );

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
      where p.id = takes.section_id and p.session_id = takes.session_id and p.role_id = 'part' and p.status = 'in'))
    and exists (
      select 1 from public.sessions s
      where s.id = takes.session_id and (
        (takes.role_id = 'seed' and takes.status = 'seed' and s.host_id = auth.uid() and s.status = 'open')
        or (takes.role_id not in ('seed', 'mix') and takes.status = 'waiting' and s.status = 'open')
        or (takes.role_id not in ('seed', 'mix', 'part') and takes.status = 'own' and takes.section_id is null)
        or (takes.role_id = 'mix' and takes.status = 'mix' and s.status = 'released')))
  );

drop policy "comment on an open session" on public.comments;
create policy "comment on an open session" on public.comments
  for insert to authenticated
  with check (
    author_id = auth.uid() and public.has_account() and hidden = false
    and exists (select 1 from public.sessions s where s.id = comments.session_id and s.status = 'open')
  );

drop policy "comment in a thread" on public.thread_comments;
create policy "comment in a thread" on public.thread_comments
  for insert to authenticated
  with check (
    author_id = auth.uid() and public.has_account() and hidden = false
    and (reply_to_take is null or exists (
      select 1 from public.takes t
      where t.id = thread_comments.reply_to_take and t.session_id = thread_comments.session_id))
    and (reply_to_comment is null or exists (
      select 1 from public.thread_comments c
      where c.id = thread_comments.reply_to_comment and c.session_id = thread_comments.session_id))
  );

drop policy "vote in a thread" on public.thread_votes;
create policy "vote in a thread" on public.thread_votes
  for insert to authenticated
  with check (voter_id = auth.uid() and public.has_account()
              and public.thread_vote_target_ok(target_kind, target_id, session_id));

drop policy "change your thread vote" on public.thread_votes;
create policy "change your thread vote" on public.thread_votes
  for update to authenticated
  using (voter_id = auth.uid() and public.has_account())
  with check (voter_id = auth.uid() and public.has_account()
              and public.thread_vote_target_ok(target_kind, target_id, session_id));

drop policy "cast a vote" on public.votes;
create policy "cast a vote" on public.votes
  for insert to authenticated
  with check (
    voter_id = auth.uid() and public.has_account() and public.can_vote(take_id, auth.uid())
    and session_id = (select t.session_id from public.takes t where t.id = votes.take_id)
  );

drop policy "change your vote" on public.votes;
create policy "change your vote" on public.votes
  for update to authenticated
  using (voter_id = auth.uid() and public.has_account())
  with check (
    voter_id = auth.uid() and public.has_account() and public.can_vote(take_id, auth.uid())
    and session_id = (select t.session_id from public.takes t where t.id = votes.take_id)
  );

drop policy "save a version" on public.versions;
create policy "save a version" on public.versions
  for insert to authenticated
  with check (author_id = auth.uid() and public.has_account());

drop policy "like a version" on public.version_likes;
create policy "like a version" on public.version_likes
  for insert to authenticated
  with check (
    user_id = auth.uid() and public.has_account()
    and session_id = (select v.session_id from public.versions v where v.id = version_likes.version_id)
  );

drop policy "react to a release" on public.reactions;
create policy "react to a release" on public.reactions
  for insert to authenticated
  with check (user_id = auth.uid() and public.has_account());

drop policy "like a stack" on public.stack_likes;
create policy "like a stack" on public.stack_likes
  for insert to authenticated
  with check (
    user_id = auth.uid() and public.has_account()
    and exists (select 1 from public.sessions s where s.id = stack_likes.session_id)
  );

drop policy "upload audio to your own folder" on storage.objects;
create policy "upload audio to your own folder" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'takes' and public.has_account()
    and (storage.foldername(name))[2] = auth.uid()::text
    and exists (select 1 from public.sessions s where s.id::text = (storage.foldername(objects.name))[1])
  );

drop policy "delete the audio of a deleted take" on storage.objects;
create policy "delete the audio of a deleted take" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'takes' and public.has_account()
    and ((storage.foldername(name))[2] = auth.uid()::text or public.is_admin())
    and exists (select 1 from public.takes t where t.storage_path = objects.name and t.status = 'deleted')
  );

-- ---------- write functions: the same check at the top ----------
-- (bodies unchanged apart from `perform public.require_account();`)

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

create or replace function public.veto(p_take uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  t takes;
  s sessions;
begin
  perform public.require_account();
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

create or replace function public.drop_part(p_take uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  t takes;
  s sessions;
begin
  perform public.require_account();
  select * into t from takes where id = p_take for update;
  if not found then raise exception 'Take not found'; end if;

  select * into s from sessions where id = t.session_id;
  if s.host_id is distinct from auth.uid() then raise exception 'Only the creator can change the song'; end if;
  if s.status <> 'open' then raise exception 'The session is closed'; end if;
  if t.role_id <> 'part' or t.status <> 'in' then raise exception 'That is not a part in the song'; end if;

  update takes set status = 'archived', archive_reason = 'passed', joined_at = null where id = p_take;
end;
$$;

create or replace function public.set_fades(p_take uuid, p_in real, p_out real, p_xfade real)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  t takes;
  s sessions;
begin
  perform public.require_account();
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

create or replace function public.set_amp(p_take uuid, p_amp text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  t takes;
  s sessions;
begin
  perform public.require_account();
  if p_amp is not null and p_amp not in ('clean', 'crunch', 'metal') then
    raise exception 'Unknown amp';
  end if;

  select * into t from takes where id = p_take for update;
  if not found then raise exception 'Take not found'; end if;
  if t.status = 'deleted' then raise exception 'That take was deleted'; end if;
  if t.role_id = 'mix' then raise exception 'A mix plays as it is'; end if;

  select * into s from sessions where id = t.session_id;
  if not (
    (s.host_id = auth.uid() and s.status = 'open')
    or (t.author_id = auth.uid() and t.status in ('waiting', 'own'))
  ) then
    raise exception 'Only the creator can change the amp on this take';
  end if;

  update takes set amp = p_amp where id = p_take;
end;
$$;

create or replace function public.take_out_layer(p_take uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  t takes;
  s sessions;
begin
  perform public.require_account();
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

create or replace function public.send_own_take(p_take uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  t takes;
  s sessions;
begin
  perform public.require_account();
  select * into t from takes where id = p_take for update;
  if not found then raise exception 'Take not found'; end if;
  if t.author_id is distinct from auth.uid() then raise exception 'Only the person who recorded this take can send it in'; end if;
  if t.status <> 'own' then raise exception 'That take is already with the creator'; end if;

  select * into s from sessions where id = t.session_id;
  if s.status <> 'open' then raise exception 'The session is closed'; end if;

  update takes set status = 'waiting' where id = p_take;
end;
$$;

create or replace function public.delete_take(p_take uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  t takes;
  s sessions;
begin
  perform public.require_account();
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

create or replace function public.delete_jam(p_session uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  s sessions;
begin
  perform public.require_account();
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
  perform public.require_account();
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
  perform public.require_account();
  select * into c from thread_comments where id = p_comment for update;
  if not found then raise exception 'Comment not found'; end if;
  if c.author_id is distinct from auth.uid() and not is_admin() then
    raise exception 'You can only delete your own comments';
  end if;
  update thread_comments set deleted_at = coalesce(deleted_at, now()), body = '' where id = p_comment;
end;
$$;

create or replace function public.hide_comment(p_comment uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  c comments;
  s sessions;
begin
  perform public.require_account();
  select * into c from comments where id = p_comment for update;
  if not found then raise exception 'Comment not found'; end if;
  select * into s from sessions where id = c.session_id;
  if s.host_id is distinct from auth.uid() then raise exception 'Only the creator can hide comments'; end if;
  update comments set hidden = true where id = p_comment;
end;
$$;

create or replace function public.hide_thread_comment(p_comment uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  c thread_comments;
begin
  perform public.require_account();
  select * into c from thread_comments where id = p_comment for update;
  if not found then raise exception 'Comment not found'; end if;
  if not exists (select 1 from sessions s where s.id = c.session_id and s.host_id = auth.uid()) then
    raise exception 'Only the creator can hide comments';
  end if;
  update thread_comments set hidden = true where id = p_comment;
end;
$$;

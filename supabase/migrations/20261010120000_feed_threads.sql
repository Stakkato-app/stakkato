-- Threads on the homepage feed.
--
-- Every jam (a session with an original track) is a thread. Audio replies are takes,
-- written-only replies are comments, and anyone can up- or downvote the jam, a take or a
-- comment. Everything here is additive: existing pages don't read any of it.
--
-- * takes.reply_to: the take this one was played on top of (null = on the original track,
--   or on the new part in section_id). The feed plays a take with every take above it.
-- * thread_comments: a reply without audio, on the jam itself, on a take, or on another
--   comment. Readable by everyone; anyone signed in (also anonymously) can post. Nothing
--   is deleted; the creator can hide one with hide_thread_comment().
-- * thread_votes: one row per person per thing, value -1, 0 (taken back) or 1. Upserted,
--   never deleted (see "Nothing is deleted" in CLAUDE.md).

alter table public.takes add column reply_to uuid references public.takes (id);
create index takes_reply_to_idx on public.takes (reply_to);

-- A take can only reply to a take in the same session. A trigger instead of a change to
-- the "send a take" policy, so policy changes in other branches don't collide with this.
create or replace function public.check_take_reply_to()
returns trigger
language plpgsql set search_path = public
as $$
begin
  if new.reply_to is not null and not exists (
    select 1 from takes p where p.id = new.reply_to and p.session_id = new.session_id
  ) then
    raise exception 'A reply has to be on a take in the same session';
  end if;
  return new;
end;
$$;

create trigger takes_reply_to_same_session
  before insert or update of reply_to on public.takes
  for each row execute function public.check_take_reply_to();

create table public.thread_comments (
  id               uuid primary key default gen_random_uuid(),
  session_id       uuid not null references public.sessions (id) on delete cascade,
  reply_to_take    uuid references public.takes (id),
  reply_to_comment uuid references public.thread_comments (id),
  author_id        uuid not null references auth.users (id) on delete cascade,
  author_name      text not null check (char_length(author_name) between 1 and 60),
  body             text not null check (char_length(body) between 1 and 500),
  hidden           boolean not null default false,
  created_at       timestamptz not null default now(),
  check (reply_to_take is null or reply_to_comment is null)
);

create index thread_comments_session_idx on public.thread_comments (session_id);

alter table public.thread_comments enable row level security;

create policy "thread comments are readable" on public.thread_comments
  for select to anon, authenticated using (true);

create policy "comment in a thread" on public.thread_comments
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and hidden = false
    and (reply_to_take is null or exists (
      select 1 from public.takes t where t.id = reply_to_take and t.session_id = thread_comments.session_id))
    and (reply_to_comment is null or exists (
      select 1 from public.thread_comments c where c.id = reply_to_comment and c.session_id = thread_comments.session_id))
  );

create or replace function public.hide_thread_comment(p_comment uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  c thread_comments;
begin
  select * into c from thread_comments where id = p_comment for update;
  if not found then raise exception 'Comment not found'; end if;
  if not exists (select 1 from sessions s where s.id = c.session_id and s.host_id = auth.uid()) then
    raise exception 'Only the creator can hide comments';
  end if;
  update thread_comments set hidden = true where id = p_comment;
end;
$$;

revoke all on function public.hide_thread_comment(uuid) from public, anon;
grant execute on function public.hide_thread_comment(uuid) to authenticated;

create table public.thread_votes (
  target_id   uuid not null,
  voter_id    uuid not null references auth.users (id) on delete cascade,
  session_id  uuid not null references public.sessions (id) on delete cascade,
  target_kind text not null check (target_kind in ('session', 'take', 'comment')),
  value       smallint not null check (value in (-1, 0, 1)),
  updated_at  timestamptz not null default now(),
  primary key (target_id, voter_id)
);

create index thread_votes_session_idx on public.thread_votes (session_id);

alter table public.thread_votes enable row level security;

create policy "thread votes are readable" on public.thread_votes
  for select to anon, authenticated using (true);

-- The thing voted on has to exist in the session the vote names.
create or replace function public.thread_vote_target_ok(p_kind text, p_target uuid, p_session uuid)
returns boolean
language sql stable set search_path = public
as $$
  select case p_kind
    when 'session' then p_target = p_session
    when 'take'    then exists (select 1 from takes t where t.id = p_target and t.session_id = p_session)
    when 'comment' then exists (select 1 from thread_comments c where c.id = p_target and c.session_id = p_session)
    else false
  end;
$$;

create policy "vote in a thread" on public.thread_votes
  for insert to authenticated
  with check (voter_id = auth.uid() and public.thread_vote_target_ok(target_kind, target_id, session_id));

create policy "change your thread vote" on public.thread_votes
  for update to authenticated
  using (voter_id = auth.uid())
  with check (voter_id = auth.uid() and public.thread_vote_target_ok(target_kind, target_id, session_id));

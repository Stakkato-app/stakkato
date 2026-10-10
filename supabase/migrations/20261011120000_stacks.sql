-- What the song view from the Stackato concept needs on top of own takes and comments.
--
-- * takes.on_takes: the takes that were playing when this take was recorded (the stack it
--   was played on). The song view builds its thread of stacks from it. The original track
--   is implied and left out.
-- * takes.group_id: takes sent together as one reply (up to four instruments in one go).
-- * takes.reply_to (from feed_threads) is filled in from on_takes when it isn't given: the
--   newest take of the stack, so the homepage thread and the song view agree.
-- * stack_likes: one row per person per stack they like; stack_key is the stack's take
--   ids, sorted and joined with commas. Never deleted, like version_likes.

alter table public.takes add column on_takes uuid[];
alter table public.takes add column group_id uuid;

-- fires before takes_reply_to_same_session (triggers run in name order), which checks it
create or replace function public.fill_take_reply_to()
returns trigger
language plpgsql set search_path = public
as $$
begin
  if new.reply_to is null and coalesce(array_length(new.on_takes, 1), 0) > 0 then
    select t.id into new.reply_to
    from takes t
    where t.id = any (new.on_takes) and t.session_id = new.session_id and t.role_id not in ('seed', 'part', 'mix')
    order by t.created_at desc
    limit 1;
  end if;
  return new;
end;
$$;

create trigger takes_fill_reply_to
  before insert on public.takes
  for each row execute function public.fill_take_reply_to();

create table public.stack_likes (
  session_id uuid not null references public.sessions (id) on delete cascade,
  stack_key  text not null check (char_length(stack_key) between 1 and 4000),
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (session_id, stack_key, user_id)
);

alter table public.stack_likes enable row level security;

create policy "stack likes are readable" on public.stack_likes
  for select to anon, authenticated using (true);

create policy "like a stack" on public.stack_likes
  for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.sessions s where s.id = stack_likes.session_id));

alter publication supabase_realtime add table public.stack_likes;

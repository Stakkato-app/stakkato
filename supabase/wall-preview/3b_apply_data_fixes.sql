-- Wall preview, step 3b (optional): the three jam fixes the preview does in the browser, done once
-- in the database instead. Only after step 2. Paste it in the SQL editor.
--
-- 1. "Kilian's krentenbolleke" and the Jurgocals track: the takes were sent on the original track
--    (some together as one reply), but each was meant to go on the one before it. They become one
--    stack in band order (drums, bass, guitar, keys, atmosphere, lead, vocals, wildcard; the same
--    layer in the order it came in). Each take gets its own reply, not a group.
-- 2. "drum regeton": the new part before the original track was a mistake. It is marked deleted,
--    with what was played on it (nothing is really deleted; the app just leaves it out).
--
-- Everything it changes is copied to public.wall_fix_backup first, so it can be undone (see the end).
-- Run 3a_preview_data_fixes.sql first and check its list. This one runs in one transaction:
-- if any statement fails, nothing is changed.

begin;

-- the three jams
create temp table fix_jams on commit drop as
select s.id, coalesce(nullif(s.title, 'Untitled'), seed.author_name || '’s track') as title,
  case when coalesce(s.title, '') ilike '%regeton%' then 'drop_part' else 'restack' end as fix
from public.sessions s
left join public.takes seed on seed.id = s.seed_take_id
where s.deleted_at is null and (
  coalesce(s.title, '') ilike '%krentenbol%'
  or coalesce(s.title, '') ilike '%jurgocal%'
  or (coalesce(s.title, 'Untitled') = 'Untitled' and seed.author_name ilike 'jurgocal%')
  or coalesce(s.title, '') ilike '%drum regeton%');

-- a backup of every row it will change
create table if not exists public.wall_fix_backup (
  take_id uuid primary key, session_id uuid, status text, reply_to uuid, on_takes uuid[], group_id uuid,
  saved_at timestamptz default now());
alter table public.wall_fix_backup enable row level security;   -- no policies: not readable from the app

-- 1. restack: the takes on the original track, in band order
create temp table fix_order on commit drop as
select t.id, t.session_id,
  row_number() over (partition by t.session_id order by
    array_position(array['drums','bass','guitar','keys','atmos','lead','vocals','wild'], t.role_id) nulls last,
    t.created_at) as n
from public.takes t
join fix_jams j on j.id = t.session_id and j.fix = 'restack'
join public.sessions s on s.id = t.session_id
where t.section_id is null and t.role_id not in ('seed', 'part', 'mix')
  and t.status in ('waiting', 'in', 'archived') and t.id is distinct from s.seed_take_id;

insert into public.wall_fix_backup (take_id, session_id, status, reply_to, on_takes, group_id)
select t.id, t.session_id, t.status, t.reply_to, t.on_takes, t.group_id
from public.takes t join fix_order o on o.id = t.id
on conflict (take_id) do nothing;

update public.takes t set
  group_id = null,
  reply_to = (select p.id from fix_order p where p.session_id = o.session_id and p.n = o.n - 1),
  on_takes = (select array_agg(p.id order by p.n) from fix_order p where p.session_id = o.session_id and p.n < o.n)
from fix_order o where o.id = t.id;

-- 2. drum regeton: the part before the original track, its layers and what was played on them
create temp table fix_gone on commit drop as
with recursive gone(id) as (
  select t.id from public.takes t join fix_jams j on j.id = t.session_id and j.fix = 'drop_part'
  where t.role_id = 'part' and t.part_pos = 'before' and t.status in ('waiting', 'in')
  union
  select t.id from public.takes t join gone g on t.section_id = g.id or t.reply_to = g.id
  where t.status <> 'deleted'
)
select id from gone;

insert into public.wall_fix_backup (take_id, session_id, status, reply_to, on_takes, group_id)
select t.id, t.session_id, t.status, t.reply_to, t.on_takes, t.group_id
from public.takes t join fix_gone g on g.id = t.id
on conflict (take_id) do nothing;

update public.takes t set status = 'deleted' from fix_gone g where g.id = t.id;

commit;

-- To undo later:
-- update public.takes t set status = b.status, reply_to = b.reply_to, on_takes = b.on_takes, group_id = b.group_id
--   from public.wall_fix_backup b where b.take_id = t.id;

-- Wall preview, step 3a: what the jam fixes would change. Read-only (it rolls back).
-- Paste it in the SQL editor and run it; check the list before running 3b_apply_data_fixes.sql.
-- Expected: the takes of "Kilian's krentenbolleke" and the Jurgocals track in band order (each one
-- plays on all the rows above it), and for "drum regeton" the new part before the original track
-- with what was played on it ("will be deleted").
-- The SQL editor only shows the result of the last statement, so this file ends with one list.

begin;
create temp table fix_jams as
select s.id, coalesce(nullif(s.title, 'Untitled'), seed.author_name || '’s track') as title,
  case when coalesce(s.title, '') ilike '%regeton%' then 'drop_part' else 'restack' end as fix
from public.sessions s
left join public.takes seed on seed.id = s.seed_take_id
where s.deleted_at is null and (
  coalesce(s.title, '') ilike '%krentenbol%'
  or coalesce(s.title, '') ilike '%jurgocal%'
  or (coalesce(s.title, 'Untitled') = 'Untitled' and seed.author_name ilike 'jurgocal%')
  or coalesce(s.title, '') ilike '%drum regeton%');

create temp table fix_order as
select t.id, t.session_id,
  row_number() over (partition by t.session_id order by
    array_position(array['drums','bass','guitar','keys','atmos','lead','vocals','wild'], t.role_id) nulls last,
    t.created_at) as n
from public.takes t
join fix_jams j on j.id = t.session_id and j.fix = 'restack'
join public.sessions s on s.id = t.session_id
where t.section_id is null and t.role_id not in ('seed', 'part', 'mix')
  and t.status in ('waiting', 'in', 'archived') and t.id is distinct from s.seed_take_id;

create temp table fix_gone as
with recursive gone(id) as (
  select t.id from public.takes t join fix_jams j on j.id = t.session_id and j.fix = 'drop_part'
  where t.role_id = 'part' and t.part_pos = 'before' and t.status in ('waiting', 'in')
  union
  select t.id from public.takes t join gone g on t.section_id = g.id or t.reply_to = g.id
  where t.status <> 'deleted'
)
select id from gone;


select j.title as jam, 'restack #' || o.n as change, t.role_id as layer, t.author_name as by, t.status, t.created_at
from fix_order o join public.takes t on t.id = o.id join fix_jams j on j.id = o.session_id
union all
select j.title, 'will be deleted', t.role_id, t.author_name, t.status, t.created_at
from fix_gone g join public.takes t on t.id = g.id join fix_jams j on j.id = t.session_id
order by 1, 2, 6;

rollback;

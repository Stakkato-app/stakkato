-- Wall preview, step 1: what the live database still needs.
-- Read-only: only selects. Paste it in the Supabase SQL editor (project Stakkato) and run it.
-- Every row should say "ok". A row that says "MISSING" names the migration to paste (step 2).

select 'takes.carry column' as what,
  case when exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'takes' and column_name = 'carry')
  then 'ok' else 'MISSING: 20261018230000_carry_into_parts.sql' end as status
union all
select 'carry check trigger',
  case when exists (select 1 from pg_trigger where tgname = 'takes_carry_check' and not tgisinternal)
  then 'ok' else 'MISSING: 20261018230000_carry_into_parts.sql' end
union all
select 'layers on a waiting new part ("send a take" policy)',
  case when exists (select 1 from pg_policies
    where schemaname = 'public' and tablename = 'takes' and policyname = 'send a take'
      and with_check like '%waiting%' and with_check like '%section_id%')
  then 'ok' else 'MISSING: 20261019230000_parts_as_replies.sql' end
union all
select 'let_in() brings a part in with its layer',
  case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'let_in' and p.prosrc like '%brings that part into the song%')
  then 'ok' else 'MISSING: 20261019230000_parts_as_replies.sql' end
union all
-- the earlier ones the app already relies on (they should be there; this only double-checks)
select 'stacks (takes.on_takes)',
  case when exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'takes' and column_name = 'on_takes')
  then 'ok' else 'MISSING: 20261011120000_stacks.sql' end
union all
select 'amps (takes.amp)',
  case when exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'takes' and column_name = 'amp')
  then 'ok' else 'MISSING: 20261012090000_take_amps.sql' end
union all
select 'live thread updates (thread_comments in realtime)',
  case when exists (select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'thread_comments')
  then 'ok' else 'MISSING: 20261012180000_thread_realtime.sql' end;

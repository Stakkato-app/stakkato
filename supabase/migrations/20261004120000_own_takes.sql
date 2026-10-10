-- Own takes: anything you record or upload while building your own version.
--
-- An own take (status 'own') is a layer on the original track that only exists for your
-- versions: it never waits for the creator and never enters the project. It is readable
-- like every take, because a saved version that uses it has to play for everyone.
-- Its author can send it to the creator later with send_own_take(), which turns it into
-- an ordinary waiting take (the creator then lets it in or vetoes it). Own takes can be
-- added in open and closed sessions alike, since versions can be built after release too.

alter table public.takes drop constraint takes_status_check;
alter table public.takes add constraint takes_status_check
  check (status in ('seed', 'waiting', 'in', 'archived', 'mix', 'deleted', 'own'));

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
          or (takes.role_id not in ('seed', 'mix', 'part') and takes.status = 'own' and takes.section_id is null)
          or (takes.role_id = 'mix' and takes.status = 'mix' and s.status = 'released')
        )
    )
  );

-- The author of an own take sends it to the creator: it becomes a waiting take.
create or replace function public.send_own_take(p_take uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  t takes;
  s sessions;
begin
  select * into t from takes where id = p_take for update;
  if not found then raise exception 'Take not found'; end if;
  if t.author_id is distinct from auth.uid() then raise exception 'Only the person who recorded this take can send it in'; end if;
  if t.status <> 'own' then raise exception 'That take is already with the creator'; end if;

  select * into s from sessions where id = t.session_id;
  if s.status <> 'open' then raise exception 'The session is closed'; end if;

  update takes set status = 'waiting' where id = p_take;
end;
$$;

revoke all on function public.send_own_take(uuid) from public, anon;
grant execute on function public.send_own_take(uuid) to authenticated;

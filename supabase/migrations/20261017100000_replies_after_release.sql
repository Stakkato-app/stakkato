-- Replies after release: a song that is released ("Became a song") keeps its thread open.
--
-- Anyone can still play on the original track or on any take and post that as a reply
-- (a waiting layer take). The song itself is final: let_in() still refuses once the session
-- is released, so these takes stay in the thread and in versions, never in the stack.
-- New parts stay refused after release, since they would make the song longer.
-- Written replies were already allowed after release.

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
          -- a released song keeps its thread: a layer can still be a reply (not a new part,
          -- the song's length is final); nobody can add it to the song any more
          or (takes.role_id not in ('seed', 'mix', 'part') and takes.status = 'waiting' and s.status = 'released')
          or (takes.role_id not in ('seed', 'mix', 'part') and takes.status = 'own' and takes.section_id is null)
          or (takes.role_id = 'mix' and takes.status = 'mix' and s.status = 'released')
        )
    )
  );

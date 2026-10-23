-- A take's amp render, stored. A take with an amp (takes.amp) used to play by downloading its dry
-- original and running the amp in every listener's browser (a NAM capture, roughly 0.1 to 0.6x
-- real time), silent until that was done. Now the first browser that renders it, if it belongs
-- to the take's author, the creator or the admin, encodes the render like a play copy (Ogg Opus,
-- 48 kHz, src/playcopy.js) and stores it; everyone else downloads that and plays it right away.
--
-- One row per take and amp, so a take whose amp is switched keeps the render of the amp it had:
-- switching back plays the stored one again. The dry original (storage_path) stays the source
-- for every new render and for stem downloads.
--
-- The file sits in the folder of whoever made it: {session_id}/{user_id}/{take_id}.{amp}.ogg
-- (the upload policy already allows that path and audio/ogg). Rows are never updated or deleted
-- by the app; a second render of the same take and amp is refused by the primary key.

create table if not exists public.take_renders (
  take_id    uuid not null references public.takes(id) on delete cascade,
  amp        text not null check (amp in ('clean', 'crunch', 'metal')),
  session_id uuid not null references public.sessions(id) on delete cascade,
  path       text not null check (length(path) <= 512),
  made_by    uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (take_id, amp)
);
create index if not exists take_renders_session on public.take_renders (session_id);

alter table public.take_renders enable row level security;

drop policy if exists "anyone reads renders" on public.take_renders;
create policy "anyone reads renders" on public.take_renders
  for select to anon, authenticated using (true);

drop policy if exists "store a render" on public.take_renders;
create policy "store a render" on public.take_renders
  for insert to authenticated
  with check (
    public.has_account()
    and made_by = auth.uid()
    and split_part(path, '/', 1) = session_id::text
    and split_part(path, '/', 2) = auth.uid()::text
    and split_part(path, '/', 3) = take_id::text || '.' || amp || '.ogg'
    and exists (
      select 1 from public.takes t join public.sessions s on s.id = t.session_id
      where t.id = take_renders.take_id and t.session_id = take_renders.session_id
        and t.status <> 'deleted'
        and (t.author_id = auth.uid() or s.host_id = auth.uid() or public.is_admin())
    )
  );

grant select on public.take_renders to anon, authenticated;
grant insert on public.take_renders to authenticated;

-- Deleting the audio of a deleted take now also allows its renders.
drop policy if exists "delete the audio of a deleted take" on storage.objects;
create policy "delete the audio of a deleted take" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'takes' and public.has_account()
    and ((storage.foldername(name))[2] = auth.uid()::text or public.is_admin())
    and (
      exists (select 1 from public.takes t
              where (t.storage_path = objects.name or t.play_path = objects.name) and t.status = 'deleted')
      or exists (select 1 from public.take_renders r join public.takes t on t.id = r.take_id
                 where r.path = objects.name and t.status = 'deleted')
    )
  );

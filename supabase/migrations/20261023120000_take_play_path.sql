-- A take's compressed copy, for playback. Everything that plays a take (the homepage, the
-- project, profiles, the release view) downloads play_path when it is set and storage_path
-- otherwise; stem downloads always use storage_path, the file as it was sent.
--
-- The copy is Ogg Opus (160 kbps stereo, 96 kbps mono, 48 kHz), next to the original in the
-- same folder: {session_id}/{user_id}/{uuid}.ogg. The browser makes it while the take uploads
-- (src/playcopy.js); scripts/make-play-copies.mjs makes it for older takes. Null = no copy (the
-- upload was already compressed, the copy wouldn't have been smaller, or encoding failed).
--
-- The insert policy ("send a take") doesn't mention the column, so a take may carry it. The
-- check keeps it in the take's own folder, so a take can't point at someone else's file. The
-- bucket already takes audio/* (audio/ogg) and the upload policy already allows the path.
--
-- Deleting the audio of a deleted take now also allows its copy.

alter table public.takes add column if not exists play_path text
  constraint takes_play_path_folder check (
    play_path is null or (
      length(play_path) <= 512
      and split_part(play_path, '/', 1) = split_part(storage_path, '/', 1)
      and split_part(play_path, '/', 2) = split_part(storage_path, '/', 2)
    )
  );

drop policy if exists "delete the audio of a deleted take" on storage.objects;
create policy "delete the audio of a deleted take" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'takes' and public.has_account()
    and ((storage.foldername(name))[2] = auth.uid()::text or public.is_admin())
    and exists (select 1 from public.takes t
                where (t.storage_path = objects.name or t.play_path = objects.name) and t.status = 'deleted')
  );

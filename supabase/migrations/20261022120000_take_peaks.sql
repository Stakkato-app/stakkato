-- A take's waveform, saved with the take, so the homepage (and later other pages) can draw
-- it without downloading the audio.
--
-- peaks is base64 of 8-bit min/max pairs (src/peaks.js): 1000 columns, each the highest and
-- the lowest sample, scaled to the take's own loudest sample. That is 2000 bytes, 2668
-- characters of base64. The browser computes it from the decoded audio when it inserts the
-- take; scripts/backfill-peaks.mjs fills it for older takes. Null = not computed (pages then
-- load the audio and draw from that, as before).
--
-- The insert policy ("send a take") doesn't mention the column, so a take may carry it. There
-- is no UPDATE policy on takes, so after the insert only the service role can change it. The
-- length check keeps someone from bloating every snapshot with a huge string.

alter table public.takes add column if not exists peaks text
  constraint takes_peaks_size check (peaks is null or length(peaks) <= 4096);

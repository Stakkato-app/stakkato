-- Amp sims: a take (usually a dry DI guitar) can play through one of the app's amps.
-- The audio stays dry in Storage; the amp is applied in the browser on playback, so it can
-- be changed or switched off any time.
--
-- * takes.amp: null = off, or 'clean' | 'crunch' | 'metal' (src/amp.js has the presets).
--   Set on insert by whoever sends the take (the "send a take" policy covers it).
-- * set_amp(): the creator changes it while the session is open, or the take's author while
--   the take waits for the creator or is their own. Everyone hears the change.
-- Versions keep their own amp choice in versions.ctl (per take id, key "amp"), no change needed.

alter table public.takes add column amp text
  check (amp in ('clean', 'crunch', 'metal'));

create or replace function public.set_amp(p_take uuid, p_amp text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  t takes;
  s sessions;
begin
  if p_amp is not null and p_amp not in ('clean', 'crunch', 'metal') then
    raise exception 'Unknown amp';
  end if;

  select * into t from takes where id = p_take for update;
  if not found then raise exception 'Take not found'; end if;
  if t.status = 'deleted' then raise exception 'That take was deleted'; end if;
  if t.role_id = 'mix' then raise exception 'A mix plays as it is'; end if;

  select * into s from sessions where id = t.session_id;
  if not (
    (s.host_id = auth.uid() and s.status = 'open')
    or (t.author_id = auth.uid() and t.status in ('waiting', 'own'))
  ) then
    raise exception 'Only the creator can change the amp on this take';
  end if;

  update takes set amp = p_amp where id = p_take;
end;
$$;

revoke all on function public.set_amp(uuid, text) from public, anon;
grant execute on function public.set_amp(uuid, text) to authenticated;

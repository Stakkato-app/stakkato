# CLAUDE.md

Context for Claude Code (and humans) working in this repo.

## What this is

Riffraff is a collaborative jam: a host drops a **seed** track (a riff, groove or vocal), anyone with the session link sends **takes** (one instrument each, exactly the seed's length), the host lets takes into the **line-up** or vetoes them, and people already in the line-up vote to steer the host. Anyone can build and save their own **version** from every take, including vetoed ones. The host eventually **closes** the session, which releases it; after that anyone can attach a mixed version.

It started life as a single-file Claude artifact (an in-memory prototype with a fake "let the line-up vote" button). This repo is the hosted version: same UI and audio engine, real persistence, real multi-user sessions.

## Stack

- **Frontend:** plain JavaScript (ES modules, no framework), bundled by **Vite**. The UI renders HTML strings into containers; there is no virtual DOM.
- **Backend:** **Supabase** (Postgres + Row Level Security, Storage for audio, Realtime for live updates, Auth with anonymous sign-ins). There is no server code of our own.
- **Hosting:** **Vercel**, static build from `dist/`. `vercel.json` rewrites `/s/:slug` to `index.html` and `/songs` to `songs.html` (the list of all songs, a second Vite entry; `vite.config.js` does the same rewrite for dev and preview).
- **Audio:** Web Audio API in the browser: decoding, mixing, waveform peaks, tempo/key detection (`src/analysis.js`). Nothing audio-related runs on a server.

## Commands

```bash
npm install
npm run dev       # http://localhost:5173, needs .env.local (see .env.example)
npm run build     # outputs dist/
npm run preview   # serve the build locally
```

Apply database changes with the Supabase CLI (`npx supabase db push`) or by pasting a migration into the Supabase SQL editor. See README.md for first-time setup.

## Layout

```
index.html                  page markup (static shell; most content is rendered by app.js)
songs.html, src/songs.js    the /songs page: every session with an original track, linking to /s/<slug>
src/app.js                  the whole UI: state, rendering, audio engine, event handlers
src/data.js                 every Supabase call; app.js never uses the client directly
src/supabase.js             client setup from env vars
src/analysis.js             tempo + key detection (unchanged from the prototype)
src/roles.js                instrument roles, colours, icons (mirror of the roles table)
src/icons.js, src/zip.js    inline SVG icons; store-only zip writer for stem downloads
src/styles.css              all styles (dark theme tokens on :root)
supabase/migrations/        schema, RLS policies, RPC functions, storage bucket, realtime
```

## Data model (Postgres, `public` schema)

- `sessions`: one per song. `host_id` is the user who created it (and dropped the seed). `status` is `open` or `released`. Tempo/key/time live here (`bpm`, `music_key`, `key_alt`, `time_sig`, `meta_from`, `meta_sure`). `seed_role` is the instrument the host says the seed is (null = not one instrument). Every instrument has open slots (`roles.slots` is null = unlimited; `role_cap()`/`section_cap()` pass the null through), so nobody is ever pushed out by a new take -- it stops only when the creator decides. The seed's own instrument still notionally takes one slot in that role (`role_cap()` subtracts it when the role is finite), and `seed_role_claims_slot()` bumps the oldest takes if a *finite* role overflows; that trigger is a no-op for the unlimited roles in place today, and is refused once the session is closed. `seed_take_id` points at the current seed; replaced seeds stay in `takes` but are ignored.
- `takes`: every piece of audio. `role_id` is `seed`, `mix`, `part` or an instrument id. `status` is `seed | waiting | in | archived | mix | deleted | own`. `joined_at` orders the line-up (the oldest take in a full role is the one that gets pushed out). Audio lives in Storage at `storage_path`. `fade_in` / `fade_out` (seconds) and `xfade` (parts only) are set by the host through `set_fades()` and heard by everyone.
- New parts: a take with `role_id = 'part'` and `part_pos` `before | after` is a piece of any length that makes the song longer. Pitched = `waiting`, kept = `in`, passed or dropped = `archived` with reason `passed`. Layers can sit on a kept part: `section_id` is that part's id (null = the seed). Slots count per section (`section_cap()`): the seed and each kept part have their own line-up, and the seed's instrument only takes a slot on the seed.
- Own takes: a take with status `own` was recorded or uploaded for someone's own version. It never waits for the creator and never enters the project; only its author sees it in the version builder (other clients load it only when a version uses it). Its author can send it to the creator with `send_own_take()`, which turns it into an ordinary `waiting` take. Own takes are layers on the original track only (no `section_id`), and can be added after the session is closed too.
- `comments`: SoundCloud-style comments on the timeline. `at_sec` counts from the start of the original track (negative = on a part before it), so a comment stays on the same music when parts are added. Readable by everyone; anyone signed in can comment while the session is open; the host hides one with `hide_comment()` (`hidden = true`, never deleted). The app loads them with the snapshot and listens on a separate realtime channel, and works without them if their migration isn't applied.
- `votes`: `(take_id, voter_id)` → `up | down`. Only people with a take in the line-up can vote, and not on the take that would replace their own. **The voting UI is switched off** (the creator decides alone); the table, `can_vote()` and the vote handlers in app.js stay, unused.
- `versions`: a fan version is just `picks` (take ids) plus `ctl` (per-take vol/mute/solo and `hp`/`lp` filter cutoffs in Hz, keyed by take id, with the seed under the key `"seed"`). No audio is copied.
- `version_likes`, `reactions`: one row per person, never deleted.
- `roles`: slot counts per instrument. **Authoritative for slots.**

Storage bucket `takes` is public-read. Upload path: `{session_id}/{user_id}/{uuid}.{ext}`, 50 MB per file, `audio/*` only.

## Rules that are easy to break

- **Permissions live in the database.** RLS policies and the `let_in()` / `veto()` / `can_vote()` functions enforce who can do what. The UI hides buttons for convenience, but never rely on UI checks for security. If you add a write, add a policy.
- **Host-only status changes go through RPCs.** There is deliberately no UPDATE policy on `takes`. Letting in, vetoing and bumping happen in `let_in()` / `veto()` so slot rules are atomic; parts are dropped with `drop_part()`, fades set with `set_fades()`, takes deleted with `delete_take()`. The host takes a layer back out of the project with `take_out_layer()` (in → archived, reason `removed`; still usable in versions). The one status change that isn't the host's is `send_own_take()` (own → waiting, by the take's author).
- **Nothing is deleted.** Realtime `postgres_changes` can't filter DELETE events by column, so the app avoids deletes entirely (votes are upserted, likes and reactions are permanent). "Deleting" a take sets its status to `deleted` (a part takes its layers with it); the app filters those out. If you add real deletes, the subscription in `data.js` needs rethinking.
- **Realtime is a "something changed" signal.** Every event triggers a debounced full refetch (`refresh()` in app.js). Don't apply event payloads incrementally unless there's a measured reason to.
- **The current seed is addressed as `'seed'` in the UI.** `applySnapshot()` renames the current seed's take object id to `'seed'`; everything else uses its database id (`dbId` always holds the real id). Mixer settings in versions rely on this.
- **Roles are defined twice.** `src/roles.js` (labels, colours, icons, slots for display) and the `roles` table + the `role_id` check constraint on `takes` in the migration. Change them together, in a new migration.
- **`TAKES` is a cache keyed by database id.** Take objects are updated in place on refresh so decoded audio, peaks and line-up mixer settings survive. Don't rebuild them from scratch.
- **Re-rendering must not eat user input.** Realtime refreshes re-render while people type. `keepInputs()` preserves values and focus for the ids in `KEEP`; add new free-text inputs that live inside re-rendered markup to that list.
- **Only public keys in the frontend.** The anon/publishable key is fine in the browser because RLS protects the data. Never add the service role key to this app or to any `VITE_` / `NEXT_PUBLIC_` variable.

## Identity

Every visitor is signed in anonymously on first load (`ensureUser()` in data.js); the user id lives in that browser's local storage. Consequences:

- The host is whoever created the session, in that browser. Opening the link on another device makes you a guest there.
- Clearing site data loses the identity (and host rights).

Planned: real accounts and profiles. Supabase lets an anonymous user be upgraded in place (`supabase.auth.updateUser({ email })` or `linkIdentity()` for OAuth), which keeps the same `auth.uid()`, so existing takes, votes and hosted sessions carry over. Display names are currently free text per take (`author_name`, `by_name`) and remembered in local storage; a `profiles` table keyed by `auth.users.id` should replace that.

## Conventions

- Match the existing style in `app.js`: `var`, function declarations, string-built HTML, `esc()` on every user-provided string that goes into markup or attributes.
- UI copy is plain, sentence case, and speaks from the user's side ("Send a take", "Let it in"). Errors say what happened and what to do.
- Keep the visual design as is unless asked; it's the original author's. Colours are CSS custom properties on `:root`.
- New database changes go in a new, timestamped file in `supabase/migrations/`. Never edit a migration that has already been applied.

## UI vocabulary

The code says seed, host and line-up; the UI says **original track**, **creator** and **the project**, and calls a take on the floor a **layer**. Keep the copy in the UI's words.

## Testing

There's no automated test suite yet. Before shipping a change, run through this with two browsers (or a normal and a private window, which get different anonymous users):

1. Browser A: load a seed with a name (or "Record right here": a pop-up with name, instrument, tempo, time, count-in and click, records until you stop, then "Start the session"; the session gets the tempo/time it was recorded at). Nothing starts until name and instrument are filled in. URL changes to `/s/<slug>`; tempo/key show up.
2. Browser B: open the link. B sees "<name>'s track", no host controls, and can send a take. A take of the wrong length is rejected.
3. A sees B's take appear without reloading, lets it in, and it shows in the line-up for both.
4. A third user sends a take for the same or another role; A hears it in the mix and lets it in or vetoes it (there is no voting in the UI).
5. Someone builds and saves a version; others can play, like and fork it. In their version, B records or uploads a take of their own (it goes straight in, nobody approves it), then sends it to the creator from the picker; A sees it waiting. Stopping a recording early and keeping it gives a full-length take that is silent after the stop. A renames the project in the field above the original track and B sees the new name. B clicks the comment strip under the ruler, posts a comment; A sees the dot, it opens while the song plays past it, and A can hide it.
6. B pitches a new part with the + on the song's edge; A hears it in place, keeps it, sets a crossfade and drags a fade handle; B sees the song get longer and can layer on that part. Recording in the page works both in the pop-up and on the grey track at the bottom of the DAW (the playhead runs over the other tracks and the take is drawn as it comes in; "Send it in" / "Add it to my version" opens the pop-up with the take loaded), and the click-track download works.
7. A deletes a take (two clicks on the bin); it disappears for everyone.
8. A closes the session; everyone moves to the release view; a mix can be uploaded; reactions count once per person.

## After pushing a branch

Always end by telling the user the Vercel preview URL for the branch.

- If the Vercel MCP tools are available, find the latest deployment for the branch,
  wait until it is ready, and report two URLs: the branch URL, taken from the
  deployment's `alias` list (it always points at the branch's latest build), and
  the deployment's own URL (pinned to that commit). If the build fails, read the
  build log, fix the problem, push again, and report the new URLs.
- Otherwise, report the branch URL:
  https://<project>-git-<branch-slug>-<team>.vercel.app
  where <branch-slug> is the branch name lowercased, with every character that is
  not a letter or digit replaced by "-". Mention that it goes live once the build
  finishes, usually in a minute or two.
- The formula only works when the part before `.vercel.app` is at most 63
  characters. Longer names get the branch part shortened and a hash added (e.g.
  `riffraff-git-claude-wizardly-pas-5195e0-paceflo-projects`), which can't
  be predicted. In that case say the formula URL may not resolve and point the
  user to the branch's deployment in the Vercel dashboard instead.

Then email the preview URL to the collaborator:

- The recipient is in the environment variable `RIFFRAFF_PREVIEW_EMAIL_TO`, set
  in each person's own cloud environment (each points at the other person).
  Never write the address into the repo.
- If it's set and the Gmail connector is available, send one short email to that
  address: subject `Riffraff preview: <branch>`, body with the preview URL(s),
  the branch name and a one-line summary of what changed. Send it only after the
  preview URL is confirmed or reported, and once per push.
- If the variable is unset or Gmail isn't connected, skip the email and tell the
  user it wasn't sent and why.

## Known limitations

- Every client downloads and decodes every take's full audio. Fine for a handful of takes; long sessions with many large WAVs will get heavy. Compressed previews or streaming would fix it.
- If an upload succeeds but the row insert fails, the file stays in Storage as an orphan.
- Anonymous sign-ins can be abused; turn on CAPTCHA (Supabase Auth settings) before promoting the app publicly.
- Every session is listed at `/songs`, and anyone can read it and its audio. There's no private-session mode.
- The host can replace the seed with a different length after takes exist; nothing stops that.
- Deleted takes keep their audio in Storage (public URL still works).
- Recording in the page uses `ScriptProcessorNode` and needs headphones; latency is compensated only by the browser's reported output latency.

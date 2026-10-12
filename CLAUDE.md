# CLAUDE.md

Context for Claude Code (and humans) working in this repo.

## What this is

Riffraff is a collaborative jam: a host drops a **seed** track (a riff, groove or vocal), anyone with the session link sends **takes** (one instrument each, exactly the seed's length), the host lets takes into the **line-up** or vetoes them, and people already in the line-up vote to steer the host. Anyone can build and save their own **version** from every take, including vetoed ones. The host eventually **closes** the session, which releases it; after that anyone can attach a mixed version.

It started life as a single-file Claude artifact (an in-memory prototype with a fake "let the line-up vote" button). This repo is the hosted version: same UI and audio engine, real persistence, real multi-user sessions.

## Stack

- **Frontend:** plain JavaScript (ES modules, no framework), bundled by **Vite**. The UI renders HTML strings into containers; there is no virtual DOM.
- **Backend:** **Supabase** (Postgres + Row Level Security, Storage for audio, Realtime for live updates, Auth with anonymous sign-ins). There is no server code of our own.
- **Hosting:** **Cloudflare Pages** (project `stakkato`, production on stakkato.app), static build from `dist/`; the Node version is in `.node-version`, the Supabase URL and key are `VITE_` build variables in the Pages project. `/` is the homepage (`index.html`); Cloudflare serves `/songs` and `/privacy` from `songs.html` and `privacy.html` by itself (and redirects `/x.html` to `/x`), and `functions/_middleware.js` serves the song view (`session.html`) for `/s/<slug>` and `/new`. Each page is its own Vite entry; `vite.config.js` does the same routes for dev and preview. There is no `_redirects` file: Functions run first, so routes live in the middleware.
- **Access gate:** `functions/_middleware.js` (a Cloudflare Pages Function that runs before every request) asks for an access password before serving anything, set in the Pages project's `ACCESS_PASSWORD` variable. Until that is set it accepts the friends' password, kept in the file only as a hash. Once accepted, a cookie keeps you in for 30 days; it covers every page and file (also `/amps/*` and the audio worklet). It only runs on Cloudflare, so `npm run dev` isn't gated (`npx wrangler pages dev dist` runs it locally after a build).
- **Audio:** Web Audio API in the browser: decoding, mixing, waveform peaks, tempo/key detection (`src/analysis.js`), amp sims (`src/amp.js`). Nothing audio-related runs on a server.
- **Analytics:** Google Tag Manager (`GTM-5RQ4VKFH`, the snippet near the top of every page's `<head>`, right after the theme script) and Cloudflare Web Analytics (cookieless; switched on for the Pages project in the Cloudflare dashboard, which injects its script into every page, so there is no code for it here). There is no cookie consent banner yet: whatever tags are added in the GTM dashboard run for everyone (see Known limitations).

## Commands

```bash
npm install
npm run dev       # http://localhost:5173, needs .env.local (see .env.example)
npm run build     # outputs dist/
npm run preview   # serve the build locally
```

Apply database changes with the Supabase CLI (`npx supabase db push`) or by pasting a migration into the Supabase SQL editor. See README.md for first-time setup.

**The live database** is the Supabase project `riffraff` (ref `trsnykjzupevdiupvmlj`). Every migration in `supabase/migrations/` up to `20261012090000_take_amps.sql` is applied there. Most were applied through the SQL editor or the Supabase MCP tools, so the project's migration history has its own version numbers (the date they were applied), not the file names' timestamps: compare by name (`list_migrations`) before applying anything, and apply a new migration on its own rather than running `db push` against the live project, which would try to re-run the old ones. `own_takes` was applied with `ALTER POLICY` instead of drop + create (the drop timed out on the live database); the resulting policy is the same. Say in the PR whether a migration is already applied.

## Layout

```
index.html, src/home.js     the homepage (/): feed of jams with threads of audio and written replies, votes, upload a new jam, sign in
session.html                the song view (/s/<slug>, /new): static shell; most content is rendered by app.js
songs.html, src/songs.js    the /songs page: every session with an original track, linking to /s/<slug>
privacy.html                the privacy & rights page (/privacy), a draft for legal review
functions/_middleware.js    the access gate and the song view's routes (Cloudflare Pages only)
public/fonts/               the self-hosted fonts: fonts.css, woff2 files, OFL licences
src/app.js                  the whole UI: state, rendering, audio engine, event handlers
src/data.js                 every Supabase call; app.js never uses the client directly
src/supabase.js             client setup from env vars
src/analysis.js             tempo + key detection (unchanged from the prototype)
src/roles.js                instrument roles, colours, icons (mirror of the roles table)
src/icons.js, src/zip.js    inline SVG icons; store-only zip writer for stem downloads
src/amp.js                  amps (clean, crunch, metal): NAM captures + cabinet IRs, rendered offline per take
public/amps/                the amp captures (.nam), cabinet and room IRs, and their CREDITS.md / licences
src/styles.css              the song view's and /songs' styles (colour tokens on :root)
src/theme.js, src/dark.css  light/dark mode: the toggle in every header ([data-theme-toggle]) and the dark tokens
supabase/migrations/        schema, RLS policies, RPC functions, storage bucket, realtime
```

## Data model (Postgres, `public` schema)

- `sessions`: one per song. `host_id` is the user who created it (and dropped the seed). `status` is `open` or `released`. Tempo/key/time live here (`bpm`, `music_key`, `key_alt`, `time_sig`, `meta_from`, `meta_sure`). `seed_role` is the instrument the host says the seed is (null = not one instrument). Every instrument has open slots (`roles.slots` is null = unlimited; `role_cap()`/`section_cap()` pass the null through), so nobody is ever pushed out by a new take -- it stops only when the creator decides. The seed's own instrument still notionally takes one slot in that role (`role_cap()` subtracts it when the role is finite), and `seed_role_claims_slot()` bumps the oldest takes if a *finite* role overflows; that trigger is a no-op for the unlimited roles in place today, and is refused once the session is closed. `seed_take_id` points at the current seed; replaced seeds stay in `takes` but are ignored.
- `takes`: every piece of audio. `role_id` is `seed`, `mix`, `part` or an instrument id. `status` is `seed | waiting | in | archived | mix | deleted | own`. `joined_at` orders the line-up (the oldest take in a full role is the one that gets pushed out). Audio lives in Storage at `storage_path`. `fade_in` / `fade_out` (seconds) and `xfade` (parts only) are set by the host through `set_fades()` and heard by everyone.
- New parts: a take with `role_id = 'part'` and `part_pos` `before | after` is a piece of any length that makes the song longer. Pitched = `waiting`, kept = `in`, passed or dropped = `archived` with reason `passed`. Layers can sit on a kept part: `section_id` is that part's id (null = the seed). Slots count per section (`section_cap()`): the seed and each kept part have their own line-up, and the seed's instrument only takes a slot on the seed. `arrangement()` in app.js builds the timeline: parts before (the newest plays first), the original track with its layers, parts after (the newest plays last). A layer must match the length of its section. Crossfades go up to 8 s and never more than half of either side; they lengthen the fades where parts overlap. The upload policy requires a position for a part, allows layers only on a kept part of the same session, and refuses takes sent with fades already set.
- Own takes: a take with status `own` was recorded or uploaded for someone's own version. It never waits for the creator and never enters the project; only its author sees it in the version builder (other clients load it only when a version uses it). Its author can send it to the creator with `send_own_take()`, which turns it into an ordinary `waiting` take. Its author can also delete it (`delete_take()` allows that for own takes, also after release). Own takes are layers on the original track only (no `section_id`), and can be added after the session is closed too.
- `comments`: SoundCloud-style comments on the timeline. `at_sec` counts from the start of the original track (negative = on a part before it), so a comment stays on the same music when parts are added. Readable by everyone; anyone signed in can comment while the session is open; the host hides one with `hide_comment()` (`hidden = true`, never deleted). The app loads them with the snapshot and listens on a separate realtime channel, and works without them if their migration isn't applied.
- `votes`: `(take_id, voter_id)` → `up | down`. Only people with a take in the line-up can vote, and not on the take that would replace their own. **The voting UI is switched off** (the creator decides alone); the table, `can_vote()` and the vote handlers in app.js stay, unused.
- `versions`: a fan version is just `picks` (take ids) plus `ctl` (per-take vol/mute/solo, `hp`/`lp` filter cutoffs in Hz and `amp`, keyed by take id, with the seed under the key `"seed"`). No audio is copied. A version without its own `amp` for a take uses the take's.
- Amps: `takes.amp` is null (off) or `clean | crunch | metal`. The audio stays dry; the browser renders the take through the amp once (`renderAmp()` in `src/amp.js`: a Neural Amp Modeler capture in an AudioWorklet, a speaker cabinet impulse response, a gate on metal and a little room on clean, in an OfflineAudioContext) and plays that render (`playBuf()` in app.js, kept on the take per amp; also on the homepage). Until the render is ready the take is silent, not dry. Only "Hear yourself" runs the amp live (`liveAmp()`). It is set on insert (the amp picked while recording a guitar, lead or bass take) and changed with `set_amp()`: by the creator while the session is open, or by the take's author while it is `waiting` or `own`. Downloads are the dry files.
- `version_likes`, `reactions`: one row per person, never deleted.
- `roles`: slot counts per instrument. **Authoritative for slots.**
- Homepage threads: `takes.reply_to` is the take a take was played on top of (null = on the original track or on the part in `section_id`); a trigger keeps it inside the session. `thread_comments` are written replies on a jam, a take (`reply_to_take`) or another comment (`reply_to_comment`); anyone signed in, also anonymously, can post; the creator hides one with `hide_thread_comment()`. `thread_votes` is one upserted row per person per jam/take/comment with `value` -1, 0 or 1. The song view doesn't read any of these yet.
- Stacks (the song view from the Stakkato concept): `takes.on_takes` lists the takes that were playing when a take was recorded (the stack it was played on; the original track is implied), and the song view builds its thread of stacks from it. `takes.group_id` ties takes sent together as one reply (several instruments in one go); the homepage shows them as one post. When a take is inserted without `reply_to`, a trigger fills it from `on_takes` (the newest take of the stack), so the homepage thread and the song view agree; the homepage sets both. `stack_likes` is one row per person per liked stack (`stack_key` = the stack's take ids, sorted, comma-joined).
- Deleting from the homepage (author, or an admin): `delete_jam()` sets `sessions.deleted_at` (every page leaves the jam out, rows and audio stay); `delete_thread_take()` marks a take `deleted` (not seeds, mixes or parts) and the app then removes its audio from Storage (allowed only for a deleted take's file); `delete_thread_comment()` sets `thread_comments.deleted_at` and clears the text. Replies stay: the feed shows a deleted post that has replies as a placeholder, and a reply no longer plays the deleted take. `is_admin()` is true for accounts with `role: "admin"` in `app_metadata` (set in SQL or the dashboard, never by the user).

Storage bucket `takes` is public-read. Upload path: `{session_id}/{user_id}/{uuid}.{ext}`, 50 MB per file, `audio/*` only.

## Rules that are easy to break

- **Permissions live in the database.** RLS policies and the `let_in()` / `veto()` / `can_vote()` functions enforce who can do what. The UI hides buttons for convenience, but never rely on UI checks for security. If you add a write, add a policy.
- **Host-only status changes go through RPCs.** There is deliberately no UPDATE policy on `takes`. Letting in, vetoing and bumping happen in `let_in()` / `veto()` so slot rules are atomic; parts are dropped with `drop_part()`, fades set with `set_fades()`, amps with `set_amp()`, takes deleted with `delete_take()`. The host takes a layer back out of the project with `take_out_layer()` (in → archived, reason `removed`; still usable in versions). The one status change that isn't the host's is `send_own_take()` (own → waiting, by the take's author).
- **Nothing is deleted.** Realtime `postgres_changes` can't filter DELETE events by column, so the app avoids deletes entirely (votes are upserted, likes and reactions are permanent). "Deleting" a take sets its status to `deleted` (a part takes its layers with it); the app filters those out. If you add real deletes, the subscription in `data.js` needs rethinking.
- **Realtime is a "something changed" signal.** Every event triggers a debounced full refetch (`refresh()` in app.js). Don't apply event payloads incrementally unless there's a measured reason to.
- **The current seed is addressed as `'seed'` in the UI.** `applySnapshot()` renames the current seed's take object id to `'seed'`; everything else uses its database id (`dbId` always holds the real id). Mixer settings in versions rely on this.
- **Roles are defined twice.** `src/roles.js` (labels, colours, icons, slots for display) and the `roles` table + the `role_id` check constraint on `takes` in the migration. Change them together, in a new migration.
- **`TAKES` is a cache keyed by database id.** Take objects are updated in place on refresh so decoded audio, peaks and line-up mixer settings survive. Don't rebuild them from scratch.
- **Re-rendering must not eat user input.** Realtime refreshes re-render while people type. `keepInputs()` preserves values and focus for the ids in `KEEP`; add new free-text inputs that live inside re-rendered markup to that list.
- **Amp ids live in three places.** `AMPS` / `P` in `src/amp.js`, the check constraint on `takes.amp` and the list in `set_amp()`. Adding an amp means a new migration for the last two, its files in `public/amps/`, and its credits in `public/amps/CREDITS.md` and on /privacy (the files are GPL v3 and CC BY 4.0, which require that).
- **Takes with an amp play their render, never `t.buf` directly.** Anything new that plays takes goes through `playBuf(t)` (and falls back to `t.buf` only when `ampFailed(t)`), or the amp is skipped there.
- **Only public keys in the frontend.** The anon/publishable key is fine in the browser because RLS protects the data. Never add the service role key to this app or to any `VITE_` / `NEXT_PUBLIC_` variable.

## Identity

Every visitor of the song view is signed in anonymously on first load (`ensureUser()` in data.js); the homepage only does that on the first write (comment, vote, take, new jam), so reading the feed creates no users. The user id lives in that browser's local storage. Consequences:

- The host is whoever created the session, in that browser. Opening the link on another device makes you a guest there.
- Clearing site data loses the identity (and host rights).

Accounts: email + password, signed in from the homepage (`signInWithEmail()` in data.js). They are created by hand in Supabase for now; the name shown is `user_metadata.username`. Signing in replaces the anonymous user in that browser (its takes and hosted sessions stay with the anonymous user). Sign-up is switched off (greyed-out buttons) and Google sign-in is stubbed. The `admin` account has `app_metadata.role = 'admin'`.

Planned: real sign-up and profiles. Supabase lets an anonymous user be upgraded in place (`supabase.auth.updateUser({ email })` or `linkIdentity()` for OAuth), which keeps the same `auth.uid()`, so existing takes, votes and hosted sessions carry over. Display names are currently free text per take (`author_name`, `by_name`) and remembered in local storage; a `profiles` table keyed by `auth.users.id` should replace that.

## Conventions

- Match the existing style in `app.js`: `var`, function declarations, string-built HTML, `esc()` on every user-provided string that goes into markup or attributes.
- UI copy is plain, sentence case, and speaks from the user's side ("Send a take", "Let it in"). Errors say what happened and what to do.
- Keep the visual design as is unless asked; it's the original author's. Colours are CSS custom properties on `:root`. The light theme is cream (`#FCFBF4` background), the fonts are Bricolage Grotesque (headings, never all caps) and DM Sans (body). The fonts (and Fredoka, used on the homepage and /privacy) are self-hosted in `public/fonts/` (`fonts.css`, woff2 files fetched from Google Fonts, their OFL licences), so pages make no requests to Google for them; every page and the access gate link `/fonts/fonts.css`, and `functions/_middleware.js` lets `/fonts/` through without the cookie.
- Left out on purpose, don't bring back without asking: the prototype-only controls ("Signals", "View as", "Empty the session", the fake "Let the line-up vote" button), the concept's "Add your instrument" band, and the voting UI.
- The product is called **Stakkato** (formerly Stackato). Its logos are `public/stakkato-logo.svg` and `public/stakkato-logo-on-dark.svg`; every header carries both as `img.logo` (the dark one also `.on-dark`) and `src/dark.css` shows the one for the theme. Internal ids keep the old spelling on purpose (the `stackato:*` storage keys, the access cookie and its hash prefix), so settings and gate passes survive the rename.
- Per-browser settings live in local storage under `stackato:*`: `stackato:theme`, `stackato:mic` (input), `stackato:amp` (the amp picked for recording; only offered for guitar, lead and bass, `AMP_ROLES` in app.js) and `stackato:monitor` ("Hear yourself"); the name for the credits under `riffraff:name`.
- The song view's breadcrumbs lead back to the jam's thread on the homepage, at the take whose stack was open.
- Stem downloads (a store-only zip, `src/zip.js`) include a session sheet: each file's start time, fades and amp (the files themselves are dry).
- Dark mode: `<html data-theme="dark">` (set before first paint by a small inline script in each page's head; the choice is remembered under `stackato:theme`, otherwise the device setting wins). `src/dark.css` redefines the tokens; a colour written out instead of a token needs a dark override there. The dark bands (`.startband`, `.owncta`, ...) bring the light-mode paper/ink back inside, so they look the same in both modes. Canvases redraw on the `stackato:theme` event.
- New database changes go in a new, timestamped file in `supabase/migrations/`. Never edit a migration that has already been applied.

## UI vocabulary

The code says seed, host and line-up; the UI says **original track**, **creator** and **the stack**. Keep the copy in the UI's words, and use these terms the same way everywhere (buttons, tooltips, messages, empty states):

- **Layer**: a role in the song (drums, bass, vocals...). In the code that is a role.
- **Take**: one concrete recording by a musician for a layer.
- **Stack**: the chosen takes that together form the song (the line-up). "Takes to review" are the waiting ones; "Unused takes" are archived ones.
- **Version**: someone's own combination of the available takes.
- **Mix**: a finished, mixed recording of the stack, uploaded after release (`role_id = 'mix'`).
- **Release**: publishing the end result (closing the session, `status = 'released'`).

Layout rule: one main (orange) action per block. Secondary actions on a take (play on its own, download, delete, take out) live in its "⋯" menu (`menuBtn()` / `mi()` in app.js); a take's play button does the most useful thing for its block (in the mix for takes to review, with the original track in the own-version block). Messages show as a toast (`flash()`).

## Testing

There's no automated test suite yet. What earlier changes were checked with, and works in a cloud session:

- `npm run build` must pass (Cloudflare Pages runs the same).
- Headless Chromium through Playwright (installed globally; `PLAYWRIGHT_BROWSERS_PATH` is set) against `npm run dev` or `npx vite preview`. Without `.env.local` the pages load but can't reach Supabase; earlier PRs drove the UI against an in-memory stand-in for `data.js` / Supabase.
- Audio code (amps, recording maths) can be checked offline in Chromium with an `OfflineAudioContext`: render a synthetic signal and look at levels, NaNs and spectra.
- Database permissions: try the RPCs as real users inside rolled-back transactions (`begin; set local role authenticated; set local request.jwt.claims = '...'; ... rollback;`).

Before shipping a change, run through this with two browsers (or a normal and a private window, which get different anonymous users):

1. Browser A: load a seed with a name (or "Record right here": a pop-up with name, instrument, tempo, time, count-in and click, records until you stop, then "Start the session"; the session gets the tempo/time it was recorded at). Nothing starts until name and instrument are filled in. URL changes to `/s/<slug>`; tempo/key show up.
2. Browser B: open the link. B sees "<name>'s track", no host controls, and can send a take. A take of the wrong length is rejected.
3. A sees B's take appear under "Takes to review" without reloading, presses "Add to song", and it shows in the tracks for both.
4. A third user sends a take for the same or another role; A presses its play button to hear it in the mix and adds it to the song or vetoes it (there is no voting in the UI).
5. Someone builds and saves a version; others can play, like and fork it. In their version, B records or uploads a take of their own (it goes straight in, nobody approves it), then sends it to the creator from the picker; A sees it waiting. Stopping a recording early and keeping it gives a full-length take that is silent after the stop. A renames the project in the field above the original track and B sees the new name. B clicks the comment strip under the ruler, posts a comment; A sees the dot, it opens while the song plays past it, and A can hide it.
6. B pitches a new part with the + on the song's edge; A hears it in place, keeps it, sets a crossfade and drags a fade handle; B sees the song get longer and can layer on that part. Recording in the page works both in the pop-up and on the grey track at the bottom of the DAW (for guitar, lead or bass, pick an amp and tick "Hear yourself" to play a DI through it; the take shows the amp tag and A hears it too; FX on a track switches amps, in a version only for that version) (the playhead runs over the other tracks and the take is drawn as it comes in; "Add my take →" / "Add it to my version" opens the pop-up with the take loaded), and the click-track download under "Play along" works.
7. A deletes a take (⋯ menu, then "Delete this take" twice); it disappears for everyone.
8. A presses "Release the song"; everyone moves to the release view; a Mix can be uploaded; reactions count once per person.

## After pushing a branch

Always end by telling the user the Cloudflare Pages preview URL for the branch.
Cloudflare Pages (project `stakkato`) builds every pushed branch. There is no
Cloudflare connector in these sessions, so the URL is worked out, not looked up.

- Report the branch URL, which always points at the branch's latest build:
  https://<branch-alias>.stakkato.pages.dev
  where <branch-alias> is the branch name lowercased, with every character that
  is not a letter, digit or "-" replaced by "-", cut to its first 28 characters,
  and with leading and trailing "-" removed. For example
  `claude/friendly-wright-qbggks` becomes `claude-friendly-wright-qbggk`.
  Mention that it goes live once the build finishes, usually in a minute or two.
- Long branch names are cut, not hashed, so the alias stays predictable. The
  28-character rule comes from Cloudflare staff on the community forum, though,
  not from the official docs. When the branch name is longer than 28 characters,
  say the URL may not resolve and point the user to the branch's deployment in
  the Cloudflare dashboard (Workers & Pages → stakkato → Deployments).
  Two branches whose first 28 characters match share one alias.
- The dashboard also shows each deployment's own URL,
  https://<hash>.stakkato.pages.dev, pinned to that commit, and the build log
  if a build fails. When the user reports a failed build, fix the problem, push
  again and report the new URL.

Then email the preview URL to the collaborator:

- The recipient is in the environment variable `RIFFRAFF_PREVIEW_EMAIL_TO`, set
  in each person's own cloud environment (each points at the other person).
  Never write the address into the repo.
- If it's set and the Gmail connector is available, send one short email to that
  address: subject `Riffraff preview: <branch>`, body with the preview URL(s),
  the branch name and a one-line summary of what changed. Send it only after the
  preview URL is reported, and once per push.
- If the variable is unset or Gmail isn't connected, skip the email and tell the
  user it wasn't sent and why.

## Known limitations

- The amp engine is `@happysoftware/nam-web`, pinned to 0.2.0 (a young package). Its WebAssembly binary isn't in the package's exports, so `vite.config.js` aliases `nam-web-dist` to its `dist/` folder and `src/amp.js` imports the files with `?url`.

- Every client downloads and decodes every take's full audio. Fine for a handful of takes; long sessions with many large WAVs will get heavy. Compressed previews or streaming would fix it.
- If an upload succeeds but the row insert fails, the file stays in Storage as an orphan.
- No cookie consent yet. Cloudflare Web Analytics sets no cookies, but most tags added in Google Tag Manager (GA4, ads pixels) do, and in the EU (Belgium) those need consent before they run: add a consent banner with Google Consent Mode before adding such tags. The /privacy cookies section still says there is no tracking and no banner; update it with the analytics setup.
- Anonymous sign-ins can be abused; turn on CAPTCHA (Supabase Auth settings) before promoting the app publicly.
- Every session is listed at `/songs`, and anyone can read it and its audio. There's no private-session mode.
- The host can replace the seed with a different length after takes exist; nothing stops that.
- Deleted takes keep their audio in Storage (public URL still works).
- Amps: three fixed presets, no knobs. Every listener's browser renders each amped take itself after loading it (a NAM WaveNet runs at roughly 0.1 to 0.6x real time depending on the machine, one render at a time), so a session with many long amped takes takes a while before every guitar sounds; renders aren't stored anywhere. The captures run at 48 kHz; a live amp in a 44.1 kHz context is resampled (linear) and 128 samples late. "Hear yourself" monitors through the browser, so it is a few tens of milliseconds late; direct monitoring on the interface is tighter (and then leave it off). The amp files are GPL v3 (captures) and CC BY 4.0 (cabinets, room): keep `public/amps/CREDITS.md` and the credits on /privacy when changing them.
- Recording in the page captures with an `AudioWorklet` (falls back to `ScriptProcessorNode` where there is none) and stitches the blocks back to back; it needs headphones, and latency is compensated only by the browser's reported output latency. It records the first channel of the chosen input (the input picker is remembered per browser under `stackato:mic`); on multi-channel interfaces that is often a dry DI channel, so a very quiet take shows a warning. If the click gets into a recording (speakers, or an interface that sends the computer's playback back into the recorded channel), `findClick()` finds it on the count-in bars, lines the take up by it and subtracts it; without a count-in it isn't detected. Other backing tracks that leak in the same way are not taken out, only warned about. A take of free length (the original track recorded in the page, a new part) is cut to the last bar with sound in it (40 dB under its peak), so the wait before pressing stop doesn't end up in the song.

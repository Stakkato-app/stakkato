# CLAUDE.md

Context for Claude Code (and humans) working in this repo.

## What this is

Stakkato (formerly Riffraff) is a collaborative jam: a host drops a **seed** track (a riff, groove or vocal), anyone with the session link sends **takes** (one instrument each, exactly the seed's length), the host lets takes into the **line-up** or vetoes them, and people already in the line-up vote to steer the host. Anyone can build and save their own **version** from every take, including vetoed ones. The host eventually **closes** the session, which releases it; after that anyone can attach a mixed version.

It started life as a single-file Claude artifact (an in-memory prototype with a fake "let the line-up vote" button). This repo is the hosted version: same UI and audio engine, real persistence, real multi-user sessions.

## Stack

- **Frontend:** plain JavaScript (ES modules, no framework), bundled by **Vite**. The UI renders HTML strings into containers; there is no virtual DOM.
- **Backend:** **Supabase** (Postgres + Row Level Security, Storage for audio, Realtime for live updates, Auth with anonymous sign-ins). There is no server code of our own.
- **Hosting:** **Cloudflare Pages** (project `stakkato`, production on stakkato.app), static build from `dist/`; the Node version is in `.node-version`, the Supabase URL and key are `VITE_` build variables in the Pages project. `/` is the homepage (`index.html`); Cloudflare serves `/songs`, `/privacy`, `/reset`, `/settings` and `/admin` from their own `.html` files by itself (and redirects `/x.html` to `/x`), and `functions/_middleware.js` serves the song view (`session.html`) for `/s/<slug>` and `/new`, a profile (`profile.html`) for `/u/<name>`, and checks email links on `/auth/confirm`. Each page is its own Vite entry; `vite.config.js` does the same routes for dev and preview. There is no `_redirects` file: Functions run first, so routes live in the middleware.
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

**The live database** is the Supabase project `Stakkato` (ref `kgsnnokgczfwjzywfocn`, eu-west-1) in the shared organization. It replaced the project `riffraff` (ref `trsnykjzupevdiupvmlj`): the schema was rebuilt there in one go and the data copied over. Every migration in `supabase/migrations/` up to `20261012090000_take_amps.sql` is applied there, and so are `20261012180000_thread_realtime.sql`, `20261017120000_accounts.sql`, the carry and parts-as-replies migrations (pasted in the SQL editor, so not in the history) and `20261022120000_take_peaks.sql` (`20260928173304_open_slots.sql` only on Stakkato, after the move; `riffraff` never had it). The migration history mostly has its own version numbers (the date each was applied, and `init` isn't listed), not the file names' timestamps (`open_slots` is the exception): compare by name (`list_migrations`) before applying anything, and apply a new migration on its own rather than running `db push` against the live project, which would try to re-run the old ones. The Supabase MCP tools time out on migrations with destructive statements (`DROP`, an `UPDATE` without `WHERE`); paste those into the SQL editor instead. Say in the PR whether a migration is already applied.

## Layout

```
index.html, src/home.js     the homepage (/): feed of jams with threads of audio and written replies, votes, upload a new jam, sign in
session.html                the song view (/s/<slug>, /new): static shell; most content is rendered by app.js
songs.html, src/songs.js    the /songs page: every session with an original track, linking to /s/<slug>
privacy.html                the privacy & rights page (/privacy), a draft for legal review
profile.html, src/profile.js  a player's profile (/u/<name>): jams started and played on, with a play button per jam
settings.html, src/settings.js  /settings: your name and profile link, how you sign in, changing your password, deleting your account (by email for now)
admin.html, src/admin.js     /admin (temporary): every account (tiles, filters, search, a table) and "View as"; data only for the admin (`admin_accounts()`)
src/viewas.js               "View as" (temporary): the admin sees the site as someone else, read-only, in this tab only
reset.html, src/reset.js    /reset: a new password from the email link
src/auth.js, src/auth.css   accounts on every page: the header's account corner and menu, the sign-up / sign-in pop-up, requireAccount(), onAccount(), profileHref()
functions/_middleware.js    the access gate, the song view's and profiles' routes, email links (Cloudflare Pages only)
public/fonts/               the self-hosted fonts: fonts.css, woff2 files, OFL licences
src/app.js                  the whole UI: state, rendering, audio engine, event handlers
src/rec.js                  recording, shared by the song view and the homepage's reply pop-up: microphone and worklet, click, finding the click in a take, lining the blocks up into one take, the wav encoder, the per-browser settings (input, amp, "Hear yourself")
src/data.js                 every Supabase call; app.js never uses the client directly
src/supabase.js             client setup from env vars
src/analysis.js             tempo + key detection (unchanged from the prototype)
src/peaks.js                a take's waveform as a short string (takes.peaks): made at every insert, drawn by the homepage, profiles and /songs
scripts/backfill-peaks.mjs  one-off, run on your own machine: fills takes.peaks for older takes (service role key from your shell, ffmpeg)
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
- New parts: a take with `role_id = 'part'` and `part_pos` `before | after` is a piece of any length that makes the song longer. It is a reply like any take ("Make the song longer", `20261019230000_parts_as_replies.sql`): it remembers the stack it was made on (`on_takes`, so the homepage nests it under that take), anyone can layer on it straight away, also before it is in the song (in the project while hearing it in place: the trial pitch counts as a section), and one person can send it in several files: the part is then a silent file as long as the files and each file is a layer on it, in one group (`postPartWithLayers()`). Not in the song yet = `waiting`, in the song = `in` (the creator's "Add to song"; the tracks its author sent with it come along, and `let_in()` on a layer brings its part in too), passed or dropped = `archived` with reason `passed`. Layers can sit on a part: `section_id` is that part's id (null = the seed). Slots count per section (`section_cap()`): the seed and each kept part have their own line-up, and the seed's instrument only takes a slot on the seed. The grey track at the bottom of the project records on the original track or on any part in the tracks (`S.recSec`, the "On …" picker; clicking a part in the thread points it there), so a layer on a new part can be recorded in place; a draft keeps the part it was started on (`S.draftSec`). "Play the whole song" on a new part plays the song from the top with the part in it (project: `goPart(id, 0, true, true)`; homepage: `playWhole()`, the stack the part was made on, then the part with its author's tracks, one after the other). `arrangement()` in app.js builds the timeline: parts before (the newest plays first), the original track with its layers, parts after (the newest plays last). A layer must match the length of its section. Crossfades go up to 8 s and never more than half of either side; they lengthen the fades where parts overlap. The upload policy requires a position for a part, allows layers only on a part of the same session that is waiting or in, and refuses takes sent with fades already set.
- Carried tracks: a new part can list takes of the original track in `takes.carry` (uuid[], parts only, same jam; `20261018230000_carry_into_parts.sql`, a trigger checks it). Nothing is copied: under the part, every browser plays those takes again from the part's start, repeated to fill it and cut at its end, through their own mixer strip and with the part's fades (`carryOf()` and the end of `play()` / `playBacking()` in app.js; `chainOf()` on the homepage). Ticked in the "Convince the creator" window (`fillCarry()`); a part that only repeats, with no file of its own, is sent as a silent file (8 kHz) as long as the original track (`silentPart()`). Stem downloads don't include the repeats.
- Own takes: a take with status `own` was recorded or uploaded for someone's own version. It never waits for the creator and never enters the project; only its author sees it in the version builder (other clients load it only when a version uses it). Its author can send it to the creator with `send_own_take()`, which turns it into an ordinary `waiting` take. Its author can also delete it (`delete_take()` allows that for own takes, also after release). Own takes are layers on the original track only (no `section_id`), and can be added after the session is closed too.
- `comments`: SoundCloud-style comments on the timeline. `at_sec` counts from the start of the original track (negative = on a part before it), so a comment stays on the same music when parts are added. Readable by everyone; anyone signed in can comment while the session is open; the host hides one with `hide_comment()` (`hidden = true`, never deleted). The app loads them with the snapshot and listens on a separate realtime channel, and works without them if their migration isn't applied.
- `votes`: `(take_id, voter_id)` → `up | down`. Only people with a take in the line-up can vote, and not on the take that would replace their own. **The voting UI is switched off** (the creator decides alone); the table, `can_vote()` and the vote handlers in app.js stay, unused.
- `versions`: a fan version is just `picks` (take ids) plus `ctl` (per-take vol/mute/solo, `hp`/`lp` filter cutoffs in Hz and `amp`, keyed by take id, with the seed under the key `"seed"`). No audio is copied. A version without its own `amp` for a take uses the take's.
- Peaks: `takes.peaks` (`20261022120000_take_peaks.sql`) is the take's waveform, so the homepage, profiles and /songs draw it without downloading the audio: 1000 columns of (highest, lowest) sample of the first channel, scaled to the take's own peak, one byte each, base64 (2668 characters; the column allows 4096). `src/peaks.js` makes it (`peaksOfBuffer()`) and decodes it (`decodePeaks()`, `columns()`). Every insert sets it: `uploadTake()` in app.js and the reply and "Start a jam" inserts in home.js; `insertTake()` retries without it when the migration is missing. There's no UPDATE policy, so only `scripts/backfill-peaks.mjs` (service role) fills it later. Takes without peaks fall back to loading the audio to draw it. The project still loads every take's audio and draws from that.
- Amps: `takes.amp` is null (off) or `clean | crunch | metal`. The audio stays dry; the browser renders the take through the amp once (`renderAmp()` in `src/amp.js`: a Neural Amp Modeler capture in an AudioWorklet, a speaker cabinet impulse response, a gate on metal and a little room on clean, in an OfflineAudioContext) and plays that render (`playBuf()` in app.js, kept on the take per amp; also on the homepage). Until the render is ready the take is silent, not dry. Only "Hear yourself" runs the amp live (`liveAmp()`). It is set on insert (the amp picked while recording a guitar, lead or bass take) and changed with `set_amp()`: by the creator while the session is open, or by the take's author while it is `waiting` or `own`. Downloads are the dry files.
- `version_likes`, `reactions`: one row per person, never deleted.
- `roles`: slot counts per instrument. **Authoritative for slots.**
- Homepage threads: `takes.reply_to` is the take a take was played on top of (null = on the original track or on the part in `section_id`); a trigger keeps it inside the session. `thread_comments` are written replies on a jam, a take (`reply_to_take`) or another comment (`reply_to_comment`); anyone signed in, also anonymously, can post; the creator hides one with `hide_thread_comment()`. `thread_votes` is one upserted row per person per jam/take/comment with `value` -1, 0 or 1. The song view reads them too (`loadSnapshot()` returns them as `words` and `tvotes`): its thread nests written replies under the take, new part or reply they answer, lets anyone post, vote, and delete their own, and lets the creator hide one. Its filters (All, Takes, Words, To review) are client-side. Live updates for them need `20261012180000_thread_realtime.sql` (it adds both tables to the realtime publication); they're on their own channel in `subscribe()`, so the other channels keep working without it.
- Stacks (the song view from the Stakkato concept): `takes.on_takes` lists the takes that were playing when a take was recorded (the stack it was played on; the original track is implied), and the song view builds its thread of stacks from it. `takes.group_id` ties takes sent together as one reply (several instruments in one go); the homepage shows them as one post. When a take is inserted without `reply_to`, a trigger fills it from `on_takes` (the newest take of the stack), so the homepage thread and the song view agree; the homepage sets both. `stack_likes` is one row per person per liked stack (`stack_key` = the stack's take ids, sorted, comma-joined).
- Deleting from the homepage (author, or an admin): `delete_jam()` sets `sessions.deleted_at` (every page leaves the jam out, rows and audio stay); `delete_thread_take()` marks a take `deleted` (not seeds, mixes or parts) and the app then removes its audio from Storage (allowed only for a deleted take's file); `delete_thread_comment()` sets `thread_comments.deleted_at` and clears the text. Replies stay: the feed shows a deleted post that has replies as a placeholder, and a reply no longer plays the deleted take. `is_admin()` is true for accounts with `role: "admin"` in `app_metadata` (set in SQL or the dashboard, never by the user).

Storage bucket `takes` is public-read. Upload path: `{session_id}/{user_id}/{uuid}.{ext}`, 50 MB per file, `audio/*` only. Uploads set a one-year cache (`cacheControl: '31536000'` in `uploadAudio()`): file names are random and never overwritten.

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
- **Every new insert of a take sets `peaks`** (`peaksOfBuffer(buf)` from `src/peaks.js`), or the homepage has to download that take's audio to draw it.
- **The homepage, profiles and /songs load audio only on play.** Draw from `peaks`; fetch a file when someone presses play (or opens the reply pop-up, which plays what you play on), never on render.
- **Only public keys in the frontend.** The anon/publishable key is fine in the browser because RLS protects the data. Never add the service role key to this app or to any `VITE_` / `NEXT_PUBLIC_` variable.

## Identity

Every visitor of the song view is signed in anonymously on first load (`ensureUser()` in data.js); the homepage only does that on the first write (comment, vote, take, new jam), so reading the feed creates no users. The user id lives in that browser's local storage. Consequences:

- The host is whoever created the session, in that browser. Opening the link on another device makes you a guest there.
- Clearing site data loses the identity (and host rights).

Accounts (`supabase/migrations/20261017120000_accounts.sql`, `src/auth.js`): sign up with email + password or Google, from the account corner in every page's header. Reading and listening need nothing; every write needs an account (`has_account()`: signed in, not anonymous, with a named profile), and a page asks for one with `requireAccount()` before the action carries on. `profiles` holds the name (3 to 24 letters, numbers, `.`, `-`, `_`; unique ignoring case; fixed once picked, only `admin_rename()` changes it; readable by everyone). An email account gets it from sign-up, a Google account picks it afterwards (`pick_username()`). Anonymous users have no profile. `author_name` / `by_name` are filled from the profile on insert. Email links land on `/auth/confirm`; the templates are in `supabase/templates/`. The `admin` account has `app_metadata.role = 'admin'`.

Every name with a profile links to `/u/<name>` (`profileHref()`): the song view and the homepage keep a cache of names by user id (`PROF`, filled by `askProfiles()` through `profilesFor()` after each load) and render names through `nameOf(text, uid)`, which links only when the author has a profile. Deleting an account is by email to hello@stakkato.app for now (/settings says so).

**/admin and "View as" (temporary).** `/admin` lists every account through `admin_accounts()`, which refuses everyone but the admin (the page itself loads for anyone and shows nothing else). House accounts (our own seeding accounts) carry a "House" tag and are left out of the tiles. "View as" happens in the browser only: the person is kept in sessionStorage `stackato:viewas` (this tab only), `src/auth.js` hands every page that person as the signed-in user (`account().real` is still the admin; it switches itself off if the real user isn't the admin), a yellow band sits on top of every page, and every write in `src/data.js` starts with `ro()`, which throws "Read-only while viewing as …". Nothing reaches the database, so the person can't tell. Add `ro()` to any new write function. It all hangs on `ON` in `src/viewas.js`: set it to false, or delete that file, its imports, admin.html and src/admin.js, to take it out.

## Conventions

- Match the existing style in `app.js`: `var`, function declarations, string-built HTML, `esc()` on every user-provided string that goes into markup or attributes.
- UI copy is plain, sentence case, and speaks from the user's side ("Send a take", "Let it in"). Errors say what happened and what to do.
- Keep the visual design as is unless asked. The theme is **Soft Signal**: black is for actions (the main button of a block, `.btn-main`, `--action`), green is for sound (play buttons, progress, the playhead, waveforms that are playing, what's in the song, player wells: `--sound`, `--sound-ink` for green text, `--sound-soft` for tints; `.btn-sound` for "Play the song"). Keep that split when adding UI: a new action is black, anything you hear is green. Colours are CSS custom properties on `:root`, in `src/styles.css` (song view, /songs) and again in the inline styles of `index.html` and `privacy.html` (and the gate in `functions/_middleware.js`); change them together. The page is off-white (`--bg` `#FAF9F6`) with white cards (`--paper`), hairline borders (`--line`, `--line-strong`), `--radius` 18px for cards, 12px for inputs, pills (99px) for buttons and tabs, and a soft `--shadow`. Waiting and warnings use `--wait-bg` / `--wait-ink`, new parts and mixes `--part`, recording `--live`, errors `--red`. The original track's icon is ink (`--seed`). No instrument colour is the brand green (bass is blue, vocals olive). The fonts are Bricolage Grotesque (headings and big numbers; `--disp`, h1/h2/h3 at weight 800, never all caps; a variable font with optical sizes 12–96 and weights 500–800) and Figtree (everything else, buttons and labels included; no uppercase labels). They are self-hosted in `public/fonts/` (`fonts.css`, variable woff2 files subset to latin and latin-ext from github.com/google/fonts, their OFL licences), so pages make no requests to Google for them; every page and the access gate link `/fonts/fonts.css`, and `functions/_middleware.js` lets `/fonts/` through without the cookie. Small tags keep the body font even inside headings.
- Layouts follow the Soft Signal mocks (design B): the homepage is a hero card, then the feed in one column as wide as the hero, then the dark "Start a jam" band (text left, instruments and buttons right from 760px). The "Start a jam" buttons at the top and every link to `#start` (also `/#start` from other pages) open the same band in a pop-up (`#start-scrim`, cloned from `#start` by home.js; both instrument rows set the same choice); there is no sidebar. A jam's thread bar is a warm grey band with a dark grey "Show the thread" pill (never green: green is for sound). The song view has the breadcrumbs and phase toggle in its header, the title with the facts as tiles next to the original track's card, a folded "How it works", the mixer, then the thread next to a sidebar card. /songs is a grid of cards. Every page ends with the same footer.
- Left out on purpose, don't bring back without asking: the prototype-only controls ("Signals", "View as", "Empty the session", the fake "Let the line-up vote" button), the concept's "Add your instrument" band, and the voting UI.
- The product is called **Stakkato** (formerly Stackato). Its logos are `public/stakkato-logo.svg` and `public/stakkato-logo-on-dark.svg` (1441×311; the K and the bars are the brand green `#1F6F5C`), the favicon `public/favicon.svg` (a green circle with a white K); every header carries both as `img.logo` (the dark one also `.on-dark`) and `src/dark.css` shows the one for the theme. Internal ids keep the old spelling on purpose (the `stackato:*` storage keys, the access cookie and its hash prefix), so settings and gate passes survive the rename.
- Per-browser settings live in local storage under `stackato:*`: `stackato:theme`, `stackato:mic` (input), `stackato:amp` (the amp picked for recording; only offered for guitar, lead and bass, `AMP_ROLES` in app.js) and `stackato:monitor` ("Hear yourself"); the name for the credits under `riffraff:name`.
- The song view's breadcrumbs lead back to the jam's thread on the homepage, at the take whose stack was open.
- Stem downloads (a store-only zip, `src/zip.js`) include a session sheet: each file's start time, fades and amp (the files themselves are dry).
- Dark mode: `<html data-theme="dark">` (set before first paint by a small inline script in each page's head; the choice is remembered under `stackato:theme`, otherwise the device setting wins). `src/dark.css` redefines the tokens; a colour written out instead of a token needs a dark override there. The dark bands (`.startband`, `.owncta`, `.how-lead`, `.cm-pop`, ...) bring the light-mode paper/ink back inside, so they look the same in both modes; inside them the main button turns white and the greens lighter (the band rule right after `:root` in `styles.css` and `index.html`). Canvases redraw on the `stackato:theme` event.
- New database changes go in a new, timestamped file in `supabase/migrations/`. Never edit a migration that has already been applied.

## UI vocabulary

The code says seed, host and line-up; the UI says **original track**, **creator** and **the stack**. Keep the copy in the UI's words, and use these terms the same way everywhere (buttons, tooltips, messages, empty states):

- **Layer**: a role in the song (drums, bass, vocals...). In the code that is a role.
- **Take**: one concrete recording by a musician for a layer.
- **Stack**: the chosen takes that together form the song (the line-up). "Takes to review" are the waiting ones; "Unused takes" are archived ones.
- **Version**: someone's own combination of the available takes.
- **Mix**: a finished, mixed recording of the stack, uploaded after release (`role_id = 'mix'`).
- **Release**: publishing the end result (closing the session, `status = 'released'`).
- **Project**: the song view at `/s/<slug>`, where all the takes of one jam are played and mixed. Buttons that lead there say "Open the project" (on a jam), "Show in the project" (on a take) and "Record in the project". Don't call it the mix view, the song view or the DAW in the UI; "Mix" is the finished recording after release.

Layout rule: one main (black) action per block. Secondary actions on a take (play on its own, download, delete, take out) live in its "⋯" menu (`menuBtn()` / `mi()` in app.js); a take's play button does the most useful thing for its block (in the mix for takes to review, with the original track in the own-version block). Messages show as a toast (`flash()`).

## Testing

There's no automated test suite yet. What earlier changes were checked with, and works in a cloud session:

- `npm run build` must pass (Cloudflare Pages runs the same).
- Headless Chromium through Playwright (installed globally; `PLAYWRIGHT_BROWSERS_PATH` is set) against `npm run dev` or `npx vite preview`. Without `.env.local` the pages load but can't reach Supabase; earlier PRs drove the UI against an in-memory stand-in for `data.js` / Supabase.
- Audio code (amps, recording maths) can be checked offline in Chromium with an `OfflineAudioContext`: render a synthetic signal and look at levels, NaNs and spectra.
- Egress: with every take given peaks in the stand-in, count `/storage/v1/object/` requests on the homepage, a profile and /songs: none on load, one per take that plays when you press play. A take without peaks still shows its waveform (loaded from its audio). Inserts from the homepage (reply, "Start a jam") and the project all carry `peaks`.
- The backfill can be run against a small local Node stand-in for PostgREST and Storage (`SUPABASE_URL=http://localhost:<port>`): `--dry-run` writes nothing, a second run finds nothing to do.
- Database permissions: try the RPCs as real users inside rolled-back transactions (`begin; set local role authenticated; set local request.jwt.claims = '...'; ... rollback;`).

Before shipping a change, run through this with two browsers (or a normal and a private window, which get different anonymous users):

1. Browser A: load a seed with a name (or "Record right here": a pop-up with name, instrument, tempo, time, count-in and click, records until you stop, then "Start the session"; the session gets the tempo/time it was recorded at). Nothing starts until name and instrument are filled in. URL changes to `/s/<slug>`; tempo/key show up.
2. Browser B: open the link. B sees "<name>'s track", no host controls, and can send a take. A take of the wrong length is rejected.
3. A sees B's take appear under "Takes to review" without reloading, presses "Add to song", and it shows in the tracks for both.
4. A third user sends a take for the same or another role; A presses its play button to hear it in the mix and adds it to the song or vetoes it (there is no voting in the UI).
5. Someone builds and saves a version; others can play, like and fork it. In their version, B records or uploads a take of their own (it goes straight in, nobody approves it), then sends it to the creator from the picker; A sees it waiting. Stopping a recording early and keeping it gives a full-length take that is silent after the stop. A renames the project in the field above the original track and B sees the new name. B replies with words under a take in the thread (and under A's reply to that); A sees it nest there and on the homepage, and can hide it. B clicks the comment strip under the ruler, posts a comment; A sees the dot, it opens while the song plays past it, and A can hide it.
6. B makes the song longer with the + on the song's edge (one file, or up to four with an instrument each); it shows in the thread right away, and C plays on it before A decides; A hears it in place, adds it to the song (B's tracks come along), sets a crossfade and drags a fade handle; B sees the song get longer and can layer on that part (also on the grey track, with "On <name>'s new part" picked). "Play the whole song" on the part's post plays from the top, in the project and on the homepage. Recording in the page works both in the pop-up and on the grey track at the bottom of the DAW (for guitar, lead or bass, pick an amp and tick "Hear yourself" to play a DI through it; the take shows the amp tag and A hears it too; FX on a track switches amps, in a version only for that version) (the playhead runs over the other tracks and the take is drawn as it comes in; "Add my take →" / "Add it to my version" opens the pop-up with the take loaded; before that, Play/Pause hears the take with the rest and clicking or dragging on its waveform plays it from that moment), and the click-track download under "Play along" works.
7. A deletes a take (⋯ menu, then "Delete this take" twice); it disappears for everyone.
8. While a stack plays (on the homepage or in the project's thread), every take in it shows as playing, and pressing any of them pauses the whole stack. B pitches a new part with the original track and a take ticked under "Keep playing on the new part" and no file: the creator keeps it, and the song plays the original track and that take again in the part.
9. On the homepage, "Play along" (on a jam, or on a take) opens the reply pop-up: pick "Upload a file" or "Record here", pick a layer and, for guitar, lead or bass, an amp; record with the count-in and click ("Hear yourself" plays the input through the amp), then "Hear it with the lanes" and "Post my reply". The take is exactly as long as what it plays on, and the amp is saved on the take. Check that this and the recording in the project still agree (both use `src/rec.js`).
10. A presses "Release the song"; everyone moves to the release view; a Mix can be uploaded; reactions count once per person.

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

- The project (`/s/<slug>`) downloads and decodes every take's full audio. Fine for a handful of takes; long sessions with many large WAVs will get heavy. Compressed previews or streaming would fix it. The homepage, profiles and /songs download nothing until play (waveforms come from `takes.peaks`), except for takes without peaks: run `scripts/backfill-peaks.mjs` after deploying (instructions in its header). Each take adds about 2.7 KB to the snapshot.
- The backfill decodes with ffmpeg, the browser with its own decoder. wav and mp3 come out the same; for ogg vorbis Chromium keeps the encoder's few ms of pre-skip, so the backfilled waveform can sit a few milliseconds off.
- If an upload succeeds but the row insert fails, the file stays in Storage as an orphan.
- No cookie consent yet. Cloudflare Web Analytics sets no cookies, but most tags added in Google Tag Manager (GA4, ads pixels) do, and in the EU (Belgium) those need consent before they run: add a consent banner with Google Consent Mode before adding such tags. The /privacy cookies section still says there is no tracking and no banner; update it with the analytics setup.
- Anonymous sign-ins can be abused; turn on CAPTCHA (Supabase Auth settings) before promoting the app publicly.
- Every session is listed at `/songs`, and anyone can read it and its audio. There's no private-session mode.
- The host can replace the seed with a different length after takes exist; nothing stops that.
- Deleted takes keep their audio in Storage (public URL still works).
- Amps: three fixed presets, no knobs. Every listener's browser renders each amped take itself after loading it (a NAM WaveNet runs at roughly 0.1 to 0.6x real time depending on the machine, one render at a time), so a session with many long amped takes takes a while before every guitar sounds; renders aren't stored anywhere. The captures run at 48 kHz; a live amp in a 44.1 kHz context is resampled (linear) and 128 samples late, so the recorder shows a tip to set the interface to 48 kHz (`rateTip()`). Both pages open their AudioContext through `newContext()` in `src/rec.js` with `latencyHint: 0` (the smallest buffer the device allows; in Chromium the base latency went from 10 ms to 2.9 ms); the sample rate stays the device's own. "Hear yourself" arms the input (`armMonitor()` in `src/rec.js`): ticking it opens the input right away and you hear yourself through the amp before and while you record, until you untick it (the reply pop-up also disarms when it closes). It monitors through the browser, so it is a few tens of milliseconds late; direct monitoring on the interface is tighter (and then leave it off). The amp files are GPL v3 (captures) and CC BY 4.0 (cabinets, room): keep `public/amps/CREDITS.md` and the credits on /privacy when changing them.
- Recording in the page (the project and the homepage's reply pop-up, both through `src/rec.js`) captures with an `AudioWorklet` (falls back to `ScriptProcessorNode` where there is none) and stitches the blocks back to back; it needs headphones, and latency is compensated only by the browser's reported output latency. It records the first channel of the chosen input (the input picker is remembered per browser under `stackato:mic`; a browser only names the inputs once the page may use the microphone, so the reply pop-up has a "Show my inputs" link that asks once); on multi-channel interfaces that is often a dry DI channel, so a very quiet take shows a warning. If the click gets into a recording (speakers, or an interface that sends the computer's playback back into the recorded channel), `findClick()` finds it on the count-in bars, lines the take up by it and subtracts it; without a count-in it isn't detected. Other backing tracks that leak in the same way are not taken out, only warned about. A take of free length (the original track recorded in the page, a new part) is cut to the last bar with sound in it (40 dB under its peak), so the wait before pressing stop doesn't end up in the song.

# CLAUDE.md

Context for Claude Code (and humans) working in this repo.

## What this is

Riffraff is a collaborative jam: a host drops a **seed** track (a riff, groove or vocal), anyone with the session link sends **takes** (one instrument each, exactly the seed's length), the host lets takes into the **line-up** or vetoes them, and people already in the line-up vote to steer the host. Anyone can build and save their own **version** from every take, including vetoed ones. The host eventually **closes** the session, which releases it; after that anyone can attach a mixed version.

It started life as a single-file Claude artifact (an in-memory prototype with a fake "let the line-up vote" button). This repo is the hosted version: same UI and audio engine, real persistence, real multi-user sessions.

## Stack

- **Frontend:** plain JavaScript (ES modules, no framework), bundled by **Vite**. The UI renders HTML strings into containers; there is no virtual DOM.
- **Backend:** **Supabase** (Postgres + Row Level Security, Storage for audio, Realtime for live updates, Auth with anonymous sign-ins). There is no server code of our own.
- **Hosting:** **Vercel**, static build from `dist/`. `vercel.json` rewrites `/s/:slug` to `index.html`.
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

- `sessions`: one per song. `host_id` is the user who created it (and dropped the seed). `status` is `open` or `released`. Tempo/key/time live here (`bpm`, `music_key`, `key_alt`, `time_sig`, `meta_from`, `meta_sure`). `seed_role` is the instrument the host says the seed is (null = not one instrument). The seed takes one slot in that role (`role_cap()`), so a 1-slot role the seed plays can't get takes into the line-up; changing `seed_role` bumps the oldest takes if the role overflows (trigger), and is refused once the session is closed. `seed_take_id` points at the current seed; replaced seeds stay in `takes` but are ignored.
- `takes`: every piece of audio. `role_id` is `seed`, `mix` or an instrument id. `status` is `seed | waiting | in | archived | mix`. `joined_at` orders the line-up (the oldest take in a full role is the one that gets pushed out). Audio lives in Storage at `storage_path`.
- `votes`: `(take_id, voter_id)` → `up | down`. Only people with a take in the line-up can vote, and not on the take that would replace their own.
- `versions`: a fan version is just `picks` (take ids) plus `ctl` (per-take vol/mute/solo and `hp`/`lp` filter cutoffs in Hz, keyed by take id, with the seed under the key `"seed"`). No audio is copied.
- `version_likes`, `reactions`: one row per person, never deleted.
- `roles`: slot counts per instrument. **Authoritative for slots.**

Storage bucket `takes` is public-read. Upload path: `{session_id}/{user_id}/{uuid}.{ext}`, 50 MB per file, `audio/*` only.

## Rules that are easy to break

- **Permissions live in the database.** RLS policies and the `let_in()` / `veto()` / `can_vote()` functions enforce who can do what. The UI hides buttons for convenience, but never rely on UI checks for security. If you add a write, add a policy.
- **Host-only status changes go through RPCs.** There is deliberately no UPDATE policy on `takes`. Letting in, vetoing and bumping happen in `let_in()` / `veto()` so slot rules are atomic.
- **Nothing is deleted.** Realtime `postgres_changes` can't filter DELETE events by column, so the app avoids deletes entirely (votes are upserted, likes and reactions are permanent). If you add deletes, the subscription in `data.js` needs rethinking.
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

## Testing

There's no automated test suite yet. Before shipping a change, run through this with two browsers (or a normal and a private window, which get different anonymous users):

1. Browser A: load a seed with a name. URL changes to `/s/<slug>`; tempo/key show up.
2. Browser B: open the link. B sees "<name>'s track", no host controls, and can send a take. A take of the wrong length is rejected.
3. A sees B's take appear without reloading, lets it in, and it shows in the line-up for both.
4. A third user sends a take for the same or another role; B (now in the line-up) sees For/Against buttons and votes; A sees the tally.
5. Someone builds and saves a version; others can play, like and fork it.
6. A closes the session; everyone moves to the release view; a mix can be uploaded; reactions count once per person.

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
- Anyone with the link can read the session and its audio. There's no private-session mode.
- The host can replace the seed with a different length after takes exist; nothing stops that.

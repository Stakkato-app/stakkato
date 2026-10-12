# Stakkato

Make a song with strangers. One person drops a seed track, anyone with the link sends a take on top of it, the seed's owner decides who joins, and everyone can build their own version from every take.

Built with Vite and plain JavaScript, backed by Supabase (database, audio storage, realtime, anonymous auth), hosted on Cloudflare Pages.

## How it works

1. **Drop a seed.** Loading a seed creates a session and gives you a link. You're the host.
2. **Share the link.** Anyone who opens it can send one take per instrument, matching the seed's length.
3. **Let takes in or veto them.** Only the host decides. People already in the line-up vote to steer that call.
4. **Build versions.** Anyone can pick any takes (including vetoed ones) and save their own version. Only the choice of takes and levels is stored.
5. **Close the session.** It releases as it stands. After that anyone can attach a mixed version.

Everything updates live for everyone on the page.

## Setup

You need Node 20.19+ and a free [Supabase](https://supabase.com) account.

### 1. Create the Supabase project

1. Create a new project in the Supabase dashboard.
2. Under **Authentication**, in the sign-in providers settings, turn on **Allow anonymous sign-ins**. Every visitor gets an anonymous user, which can later be upgraded to a real account.
3. Create the schema. Either paste every file in `supabase/migrations/` into the **SQL Editor**, oldest first, and run them, or use the CLI:

   ```bash
   npx supabase login
   npx supabase init            # only if supabase/config.toml doesn't exist yet
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push
   ```

   This creates the tables, security policies, the `takes` storage bucket (public read, 50 MB per file, audio only) and enables realtime.
4. Copy the **project URL** and the **anon / publishable key** (Project Settings, API, or the **Connect** button). Both are safe to expose in the browser. Do not use the service role key anywhere in this app.

### 2. Run it locally

```bash
cp .env.example .env.local     # then fill in the two values
npm install
npm run dev
```

Open http://localhost:5173. To test as several people, use a normal window and a private window: each gets its own anonymous user.

### 3. Put it on GitHub

```bash
git init
git add .
git commit -m "Riffraff: hosted version with Supabase"
git branch -M main
git remote add origin https://github.com/<you>/riffraff.git
git push -u origin main
```

(Or, with the GitHub CLI: `gh repo create riffraff --private --source=. --push`.)

### 4. Deploy on Cloudflare Pages

1. In the Cloudflare dashboard, **Workers & Pages, Create, Pages, Connect to Git**, and pick the GitHub repo. Framework preset **Vite** (build command `npm run build`, output directory `dist`), root directory left empty so Cloudflare finds `functions/`. The Node version comes from `.node-version`.
2. Under **Settings, Variables and Secrets**, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (or `VITE_SUPABASE_PUBLISHABLE_KEY`) for Production and Preview. Vite builds them into the pages, so redeploy after changing them.
3. Deploy. Every push to `main` redeploys production; every other branch gets a preview at `https://<branch>.<project>.pages.dev`.
4. In Supabase, under **Authentication, URL Configuration**, set the Site URL to your domain. Anonymous sign-in doesn't need it, but email or OAuth login will.

## Access gate

Until it's public, every page asks for an access password first (`functions/_middleware.js`, a Cloudflare Pages Function). Set it in the Pages project under **Settings, Variables and Secrets** as `ACCESS_PASSWORD` (type Secret), for Production and Preview, and redeploy; until then the gate accepts the password we gave friends (stored in `functions/_middleware.js` only as a hash). Changing it sends everyone back to the gate. Local `npm run dev` is not gated.

## Accounts

Signing in is optional: anyone can comment, vote and play along anonymously. Accounts sign in with email and password on the homepage. There's no sign-up yet; make an account in the Supabase dashboard (**Authentication, Users, Add user**, with auto-confirm) and put the display name in its user metadata as `{"username": "..."}`.

## Before sharing it widely

- Turn on CAPTCHA protection for sign-ins in Supabase Auth settings, since anyone can create anonymous users.
- Keep an eye on Storage usage. Every take is kept, and WAV files are large.
- Sessions are public: every song is listed at `/songs`, and anyone can listen and download.

## Project structure

See [CLAUDE.md](./CLAUDE.md) for the architecture, data model, the rules that keep permissions and realtime working, and a manual test checklist.

## Credits

Design and original prototype by <!-- your friend's name -->, first built as a Claude artifact.

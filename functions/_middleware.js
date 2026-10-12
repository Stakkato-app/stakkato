/* Access gate and pretty routes (a Cloudflare Pages Function: _middleware.js at the root
   of functions/ runs before every request on Cloudflare Pages, pages and files alike).

   While Stakkato is only for friends, every page and file needs the access password
   first. Set it in the ACCESS_PASSWORD environment variable of the Pages project.
   Until that is set, the gate accepts the password we hand out to friends, which is
   kept here only as a hash (DEFAULT_TOKEN). Entering the password sets an HttpOnly
   cookie holding that hash, so changing the password signs everyone out of the gate.

   Once in, /new and /s/<slug> are served the song view (session.html); Cloudflare serves
   /songs and /privacy from songs.html and privacy.html by itself, and sends /session.html
   to /session, so the song view is fetched as /session.

   This runs on Cloudflare's servers; none of it reaches the browser. `npm run dev` /
   `preview` don't run this file (vite.config.js does the same routes there), so local
   development is not gated. The audio itself lives in Supabase Storage, which this gate
   doesn't cover. */

const COOKIE = 'stackato_access';
const GATE_PATH = '/__access';
const OPEN = ['/stakkato-logo.svg', '/favicon.svg'];   /* the gate page itself shows these */
const OPEN_DIRS = ['/fonts/'];                          /* and its fonts (public/fonts) */
const SONG_VIEW = /^\/(new|s\/[\w-]+)\/?$/;              /* paths answered by session.html */
const MAX_AGE = 60 * 60 * 24 * 30;                      /* 30 days */
/* tokenFor() of the friends' password, used while ACCESS_PASSWORD isn't set */
const DEFAULT_TOKEN = 'e46f9f2844ccd65da134600e3cdb010329779b507eff22f15b8027744ffa6907';

async function tokenFor(password) {
  const bytes = new TextEncoder().encode('stackato-access:' + password);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function cookieOf(request, name) {
  const all = request.headers.get('cookie') || '';
  for (const part of all.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/* only same-site paths, so the form can't be used to bounce people elsewhere */
function safeNext(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.startsWith(GATE_PATH) ? value : '/';
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function gatePage(next, error, status) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Stakkato</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/fonts/fonts.css">
<style>
:root{--bg:#FAF9F6;--paper:#FFFFFF;--ink:#121212;--muted:#5C5A55;--line:#E6E4DE;--line-strong:#D9D6CE;--red:#C7322A;color-scheme:light}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:var(--bg);color:var(--ink);font:16px/1.5 'Figtree',system-ui,sans-serif}
main{width:min(420px,100%);display:grid;gap:18px}
img{height:30px;width:auto}
h1{margin:0;font:700 26px/1.1 'Unbounded',system-ui,sans-serif;letter-spacing:-.02em}
p{margin:0;color:var(--muted)}
form{display:grid;gap:10px;border:1px solid var(--line);border-radius:18px;padding:20px;background:var(--paper);box-shadow:0 1px 2px rgba(18,18,18,.04),0 14px 34px -20px rgba(18,18,18,.22)}
label{font-size:13.5px;font-weight:700}
input{font:inherit;min-height:44px;border:1px solid var(--line-strong);border-radius:12px;background:var(--paper);padding:8px 12px;color:inherit}
input:focus{outline:none;border-color:var(--ink)}
button{font:inherit;font-weight:700;min-height:44px;border:1px solid #121212;border-radius:99px;background:#121212;color:#FFFFFF;cursor:pointer}
button:hover{background:#2E2E2E}
.err{color:var(--red);font-size:14px;font-weight:600}
</style>
</head>
<body>
<main>
  <img src="/stakkato-logo.svg" alt="Stakkato" width="1441" height="311">
  <h1>Not open to everyone yet</h1>
  <p>Stakkato is in a test with friends. Fill in the access password you got from us to come in.</p>
  <form method="post" action="${GATE_PATH}">
    <input type="hidden" name="next" value="${esc(next)}">
    <label for="pw">Access password</label>
    <input type="password" id="pw" name="password" autocomplete="current-password" required autofocus>
    ${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
    <button type="submit">Come in</button>
  </form>
</main>
</body>
</html>`;
  return new Response(html, {
    status: status || 401,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' }
  });
}

/* let the request through to the site, serving the song view for its paths */
function pass(context, url) {
  if (SONG_VIEW.test(url.pathname)) return context.env.ASSETS.fetch(new Request(new URL('/session' + url.search, url), context.request));
  return context.next();
}

export async function onRequest(context) {
  const request = context.request;
  const url = new URL(request.url);
  const password = context.env.ACCESS_PASSWORD;
  const token = password ? await tokenFor(password) : DEFAULT_TOKEN;

  if (url.pathname === GATE_PATH) {
    if (request.method !== 'POST') return Response.redirect(new URL('/', url), 303);
    let form;
    try { form = await request.formData(); } catch (e) { form = new FormData(); }
    const next = safeNext(form.get('next'));
    if ((await tokenFor(String(form.get('password') || ''))) !== token) {
      return gatePage(next, 'That isn’t the access password. Check it and try again.', 401);
    }
    return new Response(null, {
      status: 303,
      headers: {
        location: next,
        'set-cookie': `${COOKIE}=${token}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
        'cache-control': 'no-store'
      }
    });
  }

  if (OPEN.includes(url.pathname) || OPEN_DIRS.some((d) => url.pathname.startsWith(d)) || cookieOf(request, COOKIE) === token) return pass(context, url);

  /* files (scripts, styles, audio) get a plain 401; pages get the gate */
  const wantsPage = request.method === 'GET' && (request.headers.get('accept') || '').includes('text/html');
  if (!wantsPage) return new Response('Access password required.', { status: 401, headers: { 'cache-control': 'no-store' } });
  return gatePage(safeNext(url.pathname + url.search), null, 401);
}

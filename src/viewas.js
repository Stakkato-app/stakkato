/* "View as" (temporary, for the admin): the site renders as someone else, read-only.

   It lives in this tab only (sessionStorage), and only counts while the admin is signed in:
   src/auth.js hands the pages that person as the signed-in user, src/data.js refuses every
   write while it's on, and the header shows the yellow band. Nothing reaches the database,
   so the person never sees that anyone looked. To take it out: set ON to false, or delete
   this file, its imports and admin.html. */

export var ON = true;

var KEY = 'stackato:viewas';

/* { id, name, email, providers } of the person, or null */
export function viewing() {
  if (!ON) return null;
  try { var v = JSON.parse(sessionStorage.getItem(KEY) || 'null'); return v && v.id ? v : null; } catch (e) { return null; }
}

export function startViewing(p) {
  try { sessionStorage.setItem(KEY, JSON.stringify({ id: p.id, name: p.name || null, email: p.email || '', providers: p.providers || [] })); } catch (e) {}
}

export function stopViewing() {
  try { sessionStorage.removeItem(KEY); } catch (e) {}
}

/* a stand-in for the person's auth user: enough for the pages (id, email, how they sign in), never admin */
export function asUser(v) {
  return {
    id: v.id, email: v.email, viewing: true, is_anonymous: false,
    app_metadata: {}, user_metadata: { username: v.name },
    identities: (v.providers || []).map(function (p) { return { provider: p }; })
  };
}

export function readOnlyText(v) {
  return 'Read-only while viewing as ' + ((v && v.name) || 'someone else') + '.';
}

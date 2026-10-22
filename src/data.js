/* Every Supabase call the app makes goes through this file.
   The UI (app.js) never touches the client directly, so swapping the backend or
   adding real accounts later only changes this layer. */

import { supabase, BUCKET } from './supabase.js';
import { viewing, readOnlyText } from './viewas.js';

/* while the admin views the site as someone else (src/viewas.js), nothing is written */
function ro() {
  var v = viewing();
  if (v) throw new Error(readOnlyText(v));
}

function check(res) {
  if (res.error) throw res.error;
  return res.data;
}

/* ---------- identity and accounts ----------
   Reading needs no user. Every write needs an account with a name (has_account() in the
   database), so nothing signs in anonymously any more. Accounts sign up with email and
   password (the email link confirms them) or with Google; a Google account picks its name
   once, afterwards. The name lives in profiles, never in the browser. */

/* the signed-in account, or null; an old anonymous session counts as signed out */
export async function ensureUser() {
  const { data } = await supabase.auth.getSession();
  const user = data.session ? data.session.user : null;
  return user && !user.is_anonymous ? user : null;
}
export const currentUser = ensureUser;

var NAMES = {};   // user id -> profile name, filled by loadProfile()

export async function loadProfile(user) {
  if (!user || user.is_anonymous) return null;
  const res = await supabase.from('profiles').select('username').eq('id', user.id).maybeSingle();
  if (res.error) throw res.error;
  NAMES[user.id] = (res.data && res.data.username) || null;
  return NAMES[user.id];
}

/* the name an account shows up with; null for anonymous users and before a Google account picked one */
export function accountName(user) {
  if (!user || user.is_anonymous) return null;
  if (user.id in NAMES) return NAMES[user.id];
  return (user.user_metadata || {}).username || null;
}

/* an admin can delete anyone's jams, takes and comments (role set server-side in app_metadata) */
export function isAdmin(user) {
  return !!(user && user.app_metadata && user.app_metadata.role === 'admin');
}

/* the admin's list of accounts (admin_accounts() refuses everyone else); the only place emails leave the database */
export async function adminAccounts() {
  return check(await supabase.rpc('admin_accounts'));
}

/* where the links in our emails send people back to (the gate checks them at /auth/confirm) */
function home() { return location.origin; }

export async function signUp(email, password, username) {
  ro();
  const res = await supabase.auth.signUp({ email, password, options: { data: { username }, emailRedirectTo: home() } });
  if (res.error) throw res.error;
  return res.data;
}

export async function signInWithEmail(email, password) {
  const res = await supabase.auth.signInWithPassword({ email, password });
  if (res.error) throw res.error;
  return res.data.user;
}

/* comes back to this page (without its #) signed in */
export async function signInWithGoogle() {
  const res = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.href.split('#')[0] } });
  if (res.error) throw res.error;
}

export async function resendConfirmation(email) {
  ro();
  const res = await supabase.auth.resend({ type: 'signup', email, options: { emailRedirectTo: home() } });
  if (res.error) throw res.error;
}

export async function requestReset(email) {
  ro();
  const res = await supabase.auth.resetPasswordForEmail(email, { redirectTo: home() });
  if (res.error) throw res.error;
}

export async function updatePassword(password) {
  ro();
  const res = await supabase.auth.updateUser({ password });
  if (res.error) throw res.error;
}

/* an email link opened where the gate couldn't check it (npm run dev) */
export async function verifyLink(tokenHash, type) {
  const res = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
  if (res.error) throw res.error;
  return res.data.user;
}

/* { ok, reason: invalid | reserved | taken, suggestions: [...] } */
export async function usernameCheck(name, hints) {
  return check(await supabase.rpc('username_check', { p_name: name, p_hints: hints || [] }));
}

export async function pickUsername(name) {
  ro();
  const picked = check(await supabase.rpc('pick_username', { p_name: name }));
  const { data } = await supabase.auth.getSession();
  if (data.session) NAMES[data.session.user.id] = picked;
  return picked;
}

/* Settings: the current password is checked by signing in with it again (same account,
   so nothing changes in the page), then the new one is set */
export async function changePassword(email, current, next) {
  ro();
  const res = await supabase.auth.signInWithPassword({ email, password: current });
  if (res.error) throw res.error;
  await updatePassword(next);
}

export async function signOut() {
  const res = await supabase.auth.signOut();
  if (res.error) throw res.error;
}

export function onAuthChange(fn) {
  return supabase.auth.onAuthStateChange(function (event, session) { fn(session ? session.user : null, event); });
}

/* ---------- profiles ----------
   Profiles are readable by everyone, so /u/<name> needs no account. Names link to a
   profile through the author's id, never the name copied on a row: anonymous users have
   no profile, so an old anonymous name that happens to match a real one doesn't link. */

/* ilike without wildcards: names may hold _ */
function exactly(s) { return String(s).replace(/[\\%_]/g, '\\$&'); }

/* the profile for /u/<name>, ignoring case; null when nobody plays under that name */
export async function profileByName(name) {
  return check(await supabase.from('profiles').select('id, username, created_at')
    .ilike('username', exactly(name)).not('username', 'is', null).maybeSingle());
}

/* { user id: name } for the ids that belong to an account with a name */
export async function profilesFor(ids) {
  var seen = {};
  ids = (ids || []).filter(function (id) {
    if (!id || seen[id] || !/^[0-9a-f-]{36}$/i.test(id)) return false;
    return (seen[id] = true);
  });
  if (!ids.length) return {};
  const rows = check(await supabase.from('profiles').select('id, username').in('id', ids).not('username', 'is', null));
  var out = {};
  rows.forEach(function (p) { out[p.id] = p.username; });
  return out;
}

const PROFILE_SESSION = 'id, slug, host_id, title, status, bpm, music_key, time_sig, seed_role, seed_take_id, created_at, released_at';

/* Everything a profile shows: the jams someone started, the takes they sent (deleted and
   own-version takes left out) and, for every jam either way, its original track, stack,
   takes to review and mixes. */
export async function loadPlayer(userId) {
  const [hosted, mine] = await Promise.all([
    supabase.from('sessions').select(PROFILE_SESSION).eq('host_id', userId)
      .is('deleted_at', null).not('seed_take_id', 'is', null).order('created_at', { ascending: false }),
    supabase.from('takes').select('id, session_id, role_id, status, section_id, created_at')
      .eq('author_id', userId).not('status', 'in', '(deleted,own)').order('created_at', { ascending: false })
  ]);
  const started = check(hosted), takes = check(mine);
  var own = {}; started.forEach(function (s) { own[s.id] = true; });
  var others = [];
  takes.forEach(function (t) { if (t.role_id !== 'seed' && !own[t.session_id] && others.indexOf(t.session_id) < 0) others.push(t.session_id); });
  const played = others.length ? check(await supabase.from('sessions').select(PROFILE_SESSION).in('id', others)
    .is('deleted_at', null).not('seed_take_id', 'is', null).order('created_at', { ascending: false })) : [];
  const ids = started.concat(played).map(function (s) { return s.id; });
  const stacks = ids.length ? check(await supabase.from('takes')
    .select('id, session_id, role_id, status, section_id, author_id, author_name, storage_path, amp, duration_sec, created_at')
    .in('session_id', ids).in('status', ['seed', 'in', 'waiting', 'mix'])) : [];
  return { started, played, takes, stacks };
}

/* ---------- reads ---------- */

export async function loadSessionBySlug(slug) {
  return check(await supabase.from('sessions').select('*').eq('slug', slug).is('deleted_at', null).maybeSingle());
}

export async function loadSessionById(id) {
  return check(await supabase.from('sessions').select('*').eq('id', id).single());
}

export async function loadSnapshot(sessionId) {
  const [takes, votes, versions, likes, reactions, comments, stackLikes, words, tvotes] = await Promise.all([
    supabase.from('takes').select('*').eq('session_id', sessionId).order('created_at'),
    supabase.from('votes').select('take_id, voter_id, value').eq('session_id', sessionId),
    supabase.from('versions').select('*').eq('session_id', sessionId).order('created_at'),
    supabase.from('version_likes').select('version_id, user_id').eq('session_id', sessionId),
    supabase.from('reactions').select('user_id, kind').eq('session_id', sessionId),
    supabase.from('comments').select('*').eq('session_id', sessionId).order('created_at'),
    supabase.from('stack_likes').select('stack_key, user_id').eq('session_id', sessionId),
    supabase.from('thread_comments').select('*').eq('session_id', sessionId).eq('hidden', false).order('created_at'),
    supabase.from('thread_votes').select('target_id, voter_id, value').eq('session_id', sessionId)
  ]);
  /* comments come from a later migration; until it is applied the page works without them */
  if (comments.error) console.warn('Timeline comments are not available:', comments.error.message);
  return {
    takes: check(takes),
    votes: check(votes),
    versions: check(versions),
    likes: check(likes),
    reactions: check(reactions),
    comments: comments.error ? null : comments.data,
    stackLikes: stackLikes.error ? [] : stackLikes.data,
    /* the thread's written replies and votes, shared with the homepage */
    words: words.error ? [] : words.data,
    tvotes: tvotes.error ? [] : tvotes.data
  };
}

/* Every song with an original track, newest first, for the songs page. `seed` is the
   current original track (who made it), `layers` counts takes in the project. */
export async function listSongs() {
  return check(await supabase.from('sessions')
    .select('slug, title, status, bpm, music_key, time_sig, seed_role, created_at, released_at,' +
      ' seed:takes!sessions_seed_take_fk(author_name),' +
      ' layers:takes!takes_session_id_fkey(count)')
    .not('seed_take_id', 'is', null)
    .is('deleted_at', null)
    .eq('layers.status', 'in')
    .order('created_at', { ascending: false }));
}

/* The homepage feed: recent sessions with an original track, every take on them, the
   written replies and the thread votes. Comments and votes come from a later migration;
   until it is applied the feed works without them. */
export async function loadFeed(limit) {
  const sessions = check(await supabase.from('sessions')
    .select('id, slug, host_id, title, status, bpm, music_key, time_sig, seed_role, seed_take_id, created_at, released_at')
    .not('seed_take_id', 'is', null)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(limit || 20));
  if (!sessions.length) return { sessions, takes: [], comments: [], votes: [] };
  const ids = sessions.map((s) => s.id);
  const [takes, comments, votes] = await Promise.all([
    supabase.from('takes').select('*').in('session_id', ids).order('created_at'),
    supabase.from('thread_comments').select('*').in('session_id', ids).eq('hidden', false).order('created_at'),
    supabase.from('thread_votes').select('target_id, voter_id, value').in('session_id', ids)
  ]);
  if (comments.error) console.warn('Thread comments are not available:', comments.error.message);
  if (votes.error) console.warn('Thread votes are not available:', votes.error.message);
  return {
    sessions,
    takes: check(takes),
    comments: comments.error ? [] : comments.data,
    votes: votes.error ? [] : votes.data
  };
}

/* Deleting from the homepage: your own (or anyone's, as admin). Replies stay. A deleted
   take's audio file is removed from Storage too; if that fails the take is still gone. */
export async function deleteJam(sessionId) {
  ro();
  return check(await supabase.rpc('delete_jam', { p_session: sessionId }));
}

export async function deleteThreadTake(takeId, storagePath) {
  ro();
  check(await supabase.rpc('delete_thread_take', { p_take: takeId }));
  if (storagePath) {
    const res = await supabase.storage.from(BUCKET).remove([storagePath]);
    if (res.error) console.warn('The audio file could not be removed:', res.error.message);
  }
}

export async function deleteThreadComment(commentId) {
  ro();
  return check(await supabase.rpc('delete_thread_comment', { p_comment: commentId }));
}

/* the creator hides a written reply in their jam's thread; the row stays */
export async function hideThreadComment(commentId) {
  ro();
  return check(await supabase.rpc('hide_thread_comment', { p_comment: commentId }));
}

export async function addThreadComment(row) {
  ro();
  return check(await supabase.from('thread_comments').insert(row).select().single());
}

/* value 1 = up, -1 = down, 0 = taken back (votes are upserted, never deleted) */
export async function voteInThread({ targetId, targetKind, sessionId, voterId, value }) {
  ro();
  return check(await supabase.from('thread_votes').upsert(
    { target_id: targetId, target_kind: targetKind, session_id: sessionId, voter_id: voterId, value, updated_at: new Date().toISOString() },
    { onConflict: 'target_id,voter_id' }
  ));
}

export function publicUrl(path) {
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

/* ---------- sessions ---------- */

export async function createSession(hostId) {
  ro();
  return check(await supabase.from('sessions').insert({ host_id: hostId }).select().single());
}

export async function updateSession(id, patch) {
  ro();
  return check(await supabase.from('sessions').update(patch).eq('id', id).select().single());
}

/* ---------- takes ---------- */

/* Uploads go straight from the browser to Supabase Storage, so file size is bounded
   by the bucket limit (50 MB), not by the hosting's request size. */
export async function uploadAudio(path, file, contentType) {
  ro();
  return check(await supabase.storage.from(BUCKET).upload(path, file, { contentType, upsert: false }));
}

export async function insertTake(row) {
  ro();
  return check(await supabase.from('takes').insert(row).select().single());
}

/* Status changes are host-only and run server-side so slot rules can't be bypassed. */
export async function letIn(takeId) {
  ro();
  return check(await supabase.rpc('let_in', { p_take: takeId }));
}

export async function veto(takeId) {
  ro();
  return check(await supabase.rpc('veto', { p_take: takeId }));
}

/* A kept new part goes back out of the song (it stays in the database as passed). */
export async function dropPart(takeId) {
  ro();
  return check(await supabase.rpc('drop_part', { p_take: takeId }));
}

/* Fades (and a new part's crossfade) are set by the host and heard by everyone. */
export async function setFades(takeId, { fadeIn, fadeOut, xfade }) {
  ro();
  return check(await supabase.rpc('set_fades', { p_take: takeId, p_in: fadeIn, p_out: fadeOut, p_xfade: xfade }));
}

/* The amp a take plays through (null = off). The creator, or the take's author while it
   waits or is their own; heard by everyone. The audio itself stays dry. */
export async function setAmp(takeId, amp) {
  ro();
  return check(await supabase.rpc('set_amp', { p_take: takeId, p_amp: amp }));
}

/* ---------- timeline comments ---------- */

export async function addComment(row) {
  ro();
  return check(await supabase.from('comments').insert(row).select().single());
}

/* The creator hides a comment; it stays in the table. */
export async function hideComment(commentId) {
  ro();
  return check(await supabase.rpc('hide_comment', { p_comment: commentId }));
}

/* The creator takes a layer out of the project; it goes to the archive, still usable in versions. */
export async function takeOutLayer(takeId) {
  ro();
  return check(await supabase.rpc('take_out_layer', { p_take: takeId }));
}

/* An own take (recorded for your own version) goes to the creator as a waiting take. */
export async function sendOwnTake(takeId) {
  ro();
  return check(await supabase.rpc('send_own_take', { p_take: takeId }));
}

/* "Deleting" marks the take as deleted; the row stays so realtime can report it. */
export async function deleteTake(takeId) {
  ro();
  return check(await supabase.rpc('delete_take', { p_take: takeId }));
}

export async function castVote({ takeId, sessionId, voterId, value }) {
  ro();
  return check(await supabase.from('votes').upsert(
    { take_id: takeId, session_id: sessionId, voter_id: voterId, value, updated_at: new Date().toISOString() },
    { onConflict: 'take_id,voter_id' }
  ));
}

/* ---------- versions, likes, reactions ---------- */

export async function saveVersion(row) {
  ro();
  return check(await supabase.from('versions').insert(row).select().single());
}

function ignoreDuplicate(res) {
  if (res.error && res.error.code === '23505') return null; // already liked / reacted
  return check(res);
}

export async function likeVersion({ versionId, sessionId, userId }) {
  ro();
  return ignoreDuplicate(await supabase.from('version_likes')
    .insert({ version_id: versionId, session_id: sessionId, user_id: userId }));
}

export async function likeStack({ stackKey, sessionId, userId }) {
  ro();
  return ignoreDuplicate(await supabase.from('stack_likes')
    .insert({ stack_key: stackKey, session_id: sessionId, user_id: userId }));
}

export async function react({ sessionId, userId, kind }) {
  ro();
  return ignoreDuplicate(await supabase.from('reactions')
    .insert({ session_id: sessionId, user_id: userId, kind }));
}

/* ---------- realtime ---------- */

/* Any change in this session triggers onChange. The app then refetches the whole
   snapshot, which keeps the client simple and always consistent with the database.
   Nothing is ever deleted (a deleted take is an UPDATE to status 'deleted'), so every
   event can be filtered by session. */
export function subscribe(sessionId, onChange) {
  const bySession = `session_id=eq.${sessionId}`;
  const channel = supabase.channel(`session:${sessionId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions', filter: `id=eq.${sessionId}` }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'takes', filter: bySession }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'votes', filter: bySession }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'versions', filter: bySession }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'version_likes', filter: bySession }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'reactions', filter: bySession }, onChange)
    .subscribe();
  /* comments on their own channel: if their migration isn't applied yet, the session's
     main channel keeps working */
  const notes = supabase.channel(`comments:${sessionId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'comments', filter: bySession }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'stack_likes', filter: bySession }, onChange)
    .subscribe();
  /* the thread's written replies and votes on a third channel: until the thread_realtime
     migration adds them to the realtime publication, the other two channels keep working */
  const words = supabase.channel(`words:${sessionId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'thread_comments', filter: bySession }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'thread_votes', filter: bySession }, onChange)
    .subscribe();
  return () => { supabase.removeChannel(channel); supabase.removeChannel(notes); supabase.removeChannel(words); };
}

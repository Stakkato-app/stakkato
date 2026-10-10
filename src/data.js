/* Every Supabase call the app makes goes through this file.
   The UI (app.js) never touches the client directly, so swapping the backend or
   adding real accounts later only changes this layer. */

import { supabase, BUCKET } from './supabase.js';

function check(res) {
  if (res.error) throw res.error;
  return res.data;
}

/* ---------- identity ---------- */

/* Everyone gets a Supabase user. First visit signs in anonymously; the id sticks in
   this browser. Later, real accounts can be linked onto the same user. */
export async function ensureUser() {
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session.user;
  const res = await supabase.auth.signInAnonymously();
  if (res.error) throw res.error;
  return res.data.user;
}

/* ---------- accounts ----------
   Signing in is optional: anonymous users can comment, vote and send takes. An account
   signs in with email and password (accounts are made by hand for now). Signing up and
   Google are stubbed in the UI until real support lands. */

export function currentUser() {
  return supabase.auth.getSession().then(function (r) { return r.data.session ? r.data.session.user : null; });
}

/* the name an account shows up with; null for anonymous users */
export function accountName(user) {
  if (!user || user.is_anonymous) return null;
  var m = user.user_metadata || {};
  return m.username || (user.email ? user.email.split('@')[0] : null);
}

/* an admin can delete anyone's jams, takes and comments (role set server-side in app_metadata) */
export function isAdmin(user) {
  return !!(user && user.app_metadata && user.app_metadata.role === 'admin');
}

export async function signInWithEmail(email, password) {
  const res = await supabase.auth.signInWithPassword({ email, password });
  if (res.error) throw res.error;
  return res.data.user;
}

export async function signOut() {
  const res = await supabase.auth.signOut();
  if (res.error) throw res.error;
}

export function onAuthChange(fn) {
  return supabase.auth.onAuthStateChange(function (event, session) { fn(session ? session.user : null, event); });
}

/* ---------- reads ---------- */

export async function loadSessionBySlug(slug) {
  return check(await supabase.from('sessions').select('*').eq('slug', slug).is('deleted_at', null).maybeSingle());
}

export async function loadSessionById(id) {
  return check(await supabase.from('sessions').select('*').eq('id', id).single());
}

export async function loadSnapshot(sessionId) {
  const [takes, votes, versions, likes, reactions, comments, stackLikes] = await Promise.all([
    supabase.from('takes').select('*').eq('session_id', sessionId).order('created_at'),
    supabase.from('votes').select('take_id, voter_id, value').eq('session_id', sessionId),
    supabase.from('versions').select('*').eq('session_id', sessionId).order('created_at'),
    supabase.from('version_likes').select('version_id, user_id').eq('session_id', sessionId),
    supabase.from('reactions').select('user_id, kind').eq('session_id', sessionId),
    supabase.from('comments').select('*').eq('session_id', sessionId).order('created_at'),
    supabase.from('stack_likes').select('stack_key, user_id').eq('session_id', sessionId)
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
    stackLikes: stackLikes.error ? [] : stackLikes.data
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
  return check(await supabase.rpc('delete_jam', { p_session: sessionId }));
}

export async function deleteThreadTake(takeId, storagePath) {
  check(await supabase.rpc('delete_thread_take', { p_take: takeId }));
  if (storagePath) {
    const res = await supabase.storage.from(BUCKET).remove([storagePath]);
    if (res.error) console.warn('The audio file could not be removed:', res.error.message);
  }
}

export async function deleteThreadComment(commentId) {
  return check(await supabase.rpc('delete_thread_comment', { p_comment: commentId }));
}

export async function addThreadComment(row) {
  return check(await supabase.from('thread_comments').insert(row).select().single());
}

/* value 1 = up, -1 = down, 0 = taken back (votes are upserted, never deleted) */
export async function voteInThread({ targetId, targetKind, sessionId, voterId, value }) {
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
  return check(await supabase.from('sessions').insert({ host_id: hostId }).select().single());
}

export async function updateSession(id, patch) {
  return check(await supabase.from('sessions').update(patch).eq('id', id).select().single());
}

/* ---------- takes ---------- */

/* Uploads go straight from the browser to Supabase Storage, so file size is bounded
   by the bucket limit (50 MB), not by Vercel's request size. */
export async function uploadAudio(path, file, contentType) {
  return check(await supabase.storage.from(BUCKET).upload(path, file, { contentType, upsert: false }));
}

export async function insertTake(row) {
  return check(await supabase.from('takes').insert(row).select().single());
}

/* Status changes are host-only and run server-side so slot rules can't be bypassed. */
export async function letIn(takeId) {
  return check(await supabase.rpc('let_in', { p_take: takeId }));
}

export async function veto(takeId) {
  return check(await supabase.rpc('veto', { p_take: takeId }));
}

/* A kept new part goes back out of the song (it stays in the database as passed). */
export async function dropPart(takeId) {
  return check(await supabase.rpc('drop_part', { p_take: takeId }));
}

/* Fades (and a new part's crossfade) are set by the host and heard by everyone. */
export async function setFades(takeId, { fadeIn, fadeOut, xfade }) {
  return check(await supabase.rpc('set_fades', { p_take: takeId, p_in: fadeIn, p_out: fadeOut, p_xfade: xfade }));
}

/* ---------- timeline comments ---------- */

export async function addComment(row) {
  return check(await supabase.from('comments').insert(row).select().single());
}

/* The creator hides a comment; it stays in the table. */
export async function hideComment(commentId) {
  return check(await supabase.rpc('hide_comment', { p_comment: commentId }));
}

/* The creator takes a layer out of the project; it goes to the archive, still usable in versions. */
export async function takeOutLayer(takeId) {
  return check(await supabase.rpc('take_out_layer', { p_take: takeId }));
}

/* An own take (recorded for your own version) goes to the creator as a waiting take. */
export async function sendOwnTake(takeId) {
  return check(await supabase.rpc('send_own_take', { p_take: takeId }));
}

/* "Deleting" marks the take as deleted; the row stays so realtime can report it. */
export async function deleteTake(takeId) {
  return check(await supabase.rpc('delete_take', { p_take: takeId }));
}

export async function castVote({ takeId, sessionId, voterId, value }) {
  return check(await supabase.from('votes').upsert(
    { take_id: takeId, session_id: sessionId, voter_id: voterId, value, updated_at: new Date().toISOString() },
    { onConflict: 'take_id,voter_id' }
  ));
}

/* ---------- versions, likes, reactions ---------- */

export async function saveVersion(row) {
  return check(await supabase.from('versions').insert(row).select().single());
}

function ignoreDuplicate(res) {
  if (res.error && res.error.code === '23505') return null; // already liked / reacted
  return check(res);
}

export async function likeVersion({ versionId, sessionId, userId }) {
  return ignoreDuplicate(await supabase.from('version_likes')
    .insert({ version_id: versionId, session_id: sessionId, user_id: userId }));
}

export async function likeStack({ stackKey, sessionId, userId }) {
  return ignoreDuplicate(await supabase.from('stack_likes')
    .insert({ stack_key: stackKey, session_id: sessionId, user_id: userId }));
}

export async function react({ sessionId, userId, kind }) {
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
  return () => { supabase.removeChannel(channel); supabase.removeChannel(notes); };
}

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

/* ---------- reads ---------- */

export async function loadSessionBySlug(slug) {
  return check(await supabase.from('sessions').select('*').eq('slug', slug).maybeSingle());
}

export async function loadSessionById(id) {
  return check(await supabase.from('sessions').select('*').eq('id', id).single());
}

export async function loadSnapshot(sessionId) {
  const [takes, votes, versions, likes, reactions] = await Promise.all([
    supabase.from('takes').select('*').eq('session_id', sessionId).order('created_at'),
    supabase.from('votes').select('take_id, voter_id, value').eq('session_id', sessionId),
    supabase.from('versions').select('*').eq('session_id', sessionId).order('created_at'),
    supabase.from('version_likes').select('version_id, user_id').eq('session_id', sessionId),
    supabase.from('reactions').select('user_id, kind').eq('session_id', sessionId)
  ]);
  return {
    takes: check(takes),
    votes: check(votes),
    versions: check(versions),
    likes: check(likes),
    reactions: check(reactions)
  };
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
  return () => supabase.removeChannel(channel);
}

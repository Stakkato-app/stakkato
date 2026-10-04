/* Riffraff, the floor.
   The UI, audio engine and rendering are carried over from the original artifact.
   What changed: state comes from Supabase (see data.js) instead of living only in memory,
   every visitor has an identity, the original track's owner is the creator (host), and
   the project votes for real.

   Shape of the code:
   - S holds UI state plus the latest snapshot of the session.
   - TAKES caches take objects by database id, so decoded audio and mixer settings survive refreshes.
   - refresh() refetches the snapshot; realtime events call it (debounced).
   - render() redraws from S. Nothing renders from the database directly.

   The song, left to right: kept new parts before, the original track (the seed) with its
   layers, kept new parts after. Layers can also sit on a kept part; t.sec is that part's
   id, or null for the original track. arrangement() works out where everything starts. */

import './styles.css';
import { configured } from './supabase.js';
import * as db from './data.js';
import { analyse, sureness, PCS } from './analysis.js';
import { ico } from './icons.js';
import { zip } from './zip.js';
import { ROLES, role, col, cvar } from './roles.js';

var TOL = 0.6;           // seconds a layer may differ from the length of its section
var NAME_KEY = 'riffraff:name';

/* ---------- small helpers ---------- */
function vizMarkup(n) {
  var out = '';
  for (var i = 0; i < n; i++) out += '<i style="height:14%"></i>';
  return out;
}
function statics(n) {
  var out = '';
  for (var i = 0; i < n; i++) out += '<i style="height:' + ((Math.random()*80+15)|0) + '%"></i>';
  return out;
}
function fmt(sec){ sec = Math.round(sec || 0); return Math.floor(sec/60) + ':' + ('0'+(sec%60)).slice(-2); }
function clockMs(sec) {
  sec = Math.max(0, sec || 0);
  var m = Math.floor(sec / 60), s = Math.floor(sec % 60), t = Math.floor((sec % 1) * 10);
  return m + ':' + ('0'+s).slice(-2) + '.' + t;
}
function el(id){ return document.getElementById(id); }
function esc(t){ return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function flash(m){ el('proto-hint').textContent = m; }
function oops(e) {
  console.error(e);
  var msg = (e && (e.message || e.error_description)) || 'Something went wrong.';
  if (/anonymous/i.test(msg)) msg = 'Anonymous sign-ins are off in Supabase. Turn them on under Authentication, Sign In / Providers.';
  flash(msg);
}
/* a database change this page relies on isn't applied yet: say so instead of a raw error */
function needsUpdate(e, file) {
  var m = String((e && (e.message || e.details)) || '');
  if (/row-level security|status_check|violates check constraint|could not find the function|schema cache/i.test(m))
    return new Error('This needs a database update that is not applied yet (' + file + '). Ask whoever runs the database to apply it, then try again.');
  return null;
}
function savedName() { try { return localStorage.getItem(NAME_KEY) || ''; } catch (e) { return ''; } }
function rememberName(n) { try { if (n) localStorage.setItem(NAME_KEY, n); } catch (e) {} }
function extOf(name) { return (name && name.indexOf('.') > -1) ? name.split('.').pop().toLowerCase() : 'wav'; }
function typeFor(file) {
  if (file.type) return file.type;
  var map = { wav:'audio/wav', mp3:'audio/mpeg', m4a:'audio/mp4', aac:'audio/aac', ogg:'audio/ogg', flac:'audio/flac', aif:'audio/aiff', aiff:'audio/aiff', webm:'audio/webm' };
  return map[extOf(file.name)] || 'audio/wav';
}

/* ---------- state ---------- */
var me = null;           // the signed-in (usually anonymous) Supabase user
var unwatch = null;      // realtime unsubscribe
var TAKES = {};          // db id -> take object

function placeholderSeed() {
  return { id:'seed', dbId:null, by:'', roleId:'seed', note:'', len:0, vol:1, mute:false, solo:false, votes:{}, fin:0, fout:0, xfade:0 };
}
function blank() {
  return { session:null, seed:placeholderSeed(), members:[], applicants:[], archive:[], own:[], trial:null, title:'Untitled', mix:null,
           view:'lineup', build:{ picks:[], ctl:{} }, versions:[], override:null, myVotes:{},
           pitches:[], parts:[], trialPitch:null, countIn:2, recRole:null,
           reactions:{ banger:0, mess:0, again:0 }, reacted:{}, seedBusy:false, phaseSeen:null,
           meta:{ bpm:null, key:null, alt:null, time:'4/4', from:'none', sure:null, seedRole:null, busy:false } };
}
var S = blank();

function isHost() { return !!(S.session && me && S.session.host_id === me.id); }
function isOpen() { return !S.session || S.session.status === 'open'; }
/* whoever is looking at a page without a session is about to start one */
function asCreator() { return !S.session || isHost(); }
/* the instrument the creator says the original track is, or null when not set */
function seedInstr() { return S.meta.seedRole ? role(S.meta.seedRole) || null : null; }
function labelOf(t) {
  var ri = t.id === 'seed' ? seedInstr() : null;
  return ri ? 'Original track, ' + ri.label.toLowerCase() : role(t.roleId).label;
}
function seedRoleOptions(sel, none) {
  return '<option value=""' + (sel ? '' : ' selected') + '>' + none + '</option>' +
    ROLES.map(function (r) { return '<option value="' + r.id + '"' + (r.id === sel ? ' selected' : '') + '>' + r.label + '</option>'; }).join('');
}
function hasSeed() { return !!S.seed.dbId; }

/* layers of a role in the project, on one section ('core' is the original track) or on all of them */
function inSong(id, sec){ return S.members.filter(function (m) { return m.roleId === id && (!sec || secOf(m) === sec); }); }
/* slots left for layers in a role on a section; on the original track its own instrument
   takes one (mirrors public.section_cap()) */
function cap(id, sec) { return role(id).slots - ((sec || 'core') === 'core' && S.meta.seedRole === id ? 1 : 0); }
function seedHolds(id, sec) { return cap(id, sec) < 1; }
function waitingFor(id){ return S.applicants.filter(function (a) { return a.roleId === id; }); }
function findTake(id) {
  if (id === 'seed') return S.seed;
  return TAKES[id];
}
function live(t) { return t && t.status !== 'deleted'; }
function trialTake() {
  return S.trial ? S.applicants.filter(function (t) { return t.id === S.trial; })[0] : null;
}
/* takes you can pick for your own version: everything sent to the project, plus what
   you recorded for your own versions (other people's own takes stay in their versions) */
function pool() {
  return S.members.concat(S.applicants, S.archive.map(function (a) { return a.take; }), S.own.filter(mine))
    .filter(function (t) { return t && t.buf; });
}
function mine(t) { return !!(t && me && t.authorId === me.id); }
function isOwn(t) { return !!(t && t.status === 'own'); }
/* where a take stands, as shown in your version */
function standing(t) {
  if (S.members.indexOf(t) > -1) return 'in the project';
  if (S.applicants.indexOf(t) > -1) return 'waiting';
  if (isOwn(t)) return mine(t) ? 'your own recording' : 'own recording';
  return 'vetoed';
}
/* is this take used by a saved version or the one you are building? */
function picked(id) {
  return S.build.picks.indexOf(id) > -1 || S.versions.some(function (v) { return v.picks.indexOf(id) > -1; });
}
function byIds(ids) {
  return ids.map(function (id) { return findTake(id); }).filter(function (t) { return live(t) && t.buf; });
}
function livePicks(ids) { return ids.filter(function (id) { return live(findTake(id)); }); }
function trialPitchTake() {
  if (!S.trialPitch || S.override || S.view !== 'lineup') return null;
  return S.pitches.filter(function (t) { return t.id === S.trialPitch; })[0] || null;
}
function partTakes() { return S.parts; }
/* the song, left to right: parts before, the original track (with every layer on it), parts after.
   The newest part before plays first, the newest part after plays last. */
function arrangement() {
  var before = S.parts.filter(function (p) { return p.pos === 'before'; }).reverse();
  var after = S.parts.filter(function (p) { return p.pos === 'after'; });
  var tp = trialPitchTake();
  if (tp) { if (tp.pos === 'before') before.unshift(tp); else after.push(tp); }
  var t = 0, starts = {}, joins = {}, core = { i:0, o:0 };
  before.forEach(function (p, i) {
    starts[p.id] = t;
    joins[p.id] = { i: i ? xf(before[i - 1]) : 0, o: xf(p) };
    t += p.len - xf(p);
  });
  var lead = t;
  if (before.length) core.i = xf(before[before.length - 1]);
  t += S.seed.len || 0;
  after.forEach(function (p, i) {
    t -= xf(p);
    starts[p.id] = t;
    joins[p.id] = { i: xf(p), o: after[i + 1] ? xf(after[i + 1]) : 0 };
    t += p.len;
  });
  if (after.length) core.o = xf(after[0]);
  return { starts:starts, lead:lead, total:t, joins:joins, core:core };
}
/* crossfade of a new part: how far it overlaps its neighbour, never more than half of either side */
function xfMax(p) { return Math.max(0, Math.min(8, p.len / 2, (S.seed.len || 0) / 2)); }
function xf(p) { return Math.max(0, Math.min(p.xfade || 0, xfMax(p))); }
/* the fades that actually play: what the creator set, or longer where a crossfade needs it */
function envOf(t) {
  var a = arrangement();
  var j = a.joins[t.id] || (t.roleId === 'part' ? { i:0, o:0 } : (secOf(t) !== 'core' && a.joins[t.sec]) || a.core);
  var fi = Math.max(t.fin || 0, j.i), fo = Math.max(t.fout || 0, j.o), L = t.len || 0;
  if (L && fi + fo > L) { var k = L / (fi + fo); fi *= k; fo *= k; }
  return { fi:fi, fo:fo };
}
function envAt(x, L, e) {
  var v = 1;
  if (e.fi > 0 && x < e.fi) v = Math.min(v, x / e.fi);
  if (e.fo > 0 && x > L - e.fo) v = Math.min(v, (L - x) / e.fo);
  return Math.max(0, Math.min(1, v));
}
/* clip time x0 starts sounding at audio time T */
function scheduleEnv(g, t, T, x0) {
  var e = envOf(t), L = t.len;
  var pts = [x0, e.fi, L - e.fo, L].filter(function (x) { return x >= x0 && x <= L; }).sort(function (a, b) { return a - b; });
  g.gain.cancelScheduledValues(0);
  g.gain.setValueAtTime(envAt(x0, L, e), T);
  pts.forEach(function (x) { if (x > x0) g.gain.linearRampToValueAtTime(envAt(x, L, e), T + (x - x0)); });
}
function startOf(tk) {
  var a = arrangement();
  if (a.starts[tk.id] !== undefined) return a.starts[tk.id];
  if (tk.sec && a.starts[tk.sec] !== undefined) return a.starts[tk.sec];
  return a.lead;
}
function tracks() {
  var extra = partTakes().slice(), tp = trialPitchTake();
  if (tp) extra.push(tp);
  var core;
  if (S.override) core = [S.seed].concat(byIds(S.override.picks));
  else if (S.view === 'build') core = [S.seed].concat(byIds(S.build.picks));
  else { var tr = trialTake(); core = [S.seed].concat(S.members, tr ? [tr] : []); }
  return core.concat(extra).filter(function (t) { return t && t.buf && (t.roleId === 'part' || t.id === 'seed' || onKeptSection(t)); });
}
/* per-context mixer settings: the project uses the take itself, a version keeps its own */
function mixCtx() {
  if (S.override) return S.override.ctl;
  if (S.view === 'build') return S.build.ctl;
  return null;
}
function ctl(t) {
  var c = mixCtx();
  if (!c) return t;
  if (!c[t.id]) c[t.id] = { vol:1, mute:false, solo:false };
  return c[t.id];
}
function volOf(t){ var v = ctl(t).vol; return v === undefined ? 1 : v; }
/* filter cutoffs in Hz. Fully open (hp at the bottom, lp at the top) means the filter does nothing. */
var F_MIN = 20, F_MAX = 20000;
function cutOf(t, kind) {
  var v = ctl(t)[kind];
  return typeof v === 'number' ? v : (kind === 'hp' ? F_MIN : F_MAX);
}
function hzToKnob(hz){ return Math.log(hz / F_MIN) / Math.log(F_MAX / F_MIN); }
function knobToHz(k){ return Math.round(F_MIN * Math.pow(F_MAX / F_MIN, Math.max(0, Math.min(1, k)))); }
function fmtHz(hz){ return hz >= 1000 ? (Math.round(hz / 100) / 10) + ' kHz' : hz + ' Hz'; }
function inVersions(id) {
  return S.versions.filter(function (v) { return v.picks.indexOf(id) > -1; }).length;
}
function verTag(id) {
  var n = inVersions(id);
  return n ? '<span class="vtag">in ' + n + ' version' + (n > 1 ? 's' : '') + '</span>' : '';
}

/* ---------- snapshot from the database ---------- */
function applySnapshot(sess, snap) {
  S.session = sess;
  S.title = sess.title;
  S.meta.bpm = sess.bpm; S.meta.key = sess.music_key; S.meta.alt = sess.key_alt;
  S.meta.time = sess.time_sig; S.meta.from = sess.meta_from; S.meta.sure = sess.meta_sure;
  S.meta.seedRole = sess.seed_role || null;

  snap.takes.forEach(function (row) {
    var t = TAKES[row.id];
    if (!t) t = TAKES[row.id] = { id:row.id, dbId:row.id, vol:1, mute:false, solo:false, votes:{} };
    t.by = row.author_name; t.authorId = row.author_id; t.roleId = row.role_id; t.note = row.note;
    t.status = row.status; t.why = row.archive_reason; t.fileName = row.file_name; t.path = row.storage_path;
    t.url = db.publicUrl(row.storage_path); t.joinedAt = row.joined_at; t.created = row.created_at;
    t.pos = row.part_pos || null; t.sec = row.section_id || null;
    /* keep what the creator is dragging or saving right now */
    if (!t.fadeBusy && !(drag && drag.t === t)) { t.fin = row.fade_in || 0; t.fout = row.fade_out || 0; t.xfade = row.xfade || 0; }
    if (!t.buf) t.len = row.duration_sec;
    if (row.an_bpm || row.an_key) t.an = { bpm:row.an_bpm, key:row.an_key || '?' };
  });

  /* the current seed is always addressed as 'seed' in the UI */
  var seed = sess.seed_take_id ? TAKES[sess.seed_take_id] : null;
  var prevSeed = S.seed;
  Object.keys(TAKES).forEach(function (k) { if (TAKES[k] !== seed && TAKES[k].id === 'seed') TAKES[k].id = k; });
  if (seed) seed.id = 'seed';
  S.seed = seed || (prevSeed.dbId ? placeholderSeed() : prevSeed);
  if (S.seed !== prevSeed) delete gains.seed;

  var list = snap.takes.map(function (r) { return TAKES[r.id]; }).filter(live);
  var layers = list.filter(function (t) { return t.roleId !== 'part'; });
  var parts = list.filter(function (t) { return t.roleId === 'part'; });
  function byJoin(a, b) { return String(a.joinedAt).localeCompare(String(b.joinedAt)); }
  S.members = layers.filter(function (t) { return t.status === 'in'; }).sort(byJoin);
  S.applicants = layers.filter(function (t) { return t.status === 'waiting'; });
  S.own = layers.filter(function (t) { return t.status === 'own'; });
  S.archive = layers.filter(function (t) { return t.status === 'archived'; }).map(function (t) {
    return { take:t, why: t.why === 'vetoed' ? (isHost() ? 'vetoed by you' : 'vetoed by the creator')
                        : t.why === 'removed' ? (isHost() ? 'taken out by you' : 'taken out by the creator') : (t.why || 'archived') };
  });
  S.pitches = parts.filter(function (t) { return t.status === 'waiting'; });
  S.parts = parts.filter(function (t) { return t.status === 'in'; }).sort(byJoin);
  var mixes = list.filter(function (t) { return t.status === 'mix'; });
  S.mix = mixes.length ? mixes[mixes.length - 1] : null;
  if (S.trial && !S.applicants.some(function (t) { return t.id === S.trial; })) S.trial = null;
  if (S.trialPitch && !S.pitches.some(function (t) { return t.id === S.trialPitch; })) S.trialPitch = null;
  S.build.picks = S.build.picks.filter(function (id) { return live(findTake(id)); });

  /* votes are cast by people; show them against each voter's layer in the project */
  list.forEach(function (t) { t.votes = {}; });
  S.myVotes = {};
  snap.votes.forEach(function (v) {
    var t = TAKES[v.take_id];
    if (!t) return;
    S.members.forEach(function (m) { if (m.authorId === v.voter_id) t.votes[m.id] = v.value; });
    if (me && v.voter_id === me.id) S.myVotes[v.take_id] = v.value;
  });

  var likeCount = {}, liked = {};
  snap.likes.forEach(function (l) {
    likeCount[l.version_id] = (likeCount[l.version_id] || 0) + 1;
    if (me && l.user_id === me.id) liked[l.version_id] = true;
  });
  S.versions = snap.versions.map(function (v) {
    return { id:v.id, name:v.name, by:v.by_name, picks:v.picks || [], ctl:v.ctl || {}, likes:likeCount[v.id] || 0, liked:!!liked[v.id] };
  });

  S.reactions = { banger:0, mess:0, again:0 }; S.reacted = {};
  snap.reactions.forEach(function (r) {
    S.reactions[r.kind] = (S.reactions[r.kind] || 0) + 1;
    if (me && r.user_id === me.id) S.reacted[r.kind] = true;
  });

  loadMissingAudio();
}

var refreshTimer = 0;
function refresh() {
  if (!S.session) return Promise.resolve();
  var id = S.session.id;
  return Promise.all([db.loadSessionById(id), db.loadSnapshot(id)]).then(function (r) {
    if (!S.session || S.session.id !== id) return;
    applySnapshot(r[0], r[1]);
    syncPhase();
    renderAll();
  }).catch(oops);
}
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 250);
}
function watch(sessionId) {
  if (unwatch) unwatch();
  unwatch = db.subscribe(sessionId, refreshSoon);
}

/* ---------- audio loading (from storage, a few at a time) ---------- */
var loadQueue = [], loadingNow = 0, LOAD_LIMIT = 3;
function loadMissingAudio() {
  Object.keys(TAKES).forEach(function (k) {
    var t = TAKES[k];
    if (t.status === 'mix' || t.status === 'deleted' || t.buf || t.loading || t.failed || !t.url) return;
    if (t.roleId === 'seed' && t !== S.seed) return;              // an old, replaced seed
    if (t.roleId === 'part' && t.status === 'archived') return;   // a part nobody hears any more
    if (isOwn(t) && !mine(t) && !picked(t.id)) return;            // someone's own take no version uses
    t.loading = true;
    loadQueue.push(t);
  });
  pump();
}
function pump() {
  while (loadingNow < LOAD_LIMIT && loadQueue.length) {
    var t = loadQueue.shift();
    loadingNow++;
    loadOne(t).then(function () { loadingNow--; renderSoon(); pump(); });
  }
}
function loadOne(t) {
  return fetch(t.url).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.arrayBuffer();
  }).then(function (ab) {
    t.bytes = new Uint8Array(ab.slice(0));
    return ac().decodeAudioData(ab);
  }).then(function (buf) {
    setBuffer(t, buf);
    t.loading = false;
  }).catch(function (e) {
    console.error('Could not load audio for', t.fileName, e);
    t.loading = false; t.failed = true;
  });
}
function loadingCount() {
  return Object.keys(TAKES).filter(function (k) { return TAKES[k].loading; }).length;
}

/* ---------- project votes ---------- */
function atStake(t) {
  var here = inSong(t.roleId, secOf(t));
  return here.length && here.length >= cap(t.roleId, secOf(t)) ? here[0] : null;
}
function tallyOf(t) {
  var stake = atStake(t), up = 0, down = 0, voters = 0, seen = {};
  S.members.forEach(function (m) {
    if (stake && m.id === stake.id) return;
    if (seen[m.authorId]) return;   // one person, one vote, even with two layers in
    seen[m.authorId] = true; voters++;
    if (t.votes[m.id] === 'up') up++;
    if (t.votes[m.id] === 'down') down++;
  });
  return { up:up, down:down, voters:voters };
}
/* mirrors public.can_vote() in the database */
function canVote(t) {
  if (!me || !isOpen() || t.status !== 'waiting' || t.roleId === 'part' || seedHolds(t.roleId, secOf(t))) return false;
  var stake = atStake(t);
  return S.members.some(function (m) { return m.authorId === me.id && !(stake && stake.id === m.id); });
}
function voteBlock(t) {
  if (seedHolds(t.roleId, secOf(t))) return '<div class="lvotes"><span class="tiny muted">The original track plays this part, so this layer can only go in versions.</span></div>';
  if (!S.members.length) return '<div class="lvotes"><span class="tiny muted">Nobody in the project yet to weigh in.</span></div>';
  var stake = atStake(t), tl = tallyOf(t);
  var chips = S.members.map(function (m) {
    var v = t.votes[m.id], r = role(m.roleId), isStake = stake && stake.id === m.id;
    return '<span class="lv' + (v ? ' ' + v : ' none') + (isStake ? ' stake' : '') + '" style="--c:' + col(r) + '" title="' +
      esc(m.by) + (isStake ? ' holds this spot, so their vote does not count' : '') + '">' +
      '<i></i>' + esc(m.by) + '<em>' + (v === 'up' ? '&#8593;' : v === 'down' ? '&#8595;' : '&middot;') + '</em></span>';
  }).join('');
  var mine = S.myVotes[t.id];
  var myButtons = canVote(t)
    ? '<div class="lv-mine"><span class="tiny muted">Your vote</span>' +
      '<button class="btn btn-sm' + (mine === 'up' ? ' on' : '') + '" type="button" data-vote="up" data-take="' + t.id + '" aria-pressed="' + (mine === 'up') + '">&#8593; For</button>' +
      '<button class="btn btn-sm' + (mine === 'down' ? ' on' : '') + '" type="button" data-vote="down" data-take="' + t.id + '" aria-pressed="' + (mine === 'down') + '">&#8595; Against</button></div>'
    : '';
  return '<div class="lvotes"><div class="lv-sum"><b>The project</b> ' + tl.up + ' for, ' + tl.down + ' against' +
    (tl.voters - tl.up - tl.down > 0 ? ', ' + (tl.voters - tl.up - tl.down) + ' quiet' : '') + '</div>' +
    '<div class="lv-chips">' + chips + '</div>' + myButtons + '</div>';
}
function target(){ return hasSeed() ? S.seed.len : 0; }
/* sections you can layer on: the original track, and every new part that was kept */
function sections() {
  if (!hasSeed()) return [];
  var a = arrangement(), out = [{ id:'core', label:'the original track', start:a.lead, len:S.seed.len }];
  S.parts.forEach(function (p) {
    out.push({ id:p.id, label:p.by + '\'s part', start:a.starts[p.id], len:p.len, pos:p.pos });
  });
  return out.sort(function (x, y) { return x.start - y.start; });
}
function section(id) { return sections().filter(function (s) { return s.id === (id || 'core'); })[0] || null; }
function secLen(id) { var s = section(id); return s ? s.len : target(); }
function secOf(t) { return t.sec || 'core'; }
function onKeptSection(t) { return secOf(t) === 'core' || S.parts.some(function (p) { return p.id === t.sec; }); }
function secTag(t) {
  if (secOf(t) === 'core' || t.roleId === 'part') return '';
  var p = findTake(t.sec);
  return '<span class="sectag">on ' + esc(p ? p.by + '\'s part' : 'a new part') + '</span>';
}
function duration(){ return tracks().reduce(function (a, t) { return Math.max(a, startOf(t) + t.len); }, 0); }

/* ---------- web audio engine ---------- */
var AC = null, master = null, analyser = null, freq = null;
var gains = {}, sources = {}, startedAt = 0, offset = 0, running = false, only = null, raf = 0;
function ac() {
  if (!AC) {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    master = AC.createGain();
    analyser = AC.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.72;
    freq = new Uint8Array(analyser.frequencyBinCount);
    master.connect(analyser);
    analyser.connect(AC.destination);
  }
  return AC;
}
function anySolo(){ return tracks().some(function (t) { return ctl(t).solo; }); }
function audible(t) {
  if (only) return t.id === only;
  if (ctl(t).mute) return false;
  if (anySolo() && !ctl(t).solo) return false;
  return true;
}
/* Each track runs source -> fade envelope -> high-pass -> low-pass -> gain -> master.
   Returns the input of the filter chain. */
function gainFor(t) {
  var ch = gains[t.id];
  if (!ch) {
    var hp = ac().createBiquadFilter(), lp = ac().createBiquadFilter(), g = ac().createGain();
    hp.type = 'highpass'; lp.type = 'lowpass';
    hp.Q.value = lp.Q.value = Math.SQRT1_2;
    hp.frequency.value = cutOf(t, 'hp');
    lp.frequency.value = cutOf(t, 'lp');
    hp.connect(lp); lp.connect(g); g.connect(master);
    ch = gains[t.id] = { hp:hp, lp:lp, g:g };
  }
  ch.g.gain.value = audible(t) ? volOf(t) : 0;
  setCut(ch.hp, cutOf(t, 'hp'));
  setCut(ch.lp, cutOf(t, 'lp'));
  return ch.hp;
}
/* glide to the new cutoff so turning a knob during playback doesn't click */
function setCut(node, hz) {
  if (Math.abs(node.frequency.value - hz) < .5) return;
  node.frequency.setTargetAtTime(hz, ac().currentTime, .015);
}
function refreshGains(){ tracks().forEach(gainFor); }
function position() {
  if (!running) return offset;
  return Math.min(duration(), ac().currentTime - startedAt);
}
function stopAll(keep) {
  Object.keys(sources).forEach(function (k) {
    try { sources[k].stop(); } catch (e) {}
  });
  sources = {};
  if (running) offset = keep ? position() : 0;
  running = false; only = null;
  cancelAnimationFrame(raf);
  raf = 0;
  bindViz(); drawViz(false);
  render();
}
function play(from, soloId) {
  if (REC.state === 'recording' || REC.state === 'asking') return;
  var list = tracks();
  if (!list.length) return;
  stopAll(true);
  only = soloId || null;
  var at = Math.max(0, Math.min(from === undefined ? offset : from, duration() - .05));
  ac().resume();
  startedAt = ac().currentTime - at;
  var now = ac().currentTime;
  list.forEach(function (t) {
    if (!audible(t)) return;
    var st = startOf(t);
    if (at >= st + t.len) return;
    var s = ac().createBufferSource(), env = ac().createGain();
    s.buffer = t.buf;
    s.connect(env); env.connect(gainFor(t));
    var T = at >= st ? now : now + (st - at), x0 = at >= st ? at - st : 0;
    scheduleEnv(env, t, T, x0);
    s.start(T, x0);
    sources[t.id] = s;
  });
  offset = at; running = true;
  startLoop();
  render();
}
/* play/pause for a take or part that is being heard in the mix */
function mixToggle(what) {
  var on = running && !only;
  return '<button class="btn btn-sm mixtgl' + (on ? ' on' : '') + '" type="button" data-mixtgl="1" aria-label="' +
    (on ? 'Pause' : 'Play') + ' the mix with ' + what + '">' + (on ? I_PAUSE + ' Pause' : I_PLAY + ' Play') + '</button>';
}
function toggleTransport(){ running ? stopAll(true) : play(); }
function preview(t) {
  if (!t || !t.buf) { if (t && t.loading) flash('Still loading that take.'); return; }
  if (only === t.id) { stopAll(); return; }
  stopAll();
  only = t.id;
  var s = ac().createBufferSource(), env = ac().createGain();
  s.buffer = t.buf;
  s.connect(env); env.connect(gainFor(t));
  ac().resume();
  var T = ac().currentTime + 0.02;
  scheduleEnv(env, t, T, 0);
  s.start(T);
  onlyAt = T;
  sources[t.id] = s;
  s.onended = function () { delete sources[t.id]; if (only === t.id) { only = null; render(); } };
  startLoop();
  render();
}
/* The original track's waveform at the top: real peaks, with the part already played
   coloured in while the original track sounds (on its own or in the mix). */
var onlyAt = 0, SEED_BARS = 160;
function seedWaveBars() {
  var pk = S.seed.peaks;
  if (!pk || !pk.length) return '';
  var step = pk.length / SEED_BARS, vals = [], max = 0;
  for (var i = 0; i < SEED_BARS; i++) {
    var m = 0;
    for (var j = Math.floor(i * step); j < Math.floor((i + 1) * step); j++) if (pk[j] > m) m = pk[j];
    vals.push(m); if (m > max) max = m;
  }
  return vals.map(function (v) { return '<i style="height:' + Math.max(4, Math.round((max ? v / max : 0) * 100)) + '%"></i>'; }).join('');
}
function seedWave() {
  var bars = seedWaveBars();
  if (!bars) return '<div class="seedwave loading" id="seed-viz" aria-hidden="true">' + vizMarkup(SEED_BARS) + '</div>';
  return '<div class="seedwave" id="seed-viz" aria-hidden="true"><div class="sw-bars">' + bars + '</div>' +
    '<div class="sw-prog" id="seed-prog"><div class="sw-bars">' + bars + '</div></div></div>';
}
function seedProgress() {
  var L = S.seed.len || 0;
  if (!L) return 0;
  if (only === 'seed' && sources.seed) return (ac().currentTime - onlyAt) / L;
  if (running && !only) return (position() - startOf(S.seed)) / L;
  return 0;
}
function drawViz() {
  var pr = el('seed-prog');
  if (!pr) return;
  var f = Math.max(0, Math.min(1, seedProgress()));
  pr.style.clipPath = 'inset(0 ' + ((1 - f) * 100).toFixed(2) + '% 0 0)';
}
function bindViz() {}
function frame() {
  var dawRec = REC.where === 'daw' && REC.state === 'recording';
  var busy = running || Object.keys(sources).length > 0 || dawRec;
  var p = dawRec ? Math.max(0, startOf(S.seed) + ac().currentTime - REC.songStart) : position(), d = duration();
  if (dawRec) drawRecLane();
  var ph = el('playhead'), rd = el('readout');
  var lane = document.querySelector('.t-lane'), daw = el('daw');
  if (ph && d && lane && daw) {
    var lr = lane.getBoundingClientRect(), dr = daw.getBoundingClientRect();
    var ru = daw.querySelector('.ruler');
    ph.style.left = (lr.left - dr.left + (p / d) * lr.width) + 'px';
    if (ru) ph.style.top = (ru.getBoundingClientRect().top - dr.top) + 'px';
  }
  if (rd) rd.textContent = clockMs(p) + ' / ' + clockMs(d);
  drawViz(busy);
  if (running && p >= d - .02) { stopAll(); return; }
  if (busy) raf = requestAnimationFrame(frame);
  else { raf = 0; drawViz(false); }
}
function startLoop(){ if (!raf) raf = requestAnimationFrame(frame); }
function tick(){ startLoop(); }

/* ---------- files ---------- */
function decode(file) {
  return file.arrayBuffer().then(function (b) { return ac().decodeAudioData(b); });
}
function peaksOf(buf, n) {
  var ch = buf.getChannelData(0), step = Math.floor(ch.length / n) || 1, out = new Float32Array(n);
  for (var i = 0; i < n; i++) {
    var s = i * step, e = Math.min(ch.length, s + step), m = 0;
    for (var j = s; j < e; j += 2) { var v = Math.abs(ch[j]); if (v > m) m = v; }
    out[i] = m;
  }
  return out;
}
function setBuffer(t, buf) {
  t.buf = buf;
  t.len = buf.duration;
  t.peaks = peaksOf(buf, 1200);
  delete gains[t.id];
}

/* Upload the audio, analyse it in parallel, then record the take. The decoded buffer is
   cached right away so the uploader never downloads their own file again. */
function uploadTake(file, buf, o) {
  var sid = S.session.id;
  var path = sid + '/' + me.id + '/' + crypto.randomUUID() + '.' + extOf(file.name);
  var type = typeFor(file);
  return Promise.all([
    db.uploadAudio(path, file, type),
    o.analyse ? analyse(file).catch(function () { return null; }) : Promise.resolve(null)
  ]).then(function (r) {
    var an = r[1];
    return db.insertTake({
      session_id: sid, author_id: me.id, author_name: o.name, role_id: o.role, note: o.note || '',
      status: o.status, storage_path: path, file_name: file.name, mime_type: type, duration_sec: buf.duration,
      part_pos: o.pos || null, section_id: o.sec || null,
      an_bpm: an && an.tempo ? an.tempo.bpm : null, an_key: an && an.key ? an.key.key : null
    }).then(function (row) {
      var t = TAKES[row.id] = { id:row.id, dbId:row.id, vol:1, mute:false, solo:false, votes:{},
                                roleId:row.role_id, status:row.status, by:row.author_name, authorId:row.author_id,
                                note:row.note, sec:row.section_id || null, pos:row.part_pos || null, fin:0, fout:0, xfade:0 };
      setBuffer(t, buf);
      file.arrayBuffer().then(function (ab) { t.bytes = new Uint8Array(ab); });
      return { row:row, analysis:an };
    });
  });
}

/* ---------- downloads ---------- */
function clean(s){ return String(s || 'take').replace(/[^\w\- ]+/g, '').trim() || 'take'; }
function fileName(t, i) {
  return (i !== undefined ? ('0' + (i + 1)).slice(-2) + ' ' : '') + clean(labelOf(t)) + ' - ' + clean(t.by || 'you') + '.' + extOf(t.fileName);
}
function sheet(list) {
  return 'Riffraff session sheet\r\n\r\n' +
    'Tempo: ' + (S.meta.bpm || '?') + ' bpm\r\nKey: ' + (S.meta.key || '?') + '\r\nTime: ' + S.meta.time +
    '\r\nLength of the original track: ' + fmt(target()) + '\r\n\r\nEvery file starts at the time listed below. Layers on the original track start at its first beat, layers on a new part start with that part.\r\n\r\n' +
    list.map(function (t, i) {
      var e = envOf(t);
      return fileName(t, i) + '   (' + labelOf(t) + ', ' + (t.by || 'you') + ', starts at ' + clockMs(startOf(t)) +
        (e.fi > 0.01 ? ', fade in ' + e.fi.toFixed(1) + ' s' : '') + (e.fo > 0.01 ? ', fade out ' + e.fo.toFixed(1) + ' s' : '') + ')';
    }).join('\r\n') + '\r\n';
}
function hand(filename, blob) {
  var url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  flash('Downloading ' + filename + '.');
}
function bytes(t) {
  if (t.bytes) return Promise.resolve(t.bytes);
  return fetch(t.url).then(function (r) { return r.arrayBuffer(); }).then(function (ab) { return (t.bytes = new Uint8Array(ab)); });
}
function download(t) {
  if (!t || !t.url) return;
  bytes(t).then(function (u) {
    hand(clean(t.by || 'you') + ' - ' + clean(role(t.roleId).label) + '.zip', zip([{ name:fileName(t), data:u }]));
  }).catch(oops);
}
function downloadAll() {
  var list = tracks().filter(function (t) { return t.url; });
  if (!list.length) return;
  flash('Packing ' + list.length + ' file(s)...');
  Promise.all(list.map(bytes)).then(function (arr) {
    var files = arr.map(function (u, i) { return { name:fileName(list[i], i), data:u }; });
    files.push({ name:'session sheet.txt', data:new TextEncoder().encode(sheet(list)) });
    var title = (S.override ? S.override.name : (S.view === 'build' ? 'my version' : 'project'));
    hand('Riffraff - ' + clean(title) + ' stems.zip', zip(files));
  }).catch(oops);
}

/* ---------- wav, click, count-in ---------- */
function encodeWav(buf) {
  var ch = buf.numberOfChannels, sr = buf.sampleRate, n = buf.length;
  var dv = new DataView(new ArrayBuffer(44 + n * ch * 2));
  function str(o, s){ for (var i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); }
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * ch * 2, true); dv.setUint16(32, ch * 2, true);
  dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, n * ch * 2, true);
  var data = []; for (var c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  var o = 44;
  for (var i = 0; i < n; i++) for (var c2 = 0; c2 < ch; c2++) {
    var v = Math.max(-1, Math.min(1, data[c2][i]));
    dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7FFF, true); o += 2;
  }
  return new Blob([dv.buffer], { type:'audio/wav' });
}
function trimStart(buf, sec) {
  var cut = Math.min(buf.length - 1, Math.round(sec * buf.sampleRate));
  var out = ac().createBuffer(buf.numberOfChannels, buf.length - cut, buf.sampleRate);
  for (var c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(cut), c);
  return out;
}
function beatInfo() {
  var sig = S.meta.time === 'odd' ? '4/4' : S.meta.time, p = sig.split('/');
  var beats = +p[0] || 4, unit = +p[1] || 4;
  return { beats:beats, beat:(60 / (S.meta.bpm || 120)) * (4 / unit), bar:barSeconds() };
}
/* click samples: count-in bars first, then the song, accent on every bar's first beat */
function clickSamples(sr, countBars, songSec) {
  var b = beatInfo(), total = countBars * b.bar + songSec + 0.05;
  var out = new Float32Array(Math.ceil(total * sr)), blip = Math.round(0.045 * sr);
  var nBeats = Math.ceil((countBars * b.bar + songSec) / b.beat);
  for (var k = 0; k < nBeats; k++) {
    var at = Math.round(k * b.beat * sr), first = k % b.beats === 0, counting = k < countBars * b.beats;
    var f = first ? (counting ? 1760 : 1500) : 1000, amp = first ? 0.9 : 0.55;
    for (var i = 0; i < blip && at + i < out.length; i++)
      out[at + i] += amp * Math.sin(2 * Math.PI * f * i / sr) * Math.exp(-i / (sr * 0.012));
  }
  return out;
}
function clickBuffer(countBars, songSec) {
  var sr = ac().sampleRate, data = clickSamples(sr, countBars, songSec);
  var b = ac().createBuffer(1, data.length, sr);
  b.copyToChannel(data, 0);
  return b;
}
function downloadClick() {
  if (!hasSeed()) return;
  var b = beatInfo(), n = S.countIn, sec = target();
  var bpm = S.meta.bpm || 120, sig = S.meta.time === 'odd' ? '4/4' : S.meta.time;
  var name = 'click ' + bpm + ' bpm ' + sig.replace('/', '-') + (n ? ' with ' + n + ' bar count-in' : '');
  var readme = 'Riffraff click track\r\n\r\n' + bpm + ' bpm, ' + sig + ', ' + fmt(sec) + ' of song' +
    (n ? ', plus ' + n + ' bar' + (n > 1 ? 's' : '') + ' of count-in (' + (n * b.bar).toFixed(2) + ' s)' : '') + '.\r\n\r\n' +
    (n ? 'Bar 1 of the song starts right after the count-in. When you upload, either cut the count-in off your take, ' +
         'or tick "my file starts with the count-in" and Riffraff cuts it for you.\r\n'
       : 'Bar 1 of the song is the very start of the file.\r\n') +
    (S.meta.bpm ? '' : '\r\nNo tempo was detected for this session, so this click runs at 120 bpm. Ask the creator to set the tempo, then download again.\r\n');
  encodeWav(clickBuffer(n, sec)).arrayBuffer().then(function (ab) {
    hand('Riffraff ' + name + '.zip', zip([
      { name: name + '.wav', data: new Uint8Array(ab) },
      { name: 'read me.txt', data: new TextEncoder().encode(readme) }
    ]));
  });
}

/* ---------- recorder: plays the chosen tracks and the click, cuts the take to bar 1 ---------- */
var REC = { state:'idle', buf:null, file:null, stream:null, nodes:[], timer:0, player:[] };
function recStopPlayers() {
  REC.player.forEach(function (s) { try { s.stop(); } catch (e) {} });
  REC.player = [];
}
function recCleanup() {
  clearTimeout(REC.timer); clearInterval(REC.tick);
  recStopPlayers();
  REC.nodes.forEach(function (n) { try { n.disconnect(); } catch (e) {} });
  REC.nodes = [];
  if (REC.stream) REC.stream.getTracks().forEach(function (tr) { tr.stop(); });
  REC.stream = null;
}
function recReset() { recCleanup(); REC.state = 'idle'; REC.buf = null; REC.file = null; REC.err = ''; REC.partial = 0; REC.peaks = null; }
function recBacking() {
  return hearable().filter(function (t) { return REC.hear[t.id] !== false && (REC.where !== 'daw' || audible(t)); });
}
/* what can play under a recording: the project, or for your own version the takes you picked */
function hearable() {
  var layers = M.mode === 'own' ? byIds(S.build.picks) : S.members;
  return [S.seed].concat(layers.filter(onKeptSection), partTakes()).filter(function (t) { return t.buf; });
}
/* play backing so that the chosen section starts at audio time T */
function playBacking(list, T, into) {
  var a = ac(), s0 = (section(M.sec) || section('core')).start;
  list.forEach(function (t) {
    var rel = startOf(t) - s0, off = rel < 0 ? -rel : 0;
    if (off >= t.len) return;
    var s = a.createBufferSource(), g = a.createGain();
    s.buffer = t.buf; g.gain.value = volOf(t);
    s.connect(g); g.connect(master); s.start(T + Math.max(0, rel), off);
    into.push(s); REC.nodes.push(g);
  });
}
function recStart() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    REC.err = 'This browser does not give pages access to a microphone.'; renderRec(); return;
  }
  stopAll();
  REC.err = ''; REC.state = 'asking'; renderRec();
  navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:false, noiseSuppression:false, autoGainControl:false } })
  .then(function (stream) {
    var a = ac(); a.resume();
    REC.stream = stream;
    var src = a.createMediaStreamSource(stream);
    var proc = a.createScriptProcessor(4096, 1, 1);
    var sink = a.createGain(); sink.gain.value = 0;
    src.connect(proc); proc.connect(sink); sink.connect(a.destination);
    REC.nodes = [src, proc, sink];
    var chunks = [], bar = barSeconds(), extend = M.mode === 'extend';
    var countIn = S.countIn, t0 = a.currentTime + 0.4, songStart = t0 + countIn * bar;
    var fixed = extend ? 0 : secLen(M.sec);
    REC.songStart = songStart; REC.fixed = fixed; REC.level = 0;
    proc.onaudioprocess = function (e) {
      var d = e.inputBuffer.getChannelData(0), pk = 0;
      for (var i = 0; i < d.length; i++) { var v = Math.abs(d[i]); if (v > pk) pk = v; }
      REC.level = Math.max(pk, REC.level * 0.85);
      /* eight sub-peaks per chunk, so the take can be drawn finely while it comes in */
      var pks = [], seg = Math.ceil(d.length / 8);
      for (var q = 0; q < 8; q++) { var m = 0; for (var k = q * seg; k < Math.min(d.length, (q + 1) * seg); k++) { var u = Math.abs(d[k]); if (u > m) m = u; } pks.push(m); }
      chunks.push({ t: e.playbackTime - d.length / e.inputBuffer.sampleRate, d: new Float32Array(d), pks: pks,
                    dur: d.length / e.inputBuffer.sampleRate });
    };
    /* what you hear: the click and, for a layer, the chosen tracks from bar 1 */
    if (REC.click) {
      var cs = a.createBufferSource();
      cs.buffer = clickBuffer(countIn, fixed || 180);
      cs.connect(master); cs.start(t0);
      REC.player.push(cs);
    }
    if (!extend) playBacking(recBacking(), songStart, REC.player);
    REC.chunks = chunks; REC.state = 'recording'; REC.stopAt = fixed ? songStart + fixed : 0;
    REC.lat = (a.outputLatency || 0) + (a.baseLatency || 0);
    if (REC.where === 'daw') startLoop();
    REC.tick = setInterval(renderRecStatus, 100);
    if (fixed) REC.timer = setTimeout(recFinish, (songStart + fixed - a.currentTime + 0.25) * 1000);
    renderRec();
  }).catch(function (err) {
    REC.state = 'idle';
    REC.err = (err && err.name === 'NotAllowedError')
      ? 'The microphone was blocked. Allow it in your browser, or upload a file instead.'
      : 'No microphone could be opened here. Upload a file instead.';
    renderRec();
  });
}
/* Stopping a fixed-length layer early keeps what was played: the take still runs the full
   length of its section, and everything after the stop is silence. */
function recFinish() {
  if (REC.state !== 'recording') return;
  var a = ac(), sr = a.sampleRate;
  var lat = (a.outputLatency || 0) + (a.baseLatency || 0);
  var from = REC.songStart + lat;
  var played = Math.max(0, a.currentTime - REC.songStart);
  var len = REC.fixed || played;
  recCleanup();
  if (played < 0.5) {
    REC.state = 'idle';
    REC.err = REC.fixed && played === 0 ? 'Nothing was recorded yet, the count-in was still running.' : 'That was too short to keep.';
    renderRec(); return;
  }
  REC.partial = REC.fixed && played < REC.fixed - 0.25 ? played : 0;
  var out = new Float32Array(Math.round(len * sr));
  REC.chunks.forEach(function (c) {
    var at = Math.round((c.t - from) * sr);
    for (var i = 0; i < c.d.length; i++) { var j = at + i; if (j >= 0 && j < out.length) out[j] = c.d[i]; }
  });
  var buf = a.createBuffer(1, out.length, sr);
  buf.copyToChannel(out, 0);
  REC.buf = buf;
  REC.file = new File([encodeWav(buf)], 'recorded take.wav', { type:'audio/wav' });
  REC.chunks = null;
  REC.state = 'done';
  renderRec();
}
function recCancel() {
  recCleanup();
  REC.state = 'idle'; REC.chunks = null;
  renderRec();
}
/* ---------- recording straight onto the grey track in the DAW, like a real DAW:
   the playhead runs over the other tracks and the take is drawn as it comes in ---------- */
function dawRecMode() { return S.view === 'build' && !S.override ? 'own' : 'layer'; }
function dawRecStart() {
  if (!hasSeed()) return;
  var own = dawRecMode() === 'own';
  if (!own && !isOpen()) { flash('This session is closed.'); return; }
  if (el('scrim').classList.contains('on')) return;
  M.mode = own ? 'own' : 'layer'; M.sec = 'core';
  recReset(); REC.where = 'daw'; REC.hear = {}; if (REC.click === undefined) REC.click = true;
  recStart();
}
/* the finished take goes into the send window, already loaded: add a name and send */
function dawRecSend() {
  if (!REC.buf) return;
  var own = dawRecMode() === 'own';
  REC.where = 'modal'; REC.fromDaw = true;
  openModal(S.recRole || ROLES[0].id, null, own, true);
}
/* from the send-a-take window to the grey track: same instrument, right view, ready to record */
function recordInDaw() {
  var own = M.mode === 'own', rid = el('take-role').value;
  closeModal();
  S.recRole = rid;
  if (REC.state === 'recording' || REC.state === 'asking') recCancel();
  stopAll();
  S.override = null; S.trial = null; S.view = own ? 'build' : 'lineup';
  refreshGains(); render();
  var row = el('addrow');
  if (row) {
    row.scrollIntoView({ behavior:'smooth', block:'center' });
    row.classList.add('ready');
    setTimeout(function () { var r2 = el('addrow'); if (r2) r2.classList.remove('ready'); }, 2600);
  }
  flash('Record your ' + role(rid).label.toLowerCase() + ' right here on the grey track: press "Record here". Wear headphones.');
}
function dawRecDiscard() { recReset(); REC.where = null; REC.fromDaw = false; renderDaw(); }
function renderDawRec() {
  var row = el('addrow');
  if (row) {
    row.className = 'track addrow' + (REC.where === 'daw' && REC.state !== 'idle' ? ' rec-on' : '');
    row.innerHTML = addRowInner(S.view === 'build' && !S.override);
  }
  else renderDaw();
  drawRecLane();
}
/* x of song time sec on the DAW lanes (0..1) */
function laneX(sec) { var d = duration() || target() || 1; return sec / d; }
function drawRecLane() {
  var c = el('rec-canvas');
  if (!c) return;
  var dpr = window.devicePixelRatio || 1, w = c.clientWidth || 600, h = c.clientHeight || 72;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  var g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  var s0 = startOf(S.seed), L = S.seed.len || 1, mid = h / 2;
  var r = role(S.recRole || ROLES[0].id), color = cvar(r.color);
  /* the stretch you are recording over */
  g.fillStyle = color; g.globalAlpha = .08;
  g.fillRect(laneX(s0) * w, 2, laneX(L) * w, h - 4);
  g.globalAlpha = .9;
  if (REC.state === 'recording' && REC.chunks) {
    REC.chunks.forEach(function (ch) {
      var sub = ch.dur / ch.pks.length;
      ch.pks.forEach(function (pk, q) {
        var at = ch.t - REC.songStart - REC.lat + q * sub;
        if (at + sub < 0 || at > L) return;
        var x0 = laneX(s0 + Math.max(0, at)) * w, x1 = laneX(s0 + Math.min(L, at + sub)) * w;
        var bar = Math.max(1, Math.min(1, pk) * (h - 6));
        g.fillRect(x0, mid - bar / 2, Math.max(1, x1 - x0 + .5), bar);
      });
    });
  } else if (REC.state === 'done' && REC.buf) {
    var pk = REC.peaks || (REC.peaks = peaksOf(REC.buf, 1200)), n = pk.length;
    var x0 = laneX(s0) * w, cw = Math.max(1, laneX(REC.buf.duration) * w);
    for (var x = 0; x < cw; x++) {
      var bar2 = Math.max(1, (pk[Math.floor(x / cw * n)] || 0) * (h - 6));
      g.fillRect(x0 + x, mid - bar2 / 2, 1, bar2);
    }
  }
  g.globalAlpha = 1;
}
function recListen(withBacking) {
  recStopPlayers();
  if (!REC.buf) return;
  var a = ac(); a.resume();
  var at = a.currentTime + 0.05;
  var s = a.createBufferSource(); s.buffer = REC.buf; s.connect(master); s.start(at);
  REC.player.push(s);
  if (withBacking && M.mode !== 'extend') playBacking(recBacking(), at, REC.player);
}
function renderRecStatus() {
  var st = el('rec-status'), meter = el('rec-meter');
  if (!st || REC.state !== 'recording') return;
  var a = ac(), now = a.currentTime;
  if (now < REC.songStart) {
    var bar = barSeconds(), t0 = REC.songStart - S.countIn * bar;
    if (now < t0) { st.textContent = 'Get ready'; st.className = 'rec-status counting'; }
    else {
      var left = S.countIn - Math.floor((now - t0) / bar);
      st.textContent = 'Count-in, ' + left + ' bar' + (left > 1 ? 's' : '') + ' to go';
      st.className = 'rec-status counting';
    }
  } else {
    var p = now - REC.songStart;
    st.textContent = 'Recording ' + clockMs(p) + (REC.fixed ? ' / ' + clockMs(REC.fixed) : '');
    st.className = 'rec-status live';
  }
  if (meter) meter.style.width = Math.min(100, REC.level * 140) + '%';
}
function countInOptions() {
  return [0,1,2,4].map(function (n) { return '<option value="' + n + '"' + (n === S.countIn ? ' selected' : '') + '>' + n + ' bar' + (n === 1 ? '' : 's') + '</option>'; }).join('');
}
function renderRec() {
  if (REC.where === 'daw') { renderDawRec(); return; }
  var box = el('rec-box');
  if (!box) return;
  var extend = M.mode === 'extend';
  if (REC.hear === undefined) REC.hear = {};
  if (REC.click === undefined) REC.click = true;
  var err = REC.err ? '<p class="rec-err">' + esc(REC.err) + '</p>' : '';
  if (REC.state === 'recording' || REC.state === 'asking') {
    box.innerHTML = '<div class="rec-live"><div class="rec-status" id="rec-status">' +
      (REC.state === 'asking' ? 'Waiting for the microphone...' : '') + '</div>' +
      '<div class="rec-meterwrap"><i id="rec-meter"></i></div>' +
      '<div class="rec-acts">' + (REC.fixed
        ? '<button class="btn btn-ember" type="button" data-rec="finish">Stop and keep it</button>' +
          '<button class="btn btn-sm" type="button" data-rec="cancel">Stop and throw away</button>'
        : '<button class="btn btn-ember" type="button" data-rec="finish">Stop recording</button>' +
          '<button class="btn btn-sm" type="button" data-rec="cancel">Throw away</button>') +
      '</div>' + (REC.fixed ? '<p class="tiny muted">It stops by itself at the end of the track. Stop earlier and you keep what you played; the rest of the take is silence.</p>' : '') + '</div>';
    renderRecStatus();
    return;
  }
  if (REC.state === 'done') {
    box.innerHTML = '<div class="rec-done"><b>Recorded ' + (REC.partial ? clockMs(REC.partial) + ' of ' + clockMs(REC.fixed) : clockMs(REC.buf.duration)) + '</b>' +
      '<span class="tiny muted">' + (REC.partial
        ? 'You stopped early. The rest of the take is silence, so it still lines up with the track.'
        : 'Cut to start exactly at bar 1' + (REC.fixed ? ' and end with the track' : '') + '.') + '</span>' +
      '<div class="rec-acts">' +
        '<button class="btn btn-sm" type="button" data-rec="listen">Hear your take</button>' +
        (extend ? '' : '<button class="btn btn-sm" type="button" data-rec="listenmix">Hear it with the backing</button>') +
        '<button class="btn btn-sm" type="button" data-rec="again">Record again</button>' +
      '</div></div>' + err;
    return;
  }
  var list = extend ? '' : '<div class="rec-hear"><span class="rec-lbl">What you hear while recording</span>' +
    hearable().map(function (t) {
      var r = role(t.roleId), on = REC.hear[t.id] !== false;
      return '<label class="rec-opt"><input type="checkbox" data-hear="' + t.id + '"' + (on ? ' checked' : '') + '>' +
        ico(r.icon, col(r)) + '<span>' + esc(t.by || 'you') + ' <em>' + esc(labelOf(t)) + '</em></span></label>';
    }).join('') + '</div>';
  box.innerHTML = list +
    '<div class="rec-row">' +
      '<label class="rec-opt"><input type="checkbox" data-hear="click"' + (REC.click ? ' checked' : '') + '><span>Click</span></label>' +
      '<label class="mini"><span>count-in</span><select data-countin="1">' + countInOptions() + '</select></label>' +
    '</div>' +
    '<p class="tiny muted">Wear headphones, otherwise the backing ends up in your take. ' +
      (extend ? 'Stop whenever your part is done.' : 'Recording starts on the first beat of ' + esc((section(M.sec) || section('core')).label) +
        ' and stops by itself after ' + fmt(secLen(M.sec)) + '.') + '</p>' +
    '<button class="btn btn-ember rec-go" type="button" data-rec="start"><span class="rec-dot"></span> Start recording</button>' + err;
}

/* ---------- floor logic (creator only, enforced by the database) ---------- */
function letIn(t) {
  if (!t || !isHost()) return;
  var r = role(t.roleId), sec = secOf(t), here = inSong(t.roleId, sec);
  if (seedHolds(t.roleId, sec)) { flash('The original track plays ' + r.label.toLowerCase() + ', so there is no spot to let a layer into.'); return; }
  var msg = here.length >= cap(t.roleId, sec)
    ? t.by + ' takes over on ' + r.label.toLowerCase() + '. ' + here[0].by + ' is back in the waiting list.'
    : t.by + ' is in on ' + r.label.toLowerCase() + '.';
  if (S.trial === t.id) S.trial = null;
  S.override = null;
  stopAll();
  db.letIn(t.dbId).then(function () { flash(msg); return refresh(); }).catch(oops);
}
function veto(t) {
  if (!t || !isHost()) return;
  if (S.trial === t.id) S.trial = null;
  db.veto(t.dbId).then(function () { flash(t.by + ' was vetoed.'); return refresh(); }).catch(oops);
}
function keepPart(t) {
  if (!t || !isHost()) return;
  stopAll();
  if (S.trialPitch === t.id) S.trialPitch = null;
  db.letIn(t.dbId).then(function () {
    flash('The song just got longer: ' + t.by + '\'s part is in, ' + (t.pos === 'before' ? 'before' : 'after') + ' the track.');
    return refresh();
  }).catch(oops);
}
function passPart(t) {
  if (!t || !isHost()) return;
  if (S.trialPitch === t.id) { stopAll(); S.trialPitch = null; }
  db.veto(t.dbId).then(function () { flash('Passed on ' + t.by + '\'s part.'); return refresh(); }).catch(oops);
}
function dropPart(t) {
  if (!t || !isHost()) return;
  stopAll();
  db.dropPart(t.dbId).then(function () { flash('That part is out of the song again.'); return refresh(); }).catch(oops);
}
/* Deleting takes two clicks. The first click is remembered here, not on the button, so a
   re-render in between (audio arriving, a realtime refresh) doesn't forget it. */
var ARMED = { id:null, until:0, timer:0 };
function armedFor(id) { return ARMED.id === id && Date.now() < ARMED.until; }
function delBtn(id, small) {
  if (!isHost() || !isOpen()) return '';
  var armed = armedFor(id);
  return '<button class="' + (small ? 'tbtn' : 'btn btn-sm icobtn') + ' del' + (armed ? ' armed' : '') + '" type="button" data-del="' + id + '" ' +
    'title="' + (armed ? 'Click again to delete it for good' : 'Delete this take') + '" aria-label="' + (armed ? 'Click again to delete this take for good' : 'Delete this take') + '">' +
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4"/></svg>' +
    (armed ? '<span>Delete?</span>' : '') + '</button>';
}
function deleteTake(id) {
  var t = findTake(id);
  if (!t || t.id === 'seed' || !isHost()) return;
  var layers = t.roleId === 'part' ? S.members.concat(S.applicants).filter(function (m) { return m.sec === id; }).length : 0;
  stopAll();
  db.deleteTake(t.dbId).then(function () {
    flash('Deleted ' + (t.by || 'the take') + '\'s ' + role(t.roleId).label.toLowerCase() +
      (layers ? ', and the ' + layers + ' layer' + (layers > 1 ? 's' : '') + ' on it' : '') + '.');
    return refresh();
  }).catch(oops);
}
/* the creator sets fades and crossfades; everyone hears them */
function saveFades(t) {
  if (!t || !t.dbId || !isHost()) return;
  t.fadeBusy = true;
  db.setFades(t.dbId, { fadeIn:t.fin || 0, fadeOut:t.fout || 0, xfade:t.xfade || 0 })
    .catch(oops)
    .then(function () { t.fadeBusy = false; return refresh(); });
}

/* ---------- original track + session sheet ---------- */
var KEYS = (function () { var o = []; PCS.forEach(function (p) { o.push(p + ' maj'); o.push(p + ' min'); }); return o; })();
var TIMES = ['4/4','3/4','6/8','5/4','7/8','12/8','odd'];
var I_DL = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M8 1v9M4.5 6.5 8 10l3.5-3.5M2 13h12"/></svg>';
var I_PLAY  = '<svg width="12" height="12" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true"><path d="M2 1l6 4-6 4z"/></svg>';
var I_PAUSE = '<svg width="12" height="12" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true"><path d="M2 1h2.6v8H2zM5.4 1H8v8H5.4z"/></svg>';
var I_UP = '<svg class="db-ico" width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>';

var STEPS = {
  creator: {
    lead: 'One track, one decision-maker. The room stacks layers on top, and anyone can build their own version from every take.',
    steps: [
      ['The track sets the rules', 'Tempo and key are read from your file, and its length is the length of every layer.'],
      ['Anyone adds a layer', 'Play along in your DAW with the click, or record right here. One instrument per layer.'],
      ['You decide who joins', 'You dropped the track, so you let layers in or veto them. The people already in the project vote along to steer your call.'],
      ['You decide when it’s finished', 'Close the session when it feels right. It releases unmixed, and anyone can build their own version from every take.']
    ]
  },
  musician: {
    lead: 'Someone dropped a track and wants strangers to finish it. Add a layer, and the creator decides what makes the song.',
    steps: [
      ['Listen to the track', 'Tempo, key and length come from the creator’s track. Every layer has to fit them.'],
      ['Add your layer', 'Grab the click and the other takes, play along in your DAW, or record right here. One instrument per layer.'],
      ['The creator decides', 'Your take waits until the creator lets it in. Once you are in the project, your vote steers what comes next.'],
      ['Or make your own version', 'Use any take, record your own parts on top, and save your mix. Send a part to the creator whenever you like.']
    ]
  }
};
function renderHow() {
  var s = STEPS[asCreator() ? 'creator' : 'musician'];
  var steps = s.steps.map(function (x, i) {
    return '<div class="step"><span class="n">0' + (i + 1) + '</span><b>' + x[0] + '</b><p>' + x[1] + '</p></div>';
  }).join('');
  el('intro-p').textContent = s.lead;
  el('howsteps').innerHTML = steps;
  el('howtop').innerHTML = '<div class="how-lead"><h2>Make a <span class="hi">song</span> with <span class="hi">strangers</span></h2><p>' + s.lead + '</p></div>' + steps;
  document.body.classList.toggle('has-track', hasSeed());
}
function renderInstruments() {
  var box = el('instruments');
  if (!hasSeed()) { box.innerHTML = ''; return; }
  var inSongNow = S.members.filter(onKeptSection), ri = seedInstr();
  var chips = ROLES.map(function (r) {
    var n = inSongNow.filter(function (m) { return m.roleId === r.id; }).length;
    return n ? '<span class="ichip" style="--c:' + col(r) + '">' + ico(r.icon, col(r)) + r.label + (n > 1 ? ' <b>&times;' + n + '</b>' : '') + '</span>' : '';
  }).join('');
  box.innerHTML = '<span class="i-lbl">Current instruments</span>' +
    '<span class="ichip">' + ico('seed', 'var(--ember)') + 'Original track' + (ri ? ' <b>' + ri.label.toLowerCase() + '</b>' : '') + '</span>' +
    (partTakes().length ? '<span class="ichip">' + ico('part', 'var(--cyan)') + 'New parts <b>&times;' + partTakes().length + '</b></span>' : '') +
    (chips || '<span class="tiny muted">Nothing on top yet.</span>');
}
function canDropSeed() { return asCreator() && isOpen() && !S.seedBusy; }
/* the project's name: what the creator called it, or "<name>'s track" until they do */
function projName() {
  if (S.title && S.title !== 'Untitled') return S.title;
  return S.seed.by ? S.seed.by + '’s track' : 'Untitled';
}
/* the creator names (and renames) the project here; everyone else sees the name */
function renderProjTitle() {
  var box = el('projtitle');
  if (!box) return;
  box.style.display = hasSeed() && S.session ? '' : 'none';
  if (!hasSeed() || !S.session) { box.innerHTML = ''; return; }
  if (isHost()) {
    if (!el('proj-title')) {
      box.innerHTML = '<label class="pt-lbl" for="proj-title">Project name</label>' +
        '<input class="projname" id="proj-title" maxlength="120" autocomplete="off" placeholder="Name your project" aria-describedby="proj-hint">' +
        '<span class="tiny muted" id="proj-hint">Click to rename. Everyone sees the new name right away.</span>';
    }
    var f = el('proj-title');
    if (document.activeElement !== f) f.value = S.title && S.title !== 'Untitled' ? S.title : '';
    f.placeholder = 'Name your project, e.g. ' + projName();
  } else {
    box.innerHTML = '<div class="pt-lbl">Project</div><h2 class="projname">' + esc(projName()) + '</h2>';
  }
}
/* the big invitation to make your own version: most people start by playing with the takes */
function renderOwnCta() {
  var box = el('owncta');
  if (!box) return;
  box.style.display = hasSeed() && S.session ? '' : 'none';
  if (!hasSeed() || !S.session) { box.innerHTML = ''; return; }
  var building = S.view === 'build' && !S.override, n = pool().length;
  box.innerHTML = '<div class="oc-copy"><div class="kicker">Make it yours</div>' +
      '<h2>Make your own version</h2>' +
      '<p>Use every take in this project' + (n ? ' (' + n + ' so far)' : '') + ', the ones that made it and the ones that didn’t. ' +
      'Record or upload your own parts on top, as many as you like, and save your mix. Nobody has to let you in.</p></div>' +
    '<div class="oc-acts">' +
      '<button class="btn btn-ember btn-lg" type="button" data-ownstart="1">' + (building ? 'Go to your version' : 'Start your own version') + '</button>' +
      (isOpen() ? '<button class="btn btn-lg oc-alt" type="button" data-apply="">Add a layer to the project</button>' : '') +
    '</div>';
}
function renderSeed() {
  var s = S.seed, host = isHost(), loading = loadingCount(), ri = seedInstr();
  el('session-name').textContent = S.session ? projName() : 'New session';
  el('session-sub').textContent = (hasSeed() ? 'track loaded, ' + fmt(s.len) : 'no track yet') +
    (loading ? ', loading ' + loading + ' take(s)' : '') + (S.session && !isOpen() ? ', closed' : '');
  el('seedpanel').className = 'seed' + (hasSeed() ? '' : ' empty');
  el('metabar').style.display = hasSeed() ? '' : 'none';
  el('metabar').classList.toggle('readonly', !host);

  if (hasSeed()) {
    el('seedpanel').innerHTML =
      '<button class="play' + (only === 'seed' ? ' on' : '') + '" type="button" data-prev="seed" aria-label="Play the original track"' + (s.buf ? '' : ' disabled') + '>' +
        (only === 'seed' ? I_PAUSE : I_PLAY) + '</button>' +
      '<div><div class="kicker">The original track' + (ri ? ', ' + ri.label.toLowerCase() : '') + '</div>' +
      '<div class="who">' + (host ? 'Your track' : esc(s.by) + '’s track') + ', ' + fmt(s.len) + (s.buf ? '' : ' <span class="tiny muted">loading</span>') + '</div>' +
      seedWave() + '</div>' +
      '<div class="seed-side"><div class="facts" id="facts"></div>' +
      (host && isOpen() ? '<button class="btn btn-sm" type="button" data-attach="seed"' + (S.seedBusy ? ' disabled' : '') + '>' +
        (S.seedBusy ? 'Uploading...' : 'Replace the track') + '</button>' : '') + '</div>';
  } else if (asCreator()) {
    el('seedpanel').innerHTML = '<div class="dropbig">' + I_UP +
      '<h2>Drop an audio track</h2>' +
      '<p>A riff, a groove or a vocal. Drag it in, and other musicians stack layers on top until it sounds right to you. ' +
      'You get a link to share.</p>' +
      '<div class="db-fields">' +
        '<label class="field seed-name"><span>Your name</span><input type="text" id="seed-by" maxlength="60" placeholder="how you show up in the credits" value="' + esc(savedName()) + '"></label>' +
        '<label class="field seed-name"><span>What is it</span><select id="seed-role">' +
          '<option value="" selected disabled>Pick one</option><option value="none">Not one instrument</option>' +
          ROLES.map(function (r) { return '<option value="' + r.id + '">' + r.label + '</option>'; }).join('') + '</select></label>' +
      '</div>' +
      (S.pendingSeed && !S.seedBusy
        ? '<div class="db-pending"><span class="tiny"><b>' + esc(S.pendingSeed.name) + '</b> is ready. Fill in your name and what it is, then start.</span>' +
          (S.seedErr ? '<p class="db-err" role="alert">' + esc(S.seedErr) + '</p>' : '') +
          '<button class="btn btn-ember" type="button" data-seedgo="1">Start the session with this track</button>' +
          '<button class="btn btn-sm" type="button" data-attach="seed">Choose another file</button></div>'
        : '<button class="btn btn-ember" type="button" data-attach="seed"' + (S.seedBusy ? ' disabled' : '') + '>' +
            (S.seedBusy ? 'Uploading...' : 'Choose a file') + '</button>' +
          '<span class="tiny muted">wav, mp3 or m4a</span>') +
    '</div>';
  } else {
    el('seedpanel').innerHTML = '<div class="dropbig wait">' + I_UP +
      '<h2>Waiting for the track</h2>' +
      '<p>The creator has not dropped a track yet. This page updates by itself when they do.</p></div>';
  }

  if (hasSeed()) {
    var m = S.meta;
    el('facts').innerHTML =
      '<div><b>' + (m.bpm || '?') + '</b><small>bpm</small></div>' +
      '<div><b>' + (m.key || '?') + '</b><small>key</small></div>' +
      '<div><b>' + m.time + '</b><small>time</small></div>' +
      '<div><b>' + fmt(s.len) + '</b><small>length</small></div>';
    bindViz(); drawViz(running || Object.keys(sources).length > 0);
  }

  var note;
  if (!hasSeed()) note = 'Drop a track and the tempo and key get read from the audio.';
  else if (S.meta.busy) note = 'Listening to your file, one moment.';
  else if (!host) note = 'Set by the creator. Play to this tempo and key.';
  else if (S.meta.from === 'detected') note = 'Read from your audio, ' + (S.meta.sure || 'not certain') + '.' +
    (S.meta.alt ? ' Could also be ' + S.meta.alt + '.' : '') + ' Time signature is your call.';
  else note = 'Set by you.';

  var off = host ? '' : ' disabled';
  el('metabar').innerHTML = hasSeed()
    ? '<label class="mini"><span>bpm</span><input type="number" id="meta-bpm" min="40" max="240" value="' + (S.meta.bpm || '') + '"' + off + '></label>' +
      '<label class="mini"><span>key</span><select id="meta-key"' + off + '>' +
        KEYS.map(function (k) { return '<option' + (k === S.meta.key ? ' selected' : '') + '>' + k + '</option>'; }).join('') +
      '</select></label>' +
      '<label class="mini"><span>time</span><select id="meta-time"' + off + '>' +
        TIMES.map(function (t) { return '<option' + (t === S.meta.time ? ' selected' : '') + '>' + t + '</option>'; }).join('') +
      '</select></label>' +
      '<label class="mini"><span>track is</span><select id="meta-seedrole"' + (host && isOpen() ? '' : ' disabled') + '>' + seedRoleOptions(S.meta.seedRole, 'not one instrument') + '</select></label>' +
      '<span class="tiny muted">' + note + '</span>'
    : '<span class="tiny muted">' + note + '</span>';
}

/* ---------- the DAW view ---------- */
function barSeconds() {
  var bpm = S.meta.bpm || 120, t = S.meta.time === 'odd' ? '4/4' : S.meta.time;
  var p = t.split('/'), beats = +p[0] || 4, unit = +p[1] || 4;
  return beats * (60 / bpm) * (4 / unit);
}
function dawTabs() {
  var building = S.view === 'build' && !S.override;
  return '<div class="dawtabs" role="tablist" aria-label="What plays">' +
    '<button type="button" role="tab" data-view="lineup" aria-selected="' + (!building && !S.override) + '">Main project</button>' +
    '<button type="button" role="tab" data-view="build" aria-selected="' + building + '">Build your own<span class="long"> version</span></button>' +
    '</div>';
}
function renderDaw() {
  var list = tracks(), d = duration();
  var banner = '';
  if (S.override) {
    banner = '<div class="listening"><span>Listening to <b>' + esc(S.override.name) + '</b> by ' + esc(S.override.by) + '</span>' +
      '<button class="btn btn-sm" type="button" data-fork="' + S.override.id + '">Build on this one</button>' +
      '<button class="btn btn-sm" type="button" data-view="lineup">Back to the main project</button></div>';
  } else if (S.view === 'build') {
    var mineOwn = S.own.filter(mine).length;
    banner = '<div class="listening build"><span><b>Your version.</b> The original track is always in. Pick any take below, ' +
      'including ones that were vetoed or are still waiting, or record your own.' +
      (mineOwn && isOpen() ? ' Like one of your own recordings? Send it to the creator from the list below.' : '') + '</span>' +
      '<button class="btn btn-sm btn-ember" type="button" data-own="">+ Record or upload your own</button></div>';
  }
  if (!list.length) {
    el('daw').innerHTML = dawTabs() + banner + '<div class="empty-state"><b>' + (hasSeed() ? 'Loading audio' : 'No audio yet') + '</b>' +
      '<p class="tiny muted">' + (hasSeed() ? 'The takes are coming down from storage.' : 'Drop an audio track, then let layers in. They stack up here like tracks in a DAW.') + '</p></div>';
    renderPicker();
    renderPitches();
    return;
  }
  var bs = barSeconds(), barCount = Math.max(1, Math.ceil(d / bs));
  var ticks = '';
  for (var i = 0; i < barCount; i++) {
    ticks += '<span class="tick' + (i % 4 === 0 ? ' major' : '') + '" style="left:' + (i * bs / d * 100) + '%">' +
      (i % 4 === 0 || barCount < 17 ? (i + 1) : '') + '</span>';
  }

  var building = S.view === 'build' && !S.override, host = isHost();
  var lineupView = !S.override && !building, boss = lineupView && host && isOpen();
  var rows = list.map(function (t) {
    var r = role(t.roleId), c = ctl(t), v = volOf(t);
    var isTrial = lineupView && S.trial === t.id;
    var isPart = t.roleId === 'part', isPitch = isPart && S.pitches.indexOf(t) > -1;
    var status = '';
    if (isPart) status = isPitch ? 'pitch, ' + t.pos : t.pos;
    else if (!lineupView) {
      if (t.id !== 'seed' && S.members.indexOf(t) < 0) status = isOwn(t) ? 'own' : standing(t);
    }
    return '<div class="track' + (c.mute ? ' muted-t' : '') + (c.solo ? ' solo-t' : '') + (isTrial || isPitch ? ' trial' : '') + (isPart ? ' part' : '') + '">' +
      '<div class="t-head">' +
        '<div class="t-name">' + ico(r.icon, col(r)) +
          '<div><b>' + esc(t.by || 'you') + (isTrial ? ' <span class="trybadge">trying out</span>' : '') +
          (status ? ' <span class="stag">' + status + '</span>' : '') + '</b>' +
          '<span class="tiny muted">' + esc(labelOf(t)) + (t.id !== 'seed' ? ' ' + secTag(t) + verTag(t.id) : '') + '</span></div>' +
          (building && t.id !== 'seed' && !isPart ? '<button class="tbtn rm" type="button" data-pick="' + t.id + '" title="Take it out of your version" aria-label="Remove ' + esc(t.by) + ' from your version">&times;</button>' : '') +
          (boss && isPart && !isPitch ? '<button class="tbtn rm" type="button" data-droppart="' + t.id + '" title="Take this part out of the song" aria-label="Take the part by ' + esc(t.by) + ' out of the song">&times;</button>' : '') +
          (boss && !isPart && t.id !== 'seed' && S.members.indexOf(t) > -1 ? '<button class="tbtn rm" type="button" data-takeout="' + t.id + '" title="Take it out of the project (it stays usable in versions)" aria-label="Take the layer by ' + esc(t.by) + ' out of the project">&times;</button>' : '') +
        '</div>' +
        (isPitch && boss ? '<div class="t-try">' +
          '<button class="btn btn-sm btn-ember" type="button" data-accpitch="' + t.id + '">Keep it</button>' +
          '<button class="btn btn-sm" type="button" data-untrialpitch="1">Take it out</button></div>' : '') +
        (isTrial ? voteBlock(t) + '<div class="t-try">' +
          (host && isOpen() && !seedHolds(t.roleId, secOf(t)) ? '<button class="btn btn-sm btn-ember" type="button" data-yes="' + t.id + '">Let it in</button>' : '') +
          '<button class="btn btn-sm" type="button" data-untrial="1">Take it out</button></div>' : '') +
        '<div class="t-ctrl">' +
          '<button class="tbtn play-t' + (only === t.id ? ' on' : '') + '" type="button" data-prev="' + t.id + '" title="Play just this track" aria-label="Play only the take by ' + esc(t.by) + '">' +
            (only === t.id ? I_PAUSE : I_PLAY) + '</button>' +
          '<button class="tbtn' + (c.mute ? ' on' : '') + '" type="button" data-mute="' + t.id + '" aria-pressed="' + !!c.mute + '" title="Mute">M</button>' +
          '<button class="tbtn' + (c.solo ? ' on solo' : '') + '" type="button" data-solo="' + t.id + '" aria-pressed="' + !!c.solo + '" title="Solo">S</button>' +
          '<input type="range" min="0" max="1" step="0.02" value="' + v + '" data-vol="' + t.id + '" aria-label="Volume for ' + esc(t.by) + '">' +
          '<button class="tbtn" type="button" data-dl="' + t.id + '" title="Download this take">' + I_DL + '</button>' +

        '</div>' +
        '<div class="t-fx">' + knob(t, 'hp') + knob(t, 'lp') + '</div>' +
        (boss && isPart ? '<label class="xf"><span>crossfade</span>' +
          '<input type="range" min="0" max="' + xfMax(t).toFixed(1) + '" step="0.1" value="' + xf(t) + '" data-xfade="' + t.id + '" aria-label="Crossfade for the part by ' + esc(t.by) + '">' +
          '<em>' + xf(t).toFixed(1) + ' s</em></label>' : '') +
      '</div>' +
      '<div class="t-lane" data-seek="1">' +
        '<canvas data-wave="' + t.id + '" height="72"></canvas>' +
        (boss ? '<span class="fh fh-in" data-fh="in" data-id="' + t.id + '" title="Drag to fade in" role="slider" aria-label="Fade in"></span>' +
                '<span class="fh fh-out" data-fh="out" data-id="' + t.id + '" title="Drag to fade out" role="slider" aria-label="Fade out"></span>' : '') +
        (t.id !== 'seed' && !isPart && t.len < secLen(secOf(t)) - .05 ? '<span class="short">shorter than its section</span>' : '') +
        (t.id === 'seed' && lineupView && S.session && isOpen() ? extendButtons() : '') +
      '</div></div>';
  }).join('');

  el('daw').innerHTML = dawTabs() + banner +
    '<div class="daw-bar">' +
      '<button class="btn btn-ember" type="button" id="transport">' + (running ? I_PAUSE + ' Stop' : I_PLAY + ' Play') + '</button>' +
      '<button class="btn btn-sm" type="button" id="rewind" title="Back to the start">&#9198;</button>' +
      '<span class="readout" id="readout">' + clockMs(position()) + ' / ' + clockMs(d) + '</span>' +
      '<span class="tiny muted">' + list.length + ' track(s), ' + barCount + ' bars at ' + (S.meta.bpm || '?') + ' bpm ' + S.meta.time + '</span>' +
      '<span class="clickctl"><label class="mini"><span>count-in</span><select data-countin="1">' + countInOptions() + '</select></label>' +
      '<button class="btn btn-sm" type="button" id="dl-click" title="A click at the session tempo, with the count-in in front">' + I_DL + ' Click track</button></span>' +
      '<button class="btn btn-sm" type="button" id="dl-all">' + I_DL + ' Download these takes</button>' +
    '</div>' +
    '<div class="ruler"><span class="r-head"></span><span class="r-lane">' + ticks + '</span></div>' +
    '<div class="tracks">' + rows + addRow(building) + '</div>' +
    '<div class="playhead" id="playhead"></div>';

  list.forEach(function (t) { drawWave(t); });
  drawRecLane();
  placeFadeHandles();
  placeExtendButtons();
  renderPicker();
  renderPitches();
  tick();
}
/* an empty grey track under the others: record straight onto it (the playhead runs over the
   other tracks while you play), or upload a file. In the main project the take goes to the
   creator; in your own version it goes straight in. Not shown while listening to someone
   else's version. */
function addRow(building) {
  if (S.override || (!building && !isOpen())) return '';
  return '<div class="track addrow' + (REC.where === 'daw' && REC.state !== 'idle' ? ' rec-on' : '') + '" id="addrow">' + addRowInner(building) + '</div>';
}
function addRowInner(building) {
  var dawRec = REC.where === 'daw', st = dawRec ? REC.state : 'idle';
  var rid = S.recRole || ROLES[0].id, r = role(rid);
  var err = dawRec && REC.err ? '<span class="rec-err">' + esc(REC.err) + '</span>' : '';
  var head, lane;
  if (st === 'recording' || st === 'asking') {
    head = '<div class="t-name">' + ico(r.icon, col(r)) + '<div><b>Recording</b><span class="tiny muted">' + esc(r.label) + '</span></div></div>' +
      '<div class="rec-status" id="rec-status">' + (st === 'asking' ? 'Waiting for the microphone...' : '') + '</div>' +
      '<div class="rec-meterwrap"><i id="rec-meter"></i></div>';
    lane = '<canvas id="rec-canvas"></canvas><div class="rec-float">' +
      '<button class="btn btn-sm btn-ember" type="button" data-rec="finish">Stop and keep it</button>' +
      '<button class="btn btn-sm" type="button" data-rec="cancel">Throw away</button></div>';
  } else if (st === 'done') {
    head = '<div class="t-name">' + ico(r.icon, col(r)) + '<div><b>Your take</b><span class="tiny muted">' + esc(r.label) + ', ' +
      (REC.partial ? clockMs(REC.partial) + ' played, rest silent' : clockMs(REC.buf.duration)) + '</span></div></div>';
    lane = '<canvas id="rec-canvas"></canvas><div class="rec-float">' +
      '<button class="btn btn-sm btn-ember" type="button" data-dawsend="1">' + (building ? 'Add it to my version' : 'Send it in') + '</button>' +
      '<button class="btn btn-sm" type="button" data-rec="listenmix">Hear it with the rest</button>' +
      '<button class="btn btn-sm" type="button" data-dawrec="1">Record again</button>' +
      '<button class="btn btn-sm" type="button" data-dawdrop="1">Throw away</button></div>';
  } else {
    head = '<div class="t-name"><span class="add-ico" aria-hidden="true">+</span>' +
      '<div><b>Your layer</b><span class="tiny muted">' + (building ? 'only in your version' : 'for the project') + '</span></div></div>' +
      '<select class="rec-role" id="daw-rec-role" aria-label="Instrument for your layer">' +
        ROLES.map(function (x) { return '<option value="' + x.id + '"' + (x.id === rid ? ' selected' : '') + '>' + x.label + '</option>'; }).join('') +
      '</select>';
    lane = '<div class="a-lane"><span>' + (building
        ? 'Add any instrument to your version. Record it right here on this track, or upload a file.'
        : 'Play along and record your layer right here, or upload a file. The creator decides if it gets in.') +
      ' <em>Wear headphones.</em></span>' +
      '<button class="btn btn-ember" type="button" data-dawrec="1"><span class="rec-dot"></span> Record here</button>' +
      '<button class="btn" type="button" ' + (building ? 'data-own=""' : 'data-apply=""') + '>Upload a file</button>' + err + '</div>';
  }
  return '<div class="t-head">' + head + '</div>' + (st === 'idle' ? lane : '<div class="rec-lane">' + lane + '</div>');
}
function placeFadeHandles() {
  var d = duration(); if (!d) return;
  [].forEach.call(document.querySelectorAll('.fh'), function (h) {
    var t = findTake(h.dataset.id); if (!t) return;
    var st = startOf(t), e = envOf(t);
    var sec = h.dataset.fh === 'in' ? st + e.fi : st + t.len - e.fo;
    h.style.left = (sec / d * 100) + '%';
    h.setAttribute('aria-valuenow', (h.dataset.fh === 'in' ? e.fi : e.fo).toFixed(1));
    h.title = (h.dataset.fh === 'in' ? 'Fade in ' : 'Fade out ') + (h.dataset.fh === 'in' ? e.fi : e.fo).toFixed(1) + ' s, drag to change';
  });
}
/* dragging a fade handle */
var drag = null, justDragged = false;
document.addEventListener('pointerdown', function (e) {
  var h = e.target.closest('.fh');
  if (!h) return;
  e.preventDefault(); e.stopPropagation();
  var t = findTake(h.dataset.id), lane = h.parentNode;
  if (!t) return;
  drag = { h:h, t:t, rect:lane.getBoundingClientRect(), d:duration(), st:startOf(t), kind:h.dataset.fh };
  h.setPointerCapture(e.pointerId);
  h.classList.add('on');
});
document.addEventListener('pointermove', function (e) {
  if (!drag) return;
  var sec = (e.clientX - drag.rect.left) / drag.rect.width * drag.d, t = drag.t;
  if (drag.kind === 'in') t.fin = Math.max(0, Math.min(t.len / 2, sec - drag.st));
  else t.fout = Math.max(0, Math.min(t.len / 2, drag.st + t.len - sec));
  if ((drag.kind === 'in' ? t.fin : t.fout) < 0.05) { if (drag.kind === 'in') t.fin = 0; else t.fout = 0; }
  drawWave(t); placeFadeHandles();
  flash((drag.kind === 'in' ? 'Fade in ' : 'Fade out ') + (drag.kind === 'in' ? t.fin : t.fout).toFixed(1) + ' s on ' + (t.by || 'the original track') + '.');
});
function endDrag() {
  if (!drag) return;
  var t = drag.t;
  drag.h.classList.remove('on');
  drag = null; justDragged = true;
  setTimeout(function () { justDragged = false; }, 50);
  saveFades(t);
  if (running) play(position());
}
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);
function extendButtons() {
  return '<button class="extend ext-before" type="button" data-extend="before" title="Write a part before this" aria-label="Write a new part before the song">+</button>' +
    '<button class="extend ext-after" type="button" data-extend="after" title="Write a part after this" aria-label="Write a new part after the song">+</button>';
}
/* the + buttons sit on the edges of the song */
function placeExtendButtons() {
  var d = duration(); if (!d) return;
  var b = document.querySelector('.ext-before'), a = document.querySelector('.ext-after');
  if (b) b.style.left = 'calc(0% + 6px)';
  if (a) a.style.left = 'calc(100% - 34px)';
}
function renderPitches() {
  var box = el('pitches');
  if (!box) return;
  var show = S.pitches.length && !S.override && S.view === 'lineup';
  box.style.display = show ? '' : 'none';
  if (!show) { box.innerHTML = ''; return; }
  var boss = isHost() && isOpen();
  box.innerHTML = '<div class="pt-head"><b>New parts pitched</b><span class="tiny muted">Someone wants the song to go somewhere new. Hear it in place, then keep it or pass.</span></div>' +
    S.pitches.map(function (t) {
      var on = only === t.id, tr = S.trialPitch === t.id;
      return '<div class="pt-row">' +
        '<button class="play sm' + (on ? ' on' : '') + '" type="button" data-prev="' + t.id + '" aria-label="Hear the part by ' + esc(t.by) + ' on its own"' + (t.buf ? '' : ' disabled') + '>' + (on ? I_PAUSE : I_PLAY) + '</button>' +
        '<div class="pt-who"><b>' + esc(t.by) + '</b><span class="tiny muted">' + fmt(t.len) + ', ' + (t.pos === 'before' ? 'before' : 'after') + ' the track</span>' +
        (t.note ? '<span class="note">&ldquo;' + esc(t.note) + '&rdquo;</span>' : '') + '</div>' +
        (tr ? mixToggle('this part') : '') +
        '<button class="btn btn-sm' + (tr ? ' trybtn on' : '') + '" type="button" data-trypitch="' + t.id + '"' + (t.buf ? '' : ' disabled') + '>' + (tr ? 'Take it out' : 'Hear it in place') + '</button>' +
        delBtn(t.id) +
        (boss ? '<button class="btn btn-sm btn-ember" type="button" data-accpitch="' + t.id + '">Keep it</button>' +
        '<button class="btn btn-sm btn-veto" type="button" data-passpitch="' + t.id + '">Pass</button>' : '<span class="tiny muted">The creator decides</span>') + '</div>';
    }).join('');
}

/* ---------- version builder ---------- */
function renderPicker() {
  var box = el('picker');
  if (!box) return;
  var building = S.view === 'build' && !S.override;
  box.style.display = building ? '' : 'none';
  if (!building) return;
  var all = pool();
  var cols = ROLES.map(function (r) {
    var takes = all.filter(function (t) { return t.roleId === r.id; });
    var items = takes.length ? takes.map(function (t) {
      var picked = S.build.picks.indexOf(t.id) > -1;
      var status = standing(t);
      var on = only === t.id, sendable = isOwn(t) && mine(t) && isOpen();
      return '<li class="pk' + (picked ? ' picked' : '') + (isOwn(t) ? ' own' : '') + '">' +
        '<button class="play sm' + (on ? ' on' : '') + '" type="button" data-prev="' + t.id + '" aria-label="Hear ' + esc(t.by) + ' on its own">' +
          (on ? I_PAUSE : I_PLAY) + '</button>' +
        '<div class="pk-who"><b>' + esc(t.by) + '</b><span>' + status + (secOf(t) !== 'core' ? ', ' + secTag(t) : '') + '</span></div>' +
        '<button class="btn btn-sm pk-btn' + (picked ? ' on' : '') + '" type="button" data-pick="' + t.id + '" aria-pressed="' + picked + '">' +
          (picked ? 'In' : 'Add') + '</button>' +
        (sendable ? '<button class="pk-send" type="button" data-sendown="' + t.id + '" title="The creator hears it and lets it into the project, or not">Send to the creator</button>' : '') +
        '</li>';
    }).join('') : '<li class="empty">No takes yet.</li>';
    return '<div class="pk-col' + (takes.length ? '' : ' none') + '" style="color:' + col(r) + '"><div class="pk-head">' + ico(r.icon, col(r)) + '<b>' + r.label + '</b></div>' +
      '<ul>' + items + '</ul>' +
      '<button class="pk-rec" type="button" data-own="' + r.id + '">+ Record or upload ' + esc(r.label.toLowerCase()) + '</button></div>';
  }).join('');

  box.innerHTML =
    '<div class="pk-grid">' + cols + '</div>' +
    '<div class="pk-save">' +
      '<label class="field"><span>Name your version</span><input type="text" id="ver-name" maxlength="60" placeholder="e.g. The one with both basses"></label>' +
      '<label class="field"><span>Your name</span><input type="text" id="ver-by" maxlength="60" placeholder="how you show up under the session" value="' + esc(savedName()) + '"></label>' +
      '<button class="btn btn-ember" type="button" id="ver-save"' + (S.build.picks.length && S.session ? '' : ' disabled') + '>Save this version</button>' +
      '<span class="tiny muted">' + S.build.picks.length + ' take(s) on top of the original track. Only the choice is saved, nothing gets re-uploaded.</span>' +
    '</div>';
}
function versionCard(v) {
  var on = S.override && S.override.id === v.id && running;
  var chips = byIds(v.picks).map(function (t) {
    var r = role(t.roleId);
    return '<span class="vchip">' + ico(r.icon, col(r)) + esc(t.by) + '</span>';
  }).join('');
  return '<article class="vcard">' +
    '<div class="vc-top"><button class="play' + (on ? ' on' : '') + '" type="button" data-playver="' + v.id + '" aria-label="Play ' + esc(v.name) + '">' +
      (on ? I_PAUSE : I_PLAY) + '</button>' +
    '<div><b>' + esc(v.name) + '</b><span class="tiny muted">by ' + esc(v.by) + ', ' + livePicks(v.picks).length + ' take(s) on the original</span></div></div>' +
    '<div class="vc-chips">' + chips + '</div>' +
    '<div class="vc-foot"><button class="btn btn-sm' + (v.liked ? ' on' : '') + '" type="button" data-like="' + v.id + '"' +
      (v.liked ? ' disabled aria-label="You liked this"' : '') + '>&#9829; ' + v.likes + '</button>' +
    '<button class="btn btn-sm" type="button" data-fork="' + v.id + '">Build on this one</button></div></article>';
}
function officialCard() {
  var on = !S.override && S.view !== 'build' && running;
  return '<article class="vcard official">' +
    '<div class="vc-top"><button class="play' + (on ? ' on' : '') + '" type="button" data-playofficial="1" aria-label="Play the official project">' +
      (on ? I_PAUSE : I_PLAY) + '</button>' +
    '<div><b>Main project</b><span class="tiny muted">official, chosen by the creator</span></div></div>' +
    '<div class="vc-chips">' + S.members.filter(onKeptSection).map(function (t) {
      var r = role(t.roleId);
      return '<span class="vchip">' + ico(r.icon, col(r)) + esc(t.by) + '</span>';
    }).join('') + '</div></article>';
}
function renderVersionLists() {
  var sorted = S.versions.slice().sort(function (a, b) { return b.likes - a.likes; });
  var html = officialCard() + sorted.map(versionCard).join('');
  ['fanmixes', 'rel-fanmixes'].forEach(function (id) { if (el(id)) el(id).innerHTML = html; });
  if (el('fan-sub')) el('fan-sub').textContent = S.versions.length
    ? S.versions.length + ' version(s) from the room, sorted by hearts. The official project stays on top.'
    : 'Nobody has built their own version yet. Switch to "Build your own version" above the tracks to make one.';
  if (el('play-raw')) el('play-raw').textContent = (running && !S.override) ? 'Stop' : 'Play it raw';
}
function playVersion(v) {
  if (S.override && S.override.id === v.id && running) { stopAll(); return; }
  stopAll();
  S.override = { id:v.id, name:v.name, by:v.by, picks:v.picks.slice(), ctl:JSON.parse(JSON.stringify(v.ctl || {})) };
  S.trial = null;
  refreshGains();
  play(0);
  flash('Playing "' + v.name + '".');
}
function drawWave(t) {
  var c = document.querySelector('[data-wave="' + t.id + '"]');
  if (!c || !t.peaks) return;
  var dpr = window.devicePixelRatio || 1;
  var w = c.clientWidth || 600, h = 72;
  c.width = w * dpr; c.height = h * dpr;
  var g = c.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  var d = duration() || t.len, st = startOf(t);
  var x0 = Math.round(st / d * w), x1 = Math.round((st + t.len) / d * w), cw = Math.max(1, x1 - x0);
  g.fillStyle = cvar(role(t.roleId).color);
  g.globalAlpha = .08;
  g.fillRect(x0, 2, cw, h - 4);
  g.globalAlpha = ctl(t).mute ? .3 : .85;
  var n = t.peaks.length, mid = h / 2;
  var e = envOf(t);
  for (var x = 0; x < cw; x++) {
    var p = (t.peaks[Math.floor(x / cw * n)] || 0) * envAt(x / cw * t.len, t.len, e);
    var bar = Math.max(1, p * (h - 6));
    g.fillRect(x0 + x, mid - bar / 2, 1, bar);
  }
  g.globalAlpha = .9;
  g.strokeStyle = cvar('--ink'); g.lineWidth = 1.25;
  if (e.fi > 0.01) { g.beginPath(); g.moveTo(x0, h - 3); g.lineTo(x0 + e.fi / t.len * cw, 3); g.stroke(); }
  if (e.fo > 0.01) { g.beginPath(); g.moveTo(x1 - e.fo / t.len * cw, 3); g.lineTo(x1, h - 3); g.stroke(); }
  g.globalAlpha = 1;
}

/* ---------- waiting board ---------- */
function anLine(t) {
  if (!t.an || !t.an.bpm) return '';
  var off = S.meta.bpm && Math.abs(t.an.bpm - S.meta.bpm) > 2;
  return '<div class="an' + (off ? ' off' : '') + '">' + t.an.bpm + ' bpm, ' + t.an.key + (off ? ' — off the session tempo' : '') + '</div>';
}
function applyCard(r) {
  var list = waitingFor(r.id), host = isHost(), held = seedHolds(r.id);
  var body = list.length ? list.map(function (t) {
    var on = only === t.id && running;
    return '<li class="app">' +
      '<div class="app-top">' +
        '<button class="play sm' + (on ? ' on' : '') + '" type="button" data-prev="' + t.id + '" aria-label="Preview the take by ' + esc(t.by) + '">' +
          (on ? I_PAUSE : I_PLAY) + '</button>' +
        '<b>' + esc(t.by) + '</b><span class="len">' + fmt(t.len) + '</span>' +
        '<button class="btn btn-sm icobtn" type="button" data-dl="' + t.id + '" aria-label="Download this take">' + I_DL + '</button>' +
        delBtn(t.id) +
      '</div>' + anLine(t) + (secTag(t) || inVersions(t.id) ? '<div class="vline">' + secTag(t) + verTag(t.id) + '</div>' : '') +
      voteBlock(t) +
      (S.trial === t.id
        ? '<div class="trypair">' + mixToggle('this take') +
          '<button class="btn btn-sm trybtn on" type="button" data-try="' + t.id + '">Take out of the mix</button></div>'
        : '<button class="btn btn-sm trybtn" type="button" data-try="' + t.id + '">Hear it in the mix</button>') +
      (t.note ? '<div class="note">&ldquo;' + esc(t.note) + '&rdquo;</div>' : '') +
      (host && isOpen()
        ? '<div class="app-foot"><span class="acts">' +
          (seedHolds(t.roleId, secOf(t)) ? '' : '<button class="btn btn-sm btn-ember" type="button" data-yes="' + t.id + '">Let it in</button>') +
          '<button class="btn btn-sm btn-veto" type="button" data-no="' + t.id + '">Veto</button></span></div>'
        : '<div class="app-foot"><span class="tiny muted">Waiting for the creator</span></div>') +
      '</li>';
  }).join('') : '<li class="empty">Nothing waiting here.</li>';

  return '<article class="gate apply" style="color:' + col(r) + '">' +
    '<div class="g-top"><div class="g-name">' + ico(r.icon, col(r)) + '<h3>' + r.label + '</h3>' +
    '<span class="count">' + list.length + '</span></div>' +
    '<div class="tiny muted">' + (held ? 'The original track plays this part' : 'No limit, the creator decides') + '</div></div>' +
    '<ul class="takes">' + body + '</ul>' +
    '<div class="g-foot"><button class="btn btn-ember btn-sm" type="button" data-apply="' + r.id + '"' + (isOpen() ? '' : ' disabled') + '>Send a take</button></div></article>';
}

function renderBoards() {
  el('applyboard').innerHTML = ROLES.map(applyCard).join('');
  el('lineup-sub').textContent = S.members.length
    ? S.members.length + ' layer(s) on top of the original track.'
    : 'Nothing in the song yet. Everything starts in the waiting list below.';
  el('apply-sub').textContent = !S.applicants.length
    ? 'Empty. Use "Send a take" on any instrument to send one in.'
    : isHost()
      ? 'You dropped the track, so your yes or veto is final. Everyone in the project votes along to steer you. Whoever holds a spot does not vote on their own replacement.'
      : 'The creator decides. If you have a layer in the project, your vote steers them.';
}
function renderArchive() {
  var show = S.archive.length > 0;
  el('archive-head').style.display = show ? '' : 'none';
  el('archive').style.display = show ? '' : 'none';
  if (!show) return;
  el('archive').innerHTML = '<ul class="rows">' + S.archive.slice().reverse().map(function (a) {
    var r = role(a.take.roleId);
    return '<li class="row">' + ico(r.icon, col(r)) +
      '<div><b>' + esc(a.take.by) + '</b><div class="meta">' + r.label + ', ' + a.why + ' ' + secTag(a.take) + verTag(a.take.id) + '</div></div>' +
      '<button class="btn btn-sm icobtn" type="button" data-dl="' + a.take.id + '" aria-label="Download">' + I_DL + '</button>' +
      delBtn(a.take.id) +
      '<button class="btn btn-sm" type="button" data-apply="' + r.id + '"' + (isOpen() ? '' : ' disabled') + '>Try again</button></li>';
  }).join('') + '</ul>';
}
function renderLock() {
  el('lock-status').innerHTML = S.members.length + ' take(s) in the song, ' + S.applicants.length + ' waiting' +
    (hasSeed() ? '' : ', <strong>no track yet</strong>') +
    (S.session && !isOpen() ? ', <strong>session closed</strong>' : '');
  var btn = el('lock-btn');
  btn.style.display = isHost() && isOpen() ? '' : 'none';
  btn.disabled = !(hasSeed() && S.members.length);
}

/* Filter knobs. Drag up/down (or use the arrow keys) to turn, double-click to open the filter again. */
var KNOB = { hp:{ label:'Low cut', long:'Low cut (high-pass filter)' }, lp:{ label:'High cut', long:'High cut (low-pass filter)' } };
function knob(t, kind) {
  var hz = cutOf(t, kind), k = hzToKnob(hz), open = kind === 'hp' ? hz <= F_MIN : hz >= F_MAX;
  return '<div class="kn' + (open ? '' : ' act') + '">' +
    '<span class="knob" id="knob-' + kind + '-' + t.id + '" role="slider" tabindex="0" data-knob="' + kind + '" data-take="' + t.id + '"' +
      ' aria-label="' + KNOB[kind].long + ' for ' + esc(t.by || 'you') + '" aria-valuemin="' + F_MIN + '" aria-valuemax="' + F_MAX + '"' +
      ' aria-valuenow="' + hz + '" aria-valuetext="' + (open ? 'off' : fmtHz(hz)) + '" title="' + KNOB[kind].long + '. Double-click to reset."' +
      ' style="--a:' + (k * 270 - 135) + 'deg"><i></i></span>' +
    '<span class="kn-l"><b>' + KNOB[kind].label + '</b><span class="tiny muted" data-knobval="' + kind + '-' + t.id + '">' + (open ? 'off' : fmtHz(hz)) + '</span></span>' +
  '</div>';
}
function setKnob(t, kind, hz) {
  hz = Math.max(F_MIN, Math.min(F_MAX, Math.round(hz)));
  ctl(t)[kind] = hz;
  if (gains[t.id]) setCut(gains[t.id][kind], hz);
  var open = kind === 'hp' ? hz <= F_MIN : hz >= F_MAX, txt = open ? 'off' : fmtHz(hz);
  var kn = el('knob-' + kind + '-' + t.id), lab = document.querySelector('[data-knobval="' + kind + '-' + t.id + '"]');
  if (kn) {
    kn.style.setProperty('--a', (hzToKnob(hz) * 270 - 135) + 'deg');
    kn.setAttribute('aria-valuenow', hz);
    kn.setAttribute('aria-valuetext', txt);
    kn.parentNode.classList.toggle('act', !open);
  }
  if (lab) lab.textContent = txt;
}
var knobDrag = null;
document.addEventListener('pointerdown', function (e) {
  var kn = e.target.closest('[data-knob]');
  if (!kn || e.button !== 0) return;
  var t = findTake(kn.dataset.take);
  if (!t) return;
  e.preventDefault();
  kn.focus();
  knobDrag = { t:t, kind:kn.dataset.knob, y:e.clientY, k:hzToKnob(cutOf(t, kn.dataset.knob)) };
  document.body.classList.add('turning');
});
document.addEventListener('pointermove', function (e) {
  if (!knobDrag) return;
  var k = knobDrag.k + (knobDrag.y - e.clientY) / (e.shiftKey ? 600 : 150);
  setKnob(knobDrag.t, knobDrag.kind, knobToHz(k));
});
function endKnobDrag(){ if (knobDrag) { knobDrag = null; document.body.classList.remove('turning'); } }
document.addEventListener('pointerup', endKnobDrag);
document.addEventListener('pointercancel', endKnobDrag);
document.addEventListener('dblclick', function (e) {
  var kn = e.target.closest('[data-knob]');
  if (!kn) return;
  var t = findTake(kn.dataset.take);
  if (t) setKnob(t, kn.dataset.knob, kn.dataset.knob === 'hp' ? F_MIN : F_MAX);
});
document.addEventListener('keydown', function (e) {
  var kn = e.target.closest && e.target.closest('[data-knob]');
  if (!kn) return;
  var t = findTake(kn.dataset.take), kind = kn.dataset.knob;
  if (!t) return;
  var step = { ArrowUp:1, ArrowRight:1, ArrowDown:-1, ArrowLeft:-1, PageUp:5, PageDown:-5 }[e.key];
  var hz = null;
  if (step) hz = knobToHz(hzToKnob(cutOf(t, kind)) + step * (e.shiftKey ? .005 : .02));
  else if (e.key === 'Home') hz = F_MIN;
  else if (e.key === 'End') hz = F_MAX;
  if (hz === null) return;
  e.preventDefault();
  setKnob(t, kind, hz);
});

/* Realtime updates re-render while people type. Keep what they typed and where the cursor was. */
var KEEP = ['ver-name', 'ver-by', 'mix-by', 'seed-by', 'seed-role', 'meta-bpm', 'proj-title'];
function keepInputs(fn) {
  var vals = {}, a = document.activeElement, aid = a && a.id, sel = null;
  KEEP.forEach(function (id) { var e = el(id); if (e) vals[id] = e.value; });
  try { if (a && a.selectionStart !== undefined) sel = [a.selectionStart, a.selectionEnd]; } catch (e) {}
  fn();
  KEEP.forEach(function (id) { var e = el(id); if (e && vals[id] !== undefined) e.value = vals[id]; });
  if (aid && el(aid) && el(aid) !== document.activeElement) {
    el(aid).focus();
    try { if (sel) el(aid).setSelectionRange(sel[0], sel[1]); } catch (e) {}
  }
}
function render() {
  keepInputs(function () { renderHow(); renderSeed(); renderProjTitle(); renderOwnCta(); renderInstruments(); renderDaw(); renderBoards(); renderArchive(); renderLock(); renderVersionLists(); });
}
function renderAll() {
  render();
  if (el('stage-released').classList.contains('on')) keepInputs(renderRelease);
}
var renderQueued = false;
function renderSoon() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(function () { renderQueued = false; renderAll(); });
}

/* ---------- release ---------- */
var mixEl = null;
function renderRelease() {
  var list = tracks(), host = isHost();
  el('rel-kicker').textContent = S.session && !isOpen() ? 'Closed' : 'Still open, this is a preview';
  var tf = el('song-title');
  if (document.activeElement !== tf) tf.value = S.title;
  tf.readOnly = !host;

  el('raw-box').innerHTML =
    '<div class="rawrow">' +
      '<button class="btn btn-ember" type="button" id="play-raw">' + (running && !S.override ? 'Stop' : 'Play it raw') + '</button>' +
      '<span class="tiny muted">' + list.length + ' track(s), unmixed, straight out of the session</span></div>' +
    '<p class="tiny muted">Balance it with the faders in the mix if you want, that is what the room hears.</p>' +
    '<button class="btn btn-sm" type="button" id="dl-all2">' + I_DL + ' Download the stems</button>';

  el('mix-box').innerHTML = S.mix
    ? '<div class="rawrow"><button class="btn btn-ember btn-sm" type="button" id="play-mix">' + I_PLAY + ' Play the mix</button>' +
      '<div><b>' + esc(S.mix.by) + '</b><div class="tiny muted">' + esc(S.mix.fileName) + '</div></div></div>' +
      '<p class="tiny muted">Sits next to the raw version, it does not replace it.</p>'
    : isOpen()
      ? '<p class="tiny muted">Anyone can add a mixed version once the creator closes the session.</p>'
      : '<div class="dropzone" id="mixzone"><b>Upload a mixed version</b>' +
        '<span class="tiny muted">optional, anyone can do it</span>' +
        '<input type="file" id="mix-file" accept="audio/*" aria-label="Upload a mixed version"></div>' +
        '<label class="field"><span class="tiny muted">Who mixed it</span>' +
        '<input type="text" id="mix-by" placeholder="your name" value="' + esc(savedName()) + '"></label>';

  el('credits').innerHTML =
    (hasSeed() ? '<div class="credit">' + ico('seed', 'var(--ember)') + '<div><b>' + esc(host ? 'you' : S.seed.by) + '</b><small>original track' + (seedInstr() ? ', ' + seedInstr().label.toLowerCase() : '') + '</small></div></div>' : '') +
    partTakes().map(function (p) {
      return '<div class="credit">' + ico('part', 'var(--cyan)') +
        '<div><b>' + esc(p.by) + '</b><small>new part ' + (p.pos === 'before' ? 'before' : 'after') + ' the track</small></div></div>';
    }).join('') +
    S.members.filter(onKeptSection).map(function (m) {
      var r = role(m.roleId);
      return '<div class="credit">' + ico(r.icon, col(r)) +
        '<div><b>' + esc(m.by) + '</b><small>' + r.label.toLowerCase() + '</small></div></div>';
    }).join('') +
    (S.mix ? '<div class="credit">' + ico('prod', 'var(--cyan)') +
      '<div><b>' + esc(S.mix.by) + '</b><small>mix</small></div></div>' : '');

  renderVersionLists();
  el('rel-archive').innerHTML = S.archive.length ? S.archive.map(function (a) {
    var r = role(a.take.roleId);
    return '<div class="credit dim">' + ico(r.icon, col(r)) +
      '<div><b>' + esc(a.take.by) + '</b><small>' + r.label.toLowerCase() + ', ' + a.why + '</small></div></div>';
  }).join('') : '<p class="tiny muted">Nobody got turned away this session.</p>';

  [].forEach.call(document.querySelectorAll('[data-react]'), function (b) {
    var k = b.dataset.react;
    b.querySelector('span').textContent = S.reactions[k] || 0;
    b.disabled = !!S.reacted[k] || !S.session;
    b.classList.toggle('on', !!S.reacted[k]);
  });
}
function setPhase(p) {
  [].forEach.call(document.querySelectorAll('.phase'), function (b) {
    b.setAttribute('aria-selected', String(b.dataset.phase === p));
  });
  ['open','released'].forEach(function (k) { el('stage-' + k).classList.toggle('on', k === p); });
  if (p === 'released') renderRelease(); else render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
/* jump to the release page once, when the session gets closed */
function syncPhase() {
  var st = S.session ? S.session.status : null;
  if (st !== S.phaseSeen) {
    S.phaseSeen = st;
    if (st === 'released') setPhase('released');
  }
}

/* ---------- original track ---------- */
/* A new session never starts the moment a file is picked: the file waits on the drop panel
   ("<file> is ready") until you've filled in your name and said what the track is, then you
   start it. Replacing the track of a running session goes straight through. */
function loadSeed(file, confirmed) {
  var first = !hasSeed(), roleEl = el('seed-role');
  if (first && !confirmed) {
    S.pendingSeed = file; S.seedErr = '';
    render();
    flash('Got ' + file.name + '. Fill in your name and what the track is, then start the session.');
    var nm = el('seed-by');
    if (nm && !nm.value.trim()) nm.focus(); else if (roleEl && !roleEl.value) roleEl.focus();
    return;
  }
  var name = first ? ((el('seed-by') && el('seed-by').value) || '').trim() : (S.seed.by || savedName() || 'the creator');
  if (!name) return;
  if (!me) { flash('Still connecting, try again in a second.'); return; }
  S.pendingSeed = null;
  rememberName(name);
  var created = false;
  S.seedBusy = true; S.meta.busy = true; render();
  decode(file).then(function (buf) {
    var ready = S.session ? Promise.resolve(S.session) : db.createSession(me.id).then(function (sess) {
      created = true;
      S.session = sess;
      history.replaceState(null, '', '/s/' + sess.slug);
      watch(sess.id);
      return sess;
    });
    return ready.then(function () {
      return uploadTake(file, buf, { role:'seed', status:'seed', name:name, analyse:true });
    });
  }).then(function (res) {
    var an = res.analysis, patch = { seed_take_id: res.row.id };
    if (roleEl) patch.seed_role = roleEl.value && roleEl.value !== 'none' ? roleEl.value : null;
    if (an && (an.tempo || an.key)) {
      patch.bpm = an.tempo ? an.tempo.bpm : null;
      patch.music_key = an.key ? an.key.key : null;
      patch.key_alt = an.key ? an.key.runnerUp : null;
      patch.meta_from = 'detected';
      patch.meta_sure = sureness(Math.min(an.tempo ? an.tempo.conf : 0, an.key ? an.key.conf : 0));
    }
    return db.updateSession(S.session.id, patch).then(function () {
      stopAll();
      if (el('howbox')) el('howbox').open = false;
      flash((created ? 'Session started. Share the link from the bar below. ' : '') +
        (patch.bpm ? 'Heard about ' + patch.bpm + ' bpm in ' + patch.music_key + '. Correct it if it is off.' : 'Track loaded.'));
      return refresh();
    });
  }).catch(function (e) {
    oops(e);
  }).then(function () {
    S.seedBusy = false; S.meta.busy = false; render();
  });
}

/* start the session with the file waiting on the drop panel, once name and instrument are in */
function startSeed() {
  if (!S.pendingSeed) return;
  var nm = el('seed-by'), rl = el('seed-role');
  var miss = !(nm && nm.value.trim()) ? 'name' : !(rl && rl.value) ? 'role' : '';
  if (miss) {
    S.seedErr = miss === 'name' ? 'Add your name first, it goes in the credits.' : 'Say what the track is: pick an instrument, or "Not one instrument".';
    render();
    flash(S.seedErr);
    var f = el(miss === 'name' ? 'seed-by' : 'seed-role'); if (f) f.focus();
    return;
  }
  S.seedErr = '';
  loadSeed(S.pendingSeed, true);
}
var pendingAttach = null;
el('attach-file').addEventListener('change', function () {
  var file = this.files[0];
  this.value = '';
  if (!file || pendingAttach !== 'seed') return;
  pendingAttach = null;
  loadSeed(file);
});
/* drag a file onto the drop zone (or onto the track panel to replace it) */
function dragsFiles(e) { return e.dataTransfer && [].indexOf.call(e.dataTransfer.types || [], 'Files') > -1; }
['dragenter', 'dragover'].forEach(function (ev) {
  el('seedpanel').addEventListener(ev, function (e) {
    if (!dragsFiles(e) || !canDropSeed()) return;
    e.preventDefault();
    el('seedpanel').classList.add('over');
  });
});
['dragleave', 'drop'].forEach(function (ev) {
  el('seedpanel').addEventListener(ev, function () { el('seedpanel').classList.remove('over'); });
});
el('seedpanel').addEventListener('drop', function (e) {
  e.preventDefault();
  var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f && canDropSeed()) loadSeed(f);
});

/* ---------- the add pop-up: a layer for the project, a new part to convince the creator,
   or a take of your own that goes straight into your version ('own') ---------- */
var lastFocus = null;
var M = { mode:'layer', pos:'after', src:'file', sec:'core' };
function fillRoles(sel) {
  el('take-role').innerHTML = ROLES.map(function (r) {
    return '<option value="' + r.id + '"' + (r.id === sel ? ' selected' : '') + '>' +
      r.label + (seedHolds(r.id, M.sec) ? ' (the original track)' : '') + '</option>';
  }).join('');
  roleHint();
}
function roleHint() {
  if (M.mode === 'extend') return;
  var id = el('take-role').value, r = role(id), free = cap(id, M.sec) - inSong(id, M.sec).length;
  el('modal-ico').innerHTML = ico(r.icon, col(r));
  el('role-hint').textContent = M.mode === 'own'
    ? 'It goes straight into your version, nobody has to let it in. Add as many as you like.'
    : seedHolds(id, M.sec)
    ? 'The original track plays this part, so it cannot join the project. People can still use it in their own versions.'
    : free > 0
    ? 'There is room here. It lands in the waiting list for this instrument.'
    : 'Taken right now. Get let in and you push that layer back to the waiting list.';
}
function fillSections() {
  var list = sections(), many = list.length > 1;
  el('sec-field').hidden = !many;
  el('take-sec').innerHTML = list.map(function (s) {
    return '<option value="' + s.id + '"' + (s.id === M.sec ? ' selected' : '') + '>' +
      esc(s.id === 'core' ? 'The original track' : s.label.charAt(0).toUpperCase() + s.label.slice(1)) +
      ' (' + clockMs(s.start) + ' to ' + clockMs(s.start + s.len) + ')</option>';
  }).join('');
  secHint();
}
function secHint() {
  var s = section(M.sec) || section('core');
  el('modal-sub').textContent = M.mode === 'own'
    ? 'Only in your own version. One instrument, from the first beat of the original track, exactly ' + fmt(s.len) + ' long. You can send it to the creator later.'
    : 'One instrument. Dry, from the first beat of ' + s.label + ', exactly ' + fmt(s.len) + ' long.';
  el('file-name').textContent = el('take-file').files.length ? el('take-file').files[0].name : 'wav or mp3, dry, ' + fmt(s.len) + ' long';
  if (REC.state === 'idle') renderRec();
}
function sendLabel() { return M.mode === 'extend' ? 'Pitch it to the creator' : M.mode === 'own' ? 'Add it to my version' : 'Send it in'; }
function setSrc(src) {
  M.src = src;
  [].forEach.call(document.querySelectorAll('[data-src]'), function (b) {
    b.setAttribute('aria-selected', String(b.dataset.src === src));
  });
  el('src-file').hidden = src !== 'file';
  el('src-rec').hidden = src !== 'rec';
  el('modal-send').textContent = sendLabel();
  if (src === 'rec') renderRec(); else if (REC.state === 'recording') recCancel();
}
function countInLabel() {
  var n = S.countIn;
  el('countin-text').textContent = n
    ? 'My file starts with the ' + n + '-bar count-in from the click track. Cut it off for me.'
    : 'Set a count-in above the tracks to use this.';
  el('take-countin').disabled = !n;
  if (!n) el('take-countin').checked = false;
}
function openModal(roleId, extendPos, own, keepRec) {
  if (!hasSeed()) { flash('Drop an audio track first, it sets the length for everyone.'); return; }
  if (!own && !isOpen()) { flash('This session is closed.'); return; }
  lastFocus = document.activeElement;
  M.mode = extendPos ? 'extend' : own ? 'own' : 'layer';
  M.pos = extendPos || 'after';
  var ext = M.mode === 'extend';
  el('role-field').hidden = ext;
  if (ext) el('sec-field').hidden = true;
  el('countin-field').hidden = ext;
  if (ext) {
    el('modal-ico').innerHTML = ico('part', 'var(--cyan)');
    el('modal-head').textContent = 'Convince the creator';
    el('modal-sub').textContent = 'Write a new part that plays ' + (M.pos === 'before' ? 'before' : 'after') +
      ' the song. Any length. The creator hears it in place and decides whether the song gets longer.';
    el('note-label').textContent = 'Why the song needs this';
    el('take-note').placeholder = 'e.g. it needs a quiet intro before the riff kicks in';
  } else {
    el('modal-head').textContent = own ? 'Add your own layer' : 'Add a layer';
    M.sec = 'core';
    fillRoles(roleId || ROLES[0].id);
    fillSections();
    if (own) el('sec-field').hidden = true;
    el('note-label').textContent = own ? 'A note, for if you send it to the creator later' : 'One line to the room';
    el('take-note').placeholder = 'what you were going for';
    countInLabel();
  }
  el('modal-err').classList.remove('on');
  el('take-file').value = ''; el('take-name').value = savedName(); el('take-note').value = '';
  el('take-countin').checked = false;
  el('file-name').textContent = ext ? 'wav or mp3, any length' : 'wav or mp3, dry, starting at bar 1';
  el('modal-send').disabled = false;
  if (keepRec && REC.buf) { REC.where = 'modal'; setSrc('rec'); }
  else { recReset(); REC.where = null; REC.fromDaw = false; REC.hear = {}; REC.click = true; setSrc('file'); }
  if (!ext) secHint();
  el('scrim').classList.add('on');
  el('take-name').focus();
}
function closeModal() {
  if (REC.state === 'recording' || REC.state === 'asking') recCancel();
  recStopPlayers();
  el('scrim').classList.remove('on');
  /* a take recorded on the grey track goes back there if it wasn't sent */
  if (REC.fromDaw) { if (REC.buf) REC.where = 'daw'; else REC.fromDaw = false; renderDaw(); }
  if (lastFocus) lastFocus.focus();
}

el('take-role').addEventListener('change', roleHint);
el('take-sec').addEventListener('change', function () { M.sec = this.value; fillRoles(el('take-role').value); secHint(); });
el('take-file').addEventListener('change', function () {
  el('file-name').textContent = this.files.length ? this.files[0].name
    : (M.mode === 'extend' ? 'wav or mp3, any length' : 'wav or mp3, dry, starting at bar 1');
});
el('modal-cancel').addEventListener('click', closeModal);
el('scrim').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && el('scrim').classList.contains('on')) closeModal(); });
/* Enter in the name field starts the session with a file that is already chosen */
document.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && e.target.id === 'seed-by' && S.pendingSeed) { e.preventDefault(); startSeed(); }
});

function takeSource(fail) {
  if (M.src === 'rec') {
    if (!REC.buf) { fail(REC.state === 'recording' ? 'Finish recording first.' : 'Record a take first.'); return null; }
    return Promise.resolve({ file:REC.file, buf:REC.buf, rec:true });
  }
  var f = el('take-file').files[0];
  if (!f) { fail('Pick an audio file first.'); return null; }
  return decode(f).then(function (buf) {
    if (M.mode === 'layer' && el('take-countin').checked && S.countIn) {
      var trimmed = trimStart(buf, S.countIn * barSeconds());
      var base = f.name.replace(/\.[^.]+$/, '');
      return { file:new File([encodeWav(trimmed)], base + ' (count-in cut).wav', { type:'audio/wav' }), buf:trimmed };
    }
    return { file:f, buf:buf };
  });
}
el('modal-send').addEventListener('click', function () {
  var name = el('take-name').value.trim(), btn = this;
  function fail(m){ el('modal-err').textContent = m; el('modal-err').classList.add('on'); btn.disabled = false; btn.textContent = sendLabel(); }
  function upFail(e){
    console.error(e);
    var nu = M.mode === 'own' ? needsUpdate(e, '20261004120000_own_takes.sql') : null;
    fail((nu || e).message || 'The upload failed. Try again.');
  }
  if (!name) return fail('Add your name for the credits.');
  var p = takeSource(fail);
  if (!p) return;
  btn.disabled = true; btn.textContent = 'Uploading...';
  p.then(function (src) {
    var len = src.buf.duration, note = el('take-note').value.trim();
    if (M.mode === 'extend') {
      if (len < 1) return fail('That is under a second. A new part needs a bit more.');
      if (len > 240) return fail('Keep a new part under four minutes.');
      rememberName(name);
      var pos = M.pos;
      return uploadTake(src.file, src.buf, { role:'part', status:'waiting', name:name, note:note, pos:pos, analyse:true })
        .then(function () {
          closeModal();
          flash('Pitched a new part ' + (pos === 'before' ? 'before' : 'after') + ' the track. The creator decides.');
          return refresh();
        }, upFail);
    }
    var want = secLen(M.sec), own = M.mode === 'own';
    if (want && Math.abs(len - want) > TOL)
      return fail('Your file is ' + fmt(len) + ', ' + (M.sec === 'core' ? 'the track' : 'that part') + ' is ' + fmt(want) + '.' +
        (S.countIn && !el('take-countin').checked && Math.abs(len - want - S.countIn * barSeconds()) < TOL
          ? ' It looks like it still has the count-in: tick the box above.' : ' Trim or pad it to match.'));
    rememberName(name);
    return uploadTake(src.file, src.buf, { role:el('take-role').value, status:own ? 'own' : 'waiting', name:name, note:note,
                                           sec:M.sec === 'core' ? null : M.sec, analyse:true })
      .then(function (res) {
        if (REC.fromDaw) { recReset(); REC.fromDaw = false; REC.where = null; }
        closeModal();
        if (own) {
          S.build.picks.push(res.row.id);
          S.override = null; S.view = 'build';
          refreshGains();
          flash('It is in your version. Save the version to keep it, or send the take to the creator from the list.');
        } else flash('It is waiting now. The creator lets it in or vetoes it.');
        return refresh();
      }, upFail);
  }).catch(function () { fail('That file could not be read.'); });
});

/* the original track takes a slot in its instrument; the database bumps the oldest layers if that overfills it */
function setSeedRole(id) {
  var here = id ? inSong(id, 'core') : [];
  var out = here.slice(0, Math.max(0, here.length - (id ? role(id).slots - 1 : 0)));
  S.meta.seedRole = id;
  render();
  patchSession({ seed_role:id }).then(function () {
    if (out.length && S.session.seed_role === id) flash(out.map(function (t) { return t.by; }).join(' and ') + (out.length > 1 ? ' are' : ' is') + ' back in the waiting list, the original track plays ' + role(id).label.toLowerCase() + '.');
    return refresh();
  });
}

/* ---------- events ---------- */
var titleTimer = 0, bpmTimer = 0;
function patchSession(patch) {
  if (!S.session || !isHost()) return Promise.resolve();
  return db.updateSession(S.session.id, patch).then(function (row) { S.session = row; }).catch(oops);
}

document.addEventListener('click', function (e) {
  var dl2 = e.target.closest('[data-del]');
  if (dl2) {
    e.stopPropagation();
    var did = dl2.dataset.del;
    clearTimeout(ARMED.timer);
    if (armedFor(did)) { ARMED.id = null; deleteTake(did); return; }
    ARMED.id = did; ARMED.until = Date.now() + 5000;
    ARMED.timer = setTimeout(function () { ARMED.id = null; render(); }, 5000);
    render();
    flash('Click "Delete?" again to delete this take for good.');
    return;
  }
  var ex = e.target.closest('[data-extend]');
  if (ex) { e.stopPropagation(); openModal(null, ex.dataset.extend); return; }
  var sr = e.target.closest('[data-src]');
  if (sr) {
    /* a layer on the original track is recorded on the grey track in the DAW, like a real DAW */
    if (sr.dataset.src === 'rec' && (M.mode === 'layer' || M.mode === 'own') && M.sec === 'core') { recordInDaw(); return; }
    setSrc(sr.dataset.src); return;
  }
  if (e.target.closest('[data-dawrec]')) { dawRecStart(); return; }
  if (e.target.closest('[data-dawsend]')) { dawRecSend(); return; }
  if (e.target.closest('[data-dawdrop]')) { dawRecDiscard(); return; }
  var rc = e.target.closest('[data-rec]');
  if (rc) {
    var what = rc.dataset.rec;
    if (what === 'start') recStart();
    else if (what === 'finish') recFinish();
    else if (what === 'cancel') recCancel();
    else if (what === 'again') { recReset(); renderRec(); }
    else if (what === 'listen') recListen(false);
    else if (what === 'listenmix') recListen(true);
    return;
  }
  if (e.target.closest('#dl-click')) { downloadClick(); return; }
  if (e.target.closest('[data-mixtgl]')) { toggleTransport(); return; }
  var tp = e.target.closest('[data-trypitch]');
  if (tp) {
    var pid2 = tp.dataset.trypitch;
    stopAll();
    S.trialPitch = S.trialPitch === pid2 ? null : pid2;
    S.override = null; S.view = 'lineup';
    render();
    if (S.trialPitch) {
      var pt = findTake(pid2);
      play(Math.max(0, startOf(pt) - (pt.pos === 'after' ? 4 : 0)));
      flash('Playing the new part where it would sit in the song.');
    }
    return;
  }
  if (e.target.closest('[data-untrialpitch]')) { stopAll(); S.trialPitch = null; render(); return; }
  var acp = e.target.closest('[data-accpitch]');
  if (acp) { keepPart(findTake(acp.dataset.accpitch)); return; }
  var psp = e.target.closest('[data-passpitch]');
  if (psp) { passPart(findTake(psp.dataset.passpitch)); return; }
  var to = e.target.closest('[data-takeout]');
  if (to) {
    var tt = findTake(to.dataset.takeout);
    if (!tt || !isHost()) return;
    stopAll();
    db.takeOutLayer(tt.dbId).then(function () {
      flash('Took ' + (tt.by || 'the') + '’s ' + role(tt.roleId).label.toLowerCase() + ' out of the project. It is in the archive, and people can still use it in their versions.');
      return refresh();
    }).catch(function (err) { oops(needsUpdate(err, '20261004130000_take_out_layer.sql') || err); });
    return;
  }
  var dp = e.target.closest('[data-droppart]');
  if (dp) { dropPart(findTake(dp.dataset.droppart)); return; }
  if (e.target.closest('[data-seedgo]')) { startSeed(); return; }
  var at = e.target.closest('[data-attach]');
  if (at) { pendingAttach = at.dataset.attach; el('attach-file').click(); return; }
  var d = e.target.closest('[data-dl]');
  if (d) { download(findTake(d.dataset.dl)); return; }
  var pv = e.target.closest('[data-prev]');
  if (pv) { preview(findTake(pv.dataset.prev)); return; }
  var vw = e.target.closest('[data-view]');
  if (vw) {
    if (REC.state === 'recording' || REC.state === 'asking') recCancel();
    stopAll();
    S.override = null; S.view = vw.dataset.view;
    if (S.view === 'build') S.trial = null;
    refreshGains(); render();
    flash(S.view === 'build' ? 'Pick takes from every instrument, then save your version.' : 'Back to the main project.');
    return;
  }
  var pk = e.target.closest('[data-pick]');
  if (pk) {
    var pid = pk.dataset.pick, at2 = S.build.picks.indexOf(pid);
    if (at2 > -1) S.build.picks.splice(at2, 1); else S.build.picks.push(pid);
    stopAll(); refreshGains(); render();
    return;
  }
  if (e.target.closest('#ver-save')) {
    if (!S.build.picks.length || !S.session || !me) return;
    var who = (el('ver-by').value || '').trim() || 'someone';
    var nm = (el('ver-name').value || '').trim() || ('Version by ' + who);
    rememberName(who);
    db.saveVersion({ session_id:S.session.id, author_id:me.id, name:nm.slice(0, 60), by_name:who.slice(0, 60),
                     picks:S.build.picks.slice(), ctl:JSON.parse(JSON.stringify(S.build.ctl)) })
      .then(function () {
        el('ver-name').value = '';
        flash('Saved "' + nm + '". It is in the versions list below the waiting takes.');
        return refresh();
      }).catch(oops);
    return;
  }
  var pvr = e.target.closest('[data-playver]');
  if (pvr) {
    var ver = S.versions.filter(function (v) { return v.id === pvr.dataset.playver; })[0];
    if (ver) playVersion(ver);
    if (el('stage-released').classList.contains('on')) renderRelease();
    return;
  }
  if (e.target.closest('[data-playofficial]')) {
    var wasOfficial = !S.override && S.view !== 'build' && running;
    stopAll(); S.override = null; S.view = 'lineup'; refreshGains();
    if (!wasOfficial) play(0); else render();
    return;
  }
  var lk = e.target.closest('[data-like]');
  if (lk) {
    var lv = S.versions.filter(function (v) { return v.id === lk.dataset.like; })[0];
    if (lv && !lv.liked && me) {
      lv.liked = true; lv.likes++; renderVersionLists();
      db.likeVersion({ versionId:lv.id, sessionId:S.session.id, userId:me.id }).then(refresh).catch(oops);
    }
    return;
  }
  var fk = e.target.closest('[data-fork]');
  if (fk) {
    var src = S.versions.filter(function (v) { return v.id === fk.dataset.fork; })[0];
    if (src) {
      stopAll();
      S.build = { picks:livePicks(src.picks), ctl:JSON.parse(JSON.stringify(src.ctl || {})) };
      S.override = null; S.view = 'build';
      if (el('stage-released').classList.contains('on')) setPhase('open');
      refreshGains(); render();
      el('daw').scrollIntoView({ behavior:'smooth', block:'start' });
      flash('Loaded "' + src.name + '" into the builder. Change it and save it as your own.');
    }
    return;
  }
  var tr = e.target.closest('[data-try]');
  if (tr) {
    var tid = tr.dataset.try;
    S.trial = (S.trial === tid) ? null : tid;
    S.override = null; S.view = 'lineup';
    stopAll(); render();
    if (S.trial) { play(0); flash('Playing the project with this take on top.'); }
    else flash('Back to the main project as it stands.');
    return;
  }
  if (e.target.closest('[data-untrial]')) { S.trial = null; stopAll(); render(); return; }
  var vt = e.target.closest('[data-vote]');
  if (vt) {
    var vtake = findTake(vt.dataset.take);
    if (!vtake || !canVote(vtake)) return;
    db.castVote({ takeId:vtake.dbId, sessionId:S.session.id, voterId:me.id, value:vt.dataset.vote })
      .then(function () { flash('Vote counted. The creator still makes the call.'); return refresh(); })
      .catch(oops);
    return;
  }
  var mu = e.target.closest('[data-mute]');
  if (mu) { var mc = ctl(findTake(mu.dataset.mute)); mc.mute = !mc.mute; refreshGains(); render(); return; }
  var so = e.target.closest('[data-solo]');
  if (so) { var xc = ctl(findTake(so.dataset.solo)); xc.solo = !xc.solo; refreshGains(); render(); return; }
  if (e.target.closest('#transport')) { toggleTransport(); return; }
  if (e.target.closest('#rewind')) { stopAll(); offset = 0; render(); return; }
  if (e.target.closest('#play-raw')) {
    if (S.override || S.view === 'build') { stopAll(); S.override = null; S.view = 'lineup'; refreshGains(); play(0); }
    else toggleTransport();
    renderRelease(); return;
  }
  if (e.target.closest('#play-mix')) {
    if (!mixEl || mixEl.dataset.take !== S.mix.id) { mixEl = new Audio(S.mix.url); mixEl.dataset.take = S.mix.id; }
    if (mixEl.paused) { stopAll(); mixEl.currentTime = 0; mixEl.play(); } else mixEl.pause();
    return;
  }
  if (e.target.closest('#dl-all') || e.target.closest('#dl-all2')) { downloadAll(); return; }
  var lane = e.target.closest('.t-lane');
  if (lane && (justDragged || e.target.closest('.fh'))) return;
  if (lane) {
    var rect = lane.getBoundingClientRect();
    play(Math.max(0, (e.clientX - rect.left) / rect.width) * duration());
    return;
  }
  var y = e.target.closest('[data-yes]'), n = e.target.closest('[data-no]');
  if (y) { letIn(S.applicants.filter(function (t2) { return t2.id === y.dataset.yes; })[0]); return; }
  if (n) { veto(S.applicants.filter(function (t2) { return t2.id === n.dataset.no; })[0]); return; }
  var ap = e.target.closest('[data-apply]');
  if (ap) { openModal(ap.dataset.apply); return; }
  var ow = e.target.closest('[data-own]');
  if (ow) {
    if (S.view !== 'build' || S.override) { stopAll(); S.override = null; S.trial = null; S.view = 'build'; refreshGains(); render(); }
    openModal(ow.dataset.own, null, true);
    return;
  }
  if (e.target.closest('[data-ownstart]')) {
    if (S.view !== 'build' || S.override) {
      stopAll(); S.override = null; S.trial = null; S.view = 'build'; refreshGains(); render();
      flash('Your version. Pick takes from every instrument, record your own, then save it.');
    }
    el('daw').scrollIntoView({ behavior:'smooth', block:'start' });
    return;
  }
  var so2 = e.target.closest('[data-sendown]');
  if (so2) {
    var ot = findTake(so2.dataset.sendown);
    if (!ot || !isOwn(ot) || !mine(ot)) return;
    so2.disabled = true; so2.textContent = 'Sending...';
    db.sendOwnTake(ot.dbId).then(function () {
      flash('Sent. Your ' + role(ot.roleId).label.toLowerCase() + ' take is waiting for the creator, and stays in your version.');
      return refresh();
    }).catch(function (err) { so2.disabled = false; so2.textContent = 'Send to the creator'; oops(needsUpdate(err, '20261004120000_own_takes.sql') || err); });
    return;
  }
  var react = e.target.closest('[data-react]');
  if (react && S.session && me && !S.reacted[react.dataset.react]) {
    var kind = react.dataset.react;
    S.reacted[kind] = true; S.reactions[kind] = (S.reactions[kind] || 0) + 1; renderRelease();
    db.react({ sessionId:S.session.id, userId:me.id, kind:kind }).then(refresh).catch(oops);
    return;
  }
  if (e.target.closest('#copy-link')) {
    if (!S.session) { flash('Drop a track first, then you get a link to share.'); return; }
    var link = location.origin + '/s/' + S.session.slug;
    (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject())
      .then(function () { flash('Link copied. Anyone with it can add layers.'); },
            function () { flash('Share this link: ' + link); });
  }
});

document.addEventListener('input', function (e) {
  if (e.target.dataset.xfade) {
    var xt = findTake(e.target.dataset.xfade);
    if (xt) { xt.xfade = +e.target.value; var em = e.target.parentNode.querySelector('em'); if (em) em.textContent = xf(xt).toFixed(1) + ' s'; }
    return;
  }
  if (e.target.dataset.vol) {
    var t = findTake(e.target.dataset.vol);
    if (t) { ctl(t).vol = +e.target.value; refreshGains(); }
  }
  if (e.target.id === 'meta-bpm' && isHost()) {
    S.meta.bpm = +e.target.value || null; S.meta.from = 'you';
    clearTimeout(bpmTimer);
    bpmTimer = setTimeout(function () { patchSession({ bpm:S.meta.bpm, meta_from:'you' }); }, 600);
  }
  if ((e.target.id === 'song-title' || e.target.id === 'proj-title') && isHost()) {
    S.title = e.target.value.trim() || 'Untitled';
    el('session-name').textContent = projName();
    clearTimeout(titleTimer);
    titleTimer = setTimeout(function () { patchSession({ title:(S.title || 'Untitled').slice(0, 120) }); }, 600);
  }
});
document.addEventListener('change', function (e) {
  if (e.target.dataset.xfade) {
    var xt = findTake(e.target.dataset.xfade), wasRunning = running, pos = position();
    renderDaw();
    if (wasRunning) play(Math.min(pos, duration() - 0.1));
    saveFades(xt);
    return;
  }
  if (e.target.dataset.countin) {
    S.countIn = +e.target.value;
    [].forEach.call(document.querySelectorAll('select[data-countin]'), function (s) { s.value = String(S.countIn); });
    if (el('countin-text')) countInLabel();
    return;
  }
  if (e.target.id === 'daw-rec-role') { S.recRole = e.target.value; return; }
  if (e.target.dataset.hear) {
    if (e.target.dataset.hear === 'click') REC.click = e.target.checked;
    else REC.hear[e.target.dataset.hear] = e.target.checked;
    return;
  }
  if (e.target.id === 'meta-key' && isHost())  { S.meta.key = e.target.value; S.meta.from = 'you'; patchSession({ music_key:S.meta.key, meta_from:'you' }); renderSeed(); }
  if (e.target.id === 'meta-seedrole' && isHost()) setSeedRole(e.target.value || null);
  if (e.target.id === 'meta-time' && isHost()) { S.meta.time = e.target.value; patchSession({ time_sig:S.meta.time }); renderSeed(); renderDaw(); }
  if (e.target.id === 'mix-file' && e.target.files[0]) {
    var f = e.target.files[0], by = ((el('mix-by') && el('mix-by').value) || '').trim();
    if (!by) { e.target.value = ''; flash('Add who mixed it first.'); el('mix-by').focus(); return; }
    rememberName(by);
    flash('Uploading the mix...');
    decode(f).then(function (buf) {
      return uploadTake(f, buf, { role:'mix', status:'mix', name:by, analyse:false });
    }).then(function () {
      mixEl = null;
      flash('Mixed version added next to the raw one.');
      return refresh();
    }).catch(oops);
  }
});
window.addEventListener('resize', function () { tracks().forEach(drawWave); placeFadeHandles(); });

[].forEach.call(document.querySelectorAll('.phase'), function (b) {
  b.addEventListener('click', function () { setPhase(b.dataset.phase); });
});
el('lock-btn').addEventListener('click', function () {
  if (!isHost()) return;
  stopAll();
  patchSession({ status:'released', released_at:new Date().toISOString() }).then(function () {
    flash('Session closed. It is released as it stands, and anyone can still build versions.');
    return refresh();
  });
});
el('proto-toggle').addEventListener('click', function () {
  var open = el('protobar').classList.toggle('open');
  this.setAttribute('aria-expanded', String(open));
});

el('strip-1').innerHTML = statics(80);
el('strip-2').innerHTML = statics(80);
render();

/* ---------- boot ---------- */
function boot() {
  if (!configured) {
    flash('Supabase is not configured. Copy .env.example to .env.local and fill it in.');
    return;
  }
  flash('Connecting...');
  db.ensureUser().then(function (user) {
    me = user;
    var m = location.pathname.match(/^\/s\/([\w-]+)/);
    if (!m) { flash('Drop an audio track to start a session. You will get a link to share.'); render(); return; }
    return db.loadSessionBySlug(m[1]).then(function (sess) {
      if (!sess) { flash('That session does not exist. Drop a track to start a new one.'); history.replaceState(null, '', '/'); render(); return; }
      S.session = sess;
      watch(sess.id);
      return refresh().then(function () {
        flash(isHost() ? 'You started this session. Copy the invite link to bring people in.' : 'You are in the mix. Add a layer on any instrument, or pitch a new part.');
      });
    });
  }).catch(oops);
}
boot();

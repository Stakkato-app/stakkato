/* Riffraff, the floor.
   The UI, audio engine and rendering are carried over from the original artifact.
   What changed: state comes from Supabase (see data.js) instead of living only in memory,
   every visitor has an identity, the seed's owner is the host, and the line-up votes for real.

   Shape of the code:
   - S holds UI state plus the latest snapshot of the session.
   - TAKES caches take objects by database id, so decoded audio and mixer settings survive refreshes.
   - refresh() refetches the snapshot; realtime events call it (debounced).
   - render() redraws from S. Nothing renders from the database directly. */

import './styles.css';
import { configured } from './supabase.js';
import * as db from './data.js';
import { analyse, sureness, PCS } from './analysis.js';
import { ico } from './icons.js';
import { zip } from './zip.js';
import { ROLES, role, col, cvar } from './roles.js';

var TOL = 0.6;           // seconds a take may differ from the seed length
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
  return { id:'seed', dbId:null, by:'', roleId:'seed', note:'', len:0, vol:1, mute:false, solo:false, votes:{} };
}
function blank() {
  return { session:null, seed:placeholderSeed(), members:[], applicants:[], archive:[], trial:null, title:'Untitled', mix:null,
           view:'lineup', build:{ picks:[], ctl:{} }, versions:[], override:null, myVotes:{},
           reactions:{ banger:0, mess:0, again:0 }, reacted:{}, seedBusy:false, phaseSeen:null,
           meta:{ bpm:null, key:null, alt:null, time:'4/4', from:'none', sure:null, seedRole:null, busy:false } };
}
var S = blank();

function isHost() { return !!(S.session && me && S.session.host_id === me.id); }
function isOpen() { return !S.session || S.session.status === 'open'; }
/* the instrument the host says the seed is, or null when not set */
function seedInstr() { return S.meta.seedRole ? role(S.meta.seedRole) || null : null; }
function labelOf(t) {
  var ri = t.id === 'seed' ? seedInstr() : null;
  return ri ? 'Seed, ' + ri.label.toLowerCase() : role(t.roleId).label;
}
function seedRoleOptions(sel, none) {
  return '<option value=""' + (sel ? '' : ' selected') + '>' + none + '</option>' +
    ROLES.map(function (r) { return '<option value="' + r.id + '"' + (r.id === sel ? ' selected' : '') + '>' + r.label + '</option>'; }).join('');
}
function hasSeed() { return !!S.seed.dbId; }

function inSong(id){ return S.members.filter(function (m) { return m.roleId === id; }); }
/* slots left for takes in a role; the seed's instrument takes one (mirrors public.role_cap()) */
function cap(id) { return role(id).slots - (S.meta.seedRole === id ? 1 : 0); }
function seedHolds(id) { return cap(id) < 1; }
function waitingFor(id){ return S.applicants.filter(function (a) { return a.roleId === id; }); }
function findTake(id) {
  if (id === 'seed') return S.seed;
  return TAKES[id];
}
function trialTake() {
  return S.trial ? S.applicants.filter(function (t) { return t.id === S.trial; })[0] : null;
}
function pool() {
  return S.members.concat(S.applicants, S.archive.map(function (a) { return a.take; }))
    .filter(function (t) { return t && t.buf; });
}
function byIds(ids) {
  return ids.map(function (id) { return findTake(id); }).filter(function (t) { return t && t.buf; });
}
function tracks() {
  if (S.override) return [S.seed].concat(byIds(S.override.picks)).filter(function (t) { return t && t.buf; });
  if (S.view === 'build') return [S.seed].concat(byIds(S.build.picks)).filter(function (t) { return t && t.buf; });
  var tr = trialTake();
  return [S.seed].concat(S.members, tr ? [tr] : []).filter(function (t) { return t && t.buf; });
}
/* per-context mixer settings: the line-up uses the take itself, a version keeps its own */
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

  var list = snap.takes.map(function (r) { return TAKES[r.id]; });
  S.members = list.filter(function (t) { return t.status === 'in'; })
    .sort(function (a, b) { return String(a.joinedAt).localeCompare(String(b.joinedAt)); });
  S.applicants = list.filter(function (t) { return t.status === 'waiting'; });
  S.archive = list.filter(function (t) { return t.status === 'archived'; }).map(function (t) {
    return { take:t, why: t.why === 'vetoed' ? (isHost() ? 'vetoed by you' : 'vetoed by the host') : (t.why || 'archived') };
  });
  var mixes = list.filter(function (t) { return t.status === 'mix'; });
  S.mix = mixes.length ? mixes[mixes.length - 1] : null;
  if (S.trial && !S.applicants.some(function (t) { return t.id === S.trial; })) S.trial = null;

  /* votes are cast by people; show them against each voter's take in the line-up */
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
    if (t.status === 'mix' || t.buf || t.loading || t.failed || !t.url) return;
    if (t.roleId === 'seed' && t !== S.seed) return;   // an old, replaced seed
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

/* ---------- line-up votes ---------- */
function atStake(t) {
  var here = inSong(t.roleId);
  return here.length && here.length >= cap(t.roleId) ? here[0] : null;
}
function tallyOf(t) {
  var stake = atStake(t), up = 0, down = 0, voters = 0, seen = {};
  S.members.forEach(function (m) {
    if (stake && m.id === stake.id) return;
    if (seen[m.authorId]) return;   // one person, one vote, even with two takes in
    seen[m.authorId] = true; voters++;
    if (t.votes[m.id] === 'up') up++;
    if (t.votes[m.id] === 'down') down++;
  });
  return { up:up, down:down, voters:voters };
}
/* mirrors public.can_vote() in the database */
function canVote(t) {
  if (!me || !isOpen() || t.status !== 'waiting' || seedHolds(t.roleId)) return false;
  var stake = atStake(t);
  return S.members.some(function (m) { return m.authorId === me.id && !(stake && stake.id === m.id); });
}
function voteBlock(t) {
  if (seedHolds(t.roleId)) return '<div class="lvotes"><span class="tiny muted">The seed plays this part, so this take can only go in versions.</span></div>';
  if (!S.members.length) return '<div class="lvotes"><span class="tiny muted">No line-up yet to weigh in.</span></div>';
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
  return '<div class="lvotes"><div class="lv-sum"><b>Line-up</b> ' + tl.up + ' for, ' + tl.down + ' against' +
    (tl.voters - tl.up - tl.down > 0 ? ', ' + (tl.voters - tl.up - tl.down) + ' quiet' : '') + '</div>' +
    '<div class="lv-chips">' + chips + '</div>' + myButtons + '</div>';
}
function target(){ return hasSeed() ? S.seed.len : 0; }
function duration(){ return tracks().reduce(function (a, t) { return Math.max(a, t.len); }, 0); }

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
function gainFor(t) {
  if (!gains[t.id]) {
    var g = ac().createGain();
    g.connect(master);
    gains[t.id] = g;
  }
  gains[t.id].gain.value = audible(t) ? volOf(t) : 0;
  return gains[t.id];
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
  var list = tracks();
  if (!list.length) return;
  stopAll(true);
  only = soloId || null;
  var at = Math.max(0, Math.min(from === undefined ? offset : from, duration() - .05));
  ac().resume();
  startedAt = ac().currentTime - at;
  list.forEach(function (t) {
    if (!audible(t)) return;
    var s = ac().createBufferSource();
    s.buffer = t.buf;
    s.connect(gainFor(t));
    s.start(0, at);
    sources[t.id] = s;
  });
  offset = at; running = true;
  startLoop();
  render();
}
function toggleTransport(){ running ? stopAll(true) : play(); }
function preview(t) {
  if (!t || !t.buf) { if (t && t.loading) flash('Still loading that take.'); return; }
  if (only === t.id) { stopAll(); return; }
  stopAll();
  only = t.id;
  var s = ac().createBufferSource();
  s.buffer = t.buf;
  s.connect(gainFor(t));
  ac().resume();
  s.start();
  sources[t.id] = s;
  s.onended = function () { delete sources[t.id]; if (only === t.id) { only = null; render(); } };
  startLoop();
  render();
}
var vizBars = null;
function bindViz(){ vizBars = document.querySelectorAll('#seed-viz i'); }
function drawViz(active) {
  if (!vizBars || !vizBars.length || !document.contains(vizBars[0])) bindViz();
  if (!vizBars || !vizBars.length) return;
  var n = vizBars.length;
  if (!active || !analyser) {
    for (var i = 0; i < n; i++) vizBars[i].style.height = '14%';
    return;
  }
  analyser.getByteFrequencyData(freq);
  var bins = Math.min(freq.length, 96);
  for (var b = 0; b < n; b++) {
    var from = Math.floor(Math.pow(b / n, 1.7) * bins), to = Math.max(from + 1, Math.floor(Math.pow((b + 1) / n, 1.7) * bins));
    var m = 0;
    for (var k = from; k < to; k++) if (freq[k] > m) m = freq[k];
    vizBars[b].style.height = Math.max(6, Math.min(100, (m / 255) * 115)) + '%';
  }
}
function frame() {
  var busy = running || Object.keys(sources).length > 0;
  var p = position(), d = duration();
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
      an_bpm: an && an.tempo ? an.tempo.bpm : null, an_key: an && an.key ? an.key.key : null
    }).then(function (row) {
      var t = TAKES[row.id] = { id:row.id, dbId:row.id, vol:1, mute:false, solo:false, votes:{} };
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
    '\r\nLength: ' + fmt(target()) + '\r\n\r\nEvery file starts at bar 1. Drop them all at the very start of your project.\r\n\r\n' +
    list.map(function (t, i) { return fileName(t, i) + '   (' + labelOf(t) + ', ' + (t.by || 'you') + ')'; }).join('\r\n') + '\r\n';
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
    var title = (S.override ? S.override.name : (S.view === 'build' ? 'my version' : 'line-up'));
    hand('Riffraff - ' + clean(title) + ' stems.zip', zip(files));
  }).catch(oops);
}

/* ---------- floor logic (host only, enforced by the database) ---------- */
function letIn(t) {
  if (!t || !isHost()) return;
  var r = role(t.roleId), here = inSong(t.roleId);
  if (seedHolds(t.roleId)) { flash('The seed plays ' + r.label.toLowerCase() + ', so there is no spot to let a take into.'); return; }
  var msg = here.length >= cap(t.roleId)
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

/* ---------- seed + session sheet ---------- */
var KEYS = (function () { var o = []; PCS.forEach(function (p) { o.push(p + ' maj'); o.push(p + ' min'); }); return o; })();
var TIMES = ['4/4','3/4','6/8','5/4','7/8','12/8','odd'];
var I_DL = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M8 1v9M4.5 6.5 8 10l3.5-3.5M2 13h12"/></svg>';
var I_PLAY  = '<svg width="12" height="12" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true"><path d="M2 1l6 4-6 4z"/></svg>';
var I_PAUSE = '<svg width="12" height="12" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true"><path d="M2 1h2.6v8H2zM5.4 1H8v8H5.4z"/></svg>';

function renderSeed() {
  var s = S.seed, host = isHost(), loading = loadingCount(), ri = seedInstr();
  el('session-name').textContent = S.session ? S.title : 'New session';
  el('session-sub').textContent = (hasSeed() ? 'seed loaded, ' + fmt(s.len) : 'no seed yet') +
    (loading ? ', loading ' + loading + ' take(s)' : '') + (S.session && !isOpen() ? ', closed' : '');

  if (hasSeed()) {
    el('seedpanel').innerHTML =
      '<button class="play' + (only === 'seed' ? ' on' : '') + '" type="button" data-prev="seed" aria-label="Play the seed"' + (s.buf ? '' : ' disabled') + '>' +
        (only === 'seed' ? I_PAUSE : I_PLAY) + '</button>' +
      '<div><div class="kicker">The seed' + (ri ? ', ' + ri.label.toLowerCase() : '') + '</div>' +
      '<div class="who">' + (host ? 'Your track' : esc(s.by) + '\u2019s track') + ', ' + fmt(s.len) + (s.buf ? '' : ' <span class="tiny muted">loading</span>') + '</div>' +
      '<div class="viz live" id="seed-viz" aria-hidden="true">' + vizMarkup(44) + '</div></div>' +
      '<div class="seed-side"><div class="facts" id="facts"></div>' +
      (host && isOpen() ? '<button class="btn btn-sm" type="button" data-attach="seed"' + (S.seedBusy ? ' disabled' : '') + '>' +
        (S.seedBusy ? 'Uploading...' : 'Replace the seed') + '</button>' : '') + '</div>';
  } else if (!S.session || host) {
    el('seedpanel').innerHTML = '<div class="seed-empty"><div><div class="kicker">Step one</div>' +
      '<div class="who">Drop the seed</div>' +
      '<p class="tiny muted">A riff, a groove or a vocal. Whatever you load sets the length every other take has to match. ' +
      'You host the session and get a link to share.</p>' +
      '<label class="field seed-name"><span>Your name</span><input type="text" id="seed-by" maxlength="60" placeholder="how you show up in the credits" value="' + esc(savedName()) + '"></label>' +
      '<label class="field seed-name"><span>What is it</span><select id="seed-role">' + seedRoleOptions(S.meta.seedRole, 'Not one instrument') + '</select></label></div>' +
      '<button class="btn btn-ember" type="button" data-attach="seed"' + (S.seedBusy ? ' disabled' : '') + '>' +
        (S.seedBusy ? 'Uploading...' : 'Load your seed') + '</button></div>';
  } else {
    el('seedpanel').innerHTML = '<div class="seed-empty"><div><div class="kicker">Step one</div>' +
      '<div class="who">Waiting for the seed</div>' +
      '<p class="tiny muted">The host has not loaded a seed yet. This page updates by itself when they do.</p></div></div>';
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
  if (!hasSeed()) note = 'Load a seed and the tempo and key get read from the audio.';
  else if (S.meta.busy) note = 'Listening to your file, one moment.';
  else if (S.meta.from === 'detected') note = 'Read from the audio, ' + (S.meta.sure || 'not certain') + '.' +
    (S.meta.alt ? ' Could also be ' + S.meta.alt + '.' : '') + (host ? ' Time signature is your call.' : '');
  else note = host ? 'Set by you.' : 'Set by the host.';

  el('metabar').innerHTML = hasSeed() && host
    ? '<label class="mini"><span>bpm</span><input type="number" id="meta-bpm" min="40" max="240" value="' + (S.meta.bpm || '') + '"></label>' +
      '<label class="mini"><span>key</span><select id="meta-key">' +
        KEYS.map(function (k) { return '<option' + (k === S.meta.key ? ' selected' : '') + '>' + k + '</option>'; }).join('') +
      '</select></label>' +
      '<label class="mini"><span>time</span><select id="meta-time">' +
        TIMES.map(function (t) { return '<option' + (t === S.meta.time ? ' selected' : '') + '>' + t + '</option>'; }).join('') +
      '</select></label>' +
      (isOpen() ? '<label class="mini"><span>seed is</span><select id="meta-seedrole">' + seedRoleOptions(S.meta.seedRole, 'not one instrument') + '</select></label>' : '') +
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
    '<button type="button" role="tab" data-view="lineup" aria-selected="' + (!building && !S.override) + '">The line-up</button>' +
    '<button type="button" role="tab" data-view="build" aria-selected="' + building + '">Build your own version</button>' +
    '</div>';
}
function renderDaw() {
  var list = tracks(), d = duration();
  var banner = '';
  if (S.override) {
    banner = '<div class="listening"><span>Listening to <b>' + esc(S.override.name) + '</b> by ' + esc(S.override.by) + '</span>' +
      '<button class="btn btn-sm" type="button" data-fork="' + S.override.id + '">Build on this one</button>' +
      '<button class="btn btn-sm" type="button" data-view="lineup">Back to the line-up</button></div>';
  } else if (S.view === 'build') {
    banner = '<div class="listening build"><span><b>Your version.</b> The seed is always in. Pick any take below, ' +
      'including ones that were vetoed or are still waiting.</span></div>';
  }
  if (!list.length) {
    el('daw').innerHTML = dawTabs() + banner + '<div class="empty-state"><b>' + (hasSeed() ? 'Loading audio' : 'No audio yet') + '</b>' +
      '<p class="tiny muted">' + (hasSeed() ? 'The takes are coming down from storage.' : 'Load a seed, then let takes in. They stack up here like tracks in a DAW.') + '</p></div>';
    renderPicker();
    return;
  }
  var bs = barSeconds(), barCount = Math.max(1, Math.ceil(d / bs));
  var ticks = '';
  for (var i = 0; i < barCount; i++) {
    ticks += '<span class="tick' + (i % 4 === 0 ? ' major' : '') + '" style="left:' + (i * bs / d * 100) + '%">' +
      (i % 4 === 0 || barCount < 17 ? (i + 1) : '') + '</span>';
  }

  var building = S.view === 'build' && !S.override, host = isHost();
  var rows = list.map(function (t) {
    var r = role(t.roleId), c = ctl(t), v = volOf(t);
    var isTrial = !S.override && !building && S.trial === t.id;
    var status = '';
    if (S.override || building) {
      if (t.id !== 'seed' && S.members.indexOf(t) < 0) status = S.applicants.indexOf(t) > -1 ? 'waiting' : 'vetoed';
    }
    return '<div class="track' + (c.mute ? ' muted-t' : '') + (c.solo ? ' solo-t' : '') + (isTrial ? ' trial' : '') + '">' +
      '<div class="t-head">' +
        '<div class="t-name">' + ico(r.icon, col(r)) +
          '<div><b>' + esc(t.by || 'you') + (isTrial ? ' <span class="trybadge">trying out</span>' : '') +
          (status ? ' <span class="stag">' + status + '</span>' : '') + '</b>' +
          '<span class="tiny muted">' + labelOf(t) + (t.id !== 'seed' ? ' ' + verTag(t.id) : '') + '</span></div>' +
          (building && t.id !== 'seed' ? '<button class="tbtn rm" type="button" data-pick="' + t.id + '" title="Take it out of your version" aria-label="Remove ' + esc(t.by) + ' from your version">&times;</button>' : '') +
        '</div>' +
        (isTrial ? voteBlock(t) + '<div class="t-try">' +
          (host ? '<button class="btn btn-sm btn-ember" type="button" data-yes="' + t.id + '">Let it in</button>' : '') +
          '<button class="btn btn-sm" type="button" data-untrial="1">Take it out</button></div>' : '') +
        '<div class="t-ctrl">' +
          '<button class="tbtn play-t' + (only === t.id ? ' on' : '') + '" type="button" data-prev="' + t.id + '" title="Play just this track" aria-label="Play only the take by ' + esc(t.by) + '">' +
            (only === t.id ? I_PAUSE : I_PLAY) + '</button>' +
          '<button class="tbtn' + (c.mute ? ' on' : '') + '" type="button" data-mute="' + t.id + '" aria-pressed="' + !!c.mute + '" title="Mute">M</button>' +
          '<button class="tbtn' + (c.solo ? ' on solo' : '') + '" type="button" data-solo="' + t.id + '" aria-pressed="' + !!c.solo + '" title="Solo">S</button>' +
          '<input type="range" min="0" max="1" step="0.02" value="' + v + '" data-vol="' + t.id + '" aria-label="Volume for ' + esc(t.by) + '">' +
          '<button class="tbtn" type="button" data-dl="' + t.id + '" title="Download this take">' + I_DL + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="t-lane" data-seek="1">' +
        '<canvas data-wave="' + t.id + '" height="72"></canvas>' +
        (t.len < d - .05 ? '<span class="short">shorter than the session</span>' : '') +
      '</div></div>';
  }).join('');

  el('daw').innerHTML = dawTabs() + banner +
    '<div class="daw-bar">' +
      '<button class="btn btn-ember" type="button" id="transport">' + (running ? I_PAUSE + ' Stop' : I_PLAY + ' Play') + '</button>' +
      '<button class="btn btn-sm" type="button" id="rewind" title="Back to the start">&#9198;</button>' +
      '<span class="readout" id="readout">' + clockMs(position()) + ' / ' + clockMs(d) + '</span>' +
      '<span class="tiny muted">' + list.length + ' track(s), ' + barCount + ' bars at ' + (S.meta.bpm || '?') + ' bpm ' + S.meta.time + '</span>' +
      '<button class="btn btn-sm" type="button" id="dl-all">' + I_DL + ' Download these takes</button>' +
    '</div>' +
    '<div class="ruler"><span class="r-head"></span><span class="r-lane">' + ticks + '</span></div>' +
    '<div class="tracks">' + rows + '</div>' +
    '<div class="playhead" id="playhead"></div>';

  list.forEach(function (t) { drawWave(t); });
  renderPicker();
  tick();
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
      var status = S.members.indexOf(t) > -1 ? 'in the line-up' : (S.applicants.indexOf(t) > -1 ? 'waiting' : 'vetoed');
      var on = only === t.id;
      return '<li class="pk' + (picked ? ' picked' : '') + '">' +
        '<button class="play sm' + (on ? ' on' : '') + '" type="button" data-prev="' + t.id + '" aria-label="Hear ' + esc(t.by) + ' on its own">' +
          (on ? I_PAUSE : I_PLAY) + '</button>' +
        '<div class="pk-who"><b>' + esc(t.by) + '</b><span>' + status + '</span></div>' +
        '<button class="btn btn-sm pk-btn' + (picked ? ' on' : '') + '" type="button" data-pick="' + t.id + '" aria-pressed="' + picked + '">' +
          (picked ? 'In' : 'Add') + '</button></li>';
    }).join('') : '<li class="empty">No takes yet.</li>';
    return '<div class="pk-col" style="color:' + col(r) + '"><div class="pk-head">' + ico(r.icon, col(r)) + '<b>' + r.label + '</b></div>' +
      '<ul>' + items + '</ul></div>';
  }).join('');

  box.innerHTML =
    '<div class="pk-grid">' + cols + '</div>' +
    '<div class="pk-save">' +
      '<label class="field"><span>Name your version</span><input type="text" id="ver-name" maxlength="60" placeholder="e.g. The one with both basses"></label>' +
      '<label class="field"><span>Your name</span><input type="text" id="ver-by" maxlength="60" placeholder="how you show up under the session" value="' + esc(savedName()) + '"></label>' +
      '<button class="btn btn-ember" type="button" id="ver-save"' + (S.build.picks.length && S.session ? '' : ' disabled') + '>Save this version</button>' +
      '<span class="tiny muted">' + S.build.picks.length + ' take(s) on top of the seed. Only the choice is saved, nothing gets re-uploaded.</span>' +
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
    '<div><b>' + esc(v.name) + '</b><span class="tiny muted">by ' + esc(v.by) + ', ' + v.picks.length + ' take(s) on the seed</span></div></div>' +
    '<div class="vc-chips">' + chips + '</div>' +
    '<div class="vc-foot"><button class="btn btn-sm' + (v.liked ? ' on' : '') + '" type="button" data-like="' + v.id + '"' +
      (v.liked ? ' disabled aria-label="You liked this"' : '') + '>&#9829; ' + v.likes + '</button>' +
    '<button class="btn btn-sm" type="button" data-fork="' + v.id + '">Build on this one</button></div></article>';
}
function officialCard() {
  var on = !S.override && S.view !== 'build' && running;
  return '<article class="vcard official">' +
    '<div class="vc-top"><button class="play' + (on ? ' on' : '') + '" type="button" data-playofficial="1" aria-label="Play the official line-up">' +
      (on ? I_PAUSE : I_PLAY) + '</button>' +
    '<div><b>The line-up</b><span class="tiny muted">official, chosen by the seed</span></div></div>' +
    '<div class="vc-chips">' + S.members.map(function (t) {
      var r = role(t.roleId);
      return '<span class="vchip">' + ico(r.icon, col(r)) + esc(t.by) + '</span>';
    }).join('') + '</div></article>';
}
function renderVersionLists() {
  var sorted = S.versions.slice().sort(function (a, b) { return b.likes - a.likes; });
  var html = officialCard() + sorted.map(versionCard).join('');
  ['fanmixes', 'rel-fanmixes'].forEach(function (id) { if (el(id)) el(id).innerHTML = html; });
  if (el('fan-sub')) el('fan-sub').textContent = S.versions.length
    ? S.versions.length + ' version(s) from the room, sorted by hearts. The official line-up stays on top.'
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
  g.fillStyle = cvar(role(t.roleId).color);
  g.globalAlpha = ctl(t).mute ? .3 : .85;
  var n = t.peaks.length, mid = h / 2;
  for (var x = 0; x < w; x++) {
    var p = t.peaks[Math.floor(x / w * n)] || 0;
    var bar = Math.max(1, p * (h - 6));
    g.fillRect(x, mid - bar / 2, 1, bar);
  }
  g.globalAlpha = 1;
}

/* ---------- waiting board ---------- */
function anLine(t) {
  if (!t.an || !t.an.bpm) return '';
  var off = S.meta.bpm && Math.abs(t.an.bpm - S.meta.bpm) > 2;
  return '<div class="an' + (off ? ' off' : '') + '">' + t.an.bpm + ' bpm, ' + t.an.key + (off ? ' — off the session tempo' : '') + '</div>';
}
function applyCard(r) {
  var list = waitingFor(r.id), free = cap(r.id) - inSong(r.id).length, host = isHost(), held = seedHolds(r.id);
  var body = list.length ? list.map(function (t) {
    var on = only === t.id && running;
    return '<li class="app">' +
      '<div class="app-top">' +
        '<button class="play sm' + (on ? ' on' : '') + '" type="button" data-prev="' + t.id + '" aria-label="Preview the take by ' + esc(t.by) + '">' +
          (on ? I_PAUSE : I_PLAY) + '</button>' +
        '<b>' + esc(t.by) + '</b><span class="len">' + fmt(t.len) + '</span>' +
        '<button class="btn btn-sm icobtn" type="button" data-dl="' + t.id + '" aria-label="Download this take">' + I_DL + '</button>' +
      '</div>' + anLine(t) + (inVersions(t.id) ? '<div class="vline">' + verTag(t.id) + '</div>' : '') +
      voteBlock(t) +
      '<button class="btn btn-sm trybtn' + (S.trial === t.id ? ' on' : '') + '" type="button" data-try="' + t.id + '">' +
        (S.trial === t.id ? 'Take out of the mix' : 'Hear it in the mix') + '</button>' +
      (t.note ? '<div class="note">&ldquo;' + esc(t.note) + '&rdquo;</div>' : '') +
      (host && isOpen()
        ? '<div class="app-foot"><span class="acts">' +
          (held ? '' : '<button class="btn btn-sm btn-ember" type="button" data-yes="' + t.id + '">Let it in</button>') +
          '<button class="btn btn-sm btn-veto" type="button" data-no="' + t.id + '">Veto</button></span></div>'
        : '<div class="app-foot"><span class="tiny muted">The host lets it in or vetoes it.</span></div>') +
      '</li>';
  }).join('') : '<li class="empty">Nothing waiting here.</li>';

  return '<article class="gate apply" style="color:' + col(r) + '">' +
    '<div class="g-top"><div class="g-name">' + ico(r.icon, col(r)) + '<h3>' + r.label + '</h3>' +
    '<span class="count">' + list.length + '</span></div>' +
    '<div class="tiny muted">' + (held ? 'The seed plays this part' : free > 0 ? free + ' spot(s) free' : 'Taken, a new take can push it out') + '</div></div>' +
    '<ul class="takes">' + body + '</ul>' +
    '<div class="g-foot"><button class="btn btn-ember btn-sm" type="button" data-apply="' + r.id + '"' + (isOpen() ? '' : ' disabled') + '>Send a take</button></div></article>';
}

function renderBoards() {
  el('applyboard').innerHTML = ROLES.map(applyCard).join('');
  el('lineup-sub').textContent = S.members.length
    ? S.members.length + ' take(s) on top of the seed.'
    : 'Nothing in the song yet. Everything starts in the waiting list below.';
  el('apply-sub').textContent = !S.applicants.length
    ? 'Empty. Use "Send a take" on any instrument to put one on the floor.'
    : isHost()
      ? 'You dropped the seed, so your yes or veto is final. The line-up votes along to steer you. Whoever holds a spot does not vote on their own replacement.'
      : 'Whoever dropped the seed decides. If you have a take in the line-up, your vote steers them.';
}
function renderArchive() {
  var show = S.archive.length > 0;
  el('archive-head').style.display = show ? '' : 'none';
  el('archive').style.display = show ? '' : 'none';
  if (!show) return;
  el('archive').innerHTML = '<ul class="rows">' + S.archive.slice().reverse().map(function (a) {
    var r = role(a.take.roleId);
    return '<li class="row">' + ico(r.icon, col(r)) +
      '<div><b>' + esc(a.take.by) + '</b><div class="meta">' + r.label + ', ' + a.why + ' ' + verTag(a.take.id) + '</div></div>' +
      '<button class="btn btn-sm icobtn" type="button" data-dl="' + a.take.id + '" aria-label="Download">' + I_DL + '</button>' +
      '<button class="btn btn-sm" type="button" data-apply="' + r.id + '"' + (isOpen() ? '' : ' disabled') + '>Try again</button></li>';
  }).join('') + '</ul>';
}
function renderLock() {
  el('lock-status').innerHTML = S.members.length + ' take(s) in the song, ' + S.applicants.length + ' waiting' +
    (hasSeed() ? '' : ', <strong>no seed yet</strong>') +
    (S.session && !isOpen() ? ', <strong>session closed</strong>' : '');
  var btn = el('lock-btn');
  btn.style.display = isHost() && isOpen() ? '' : 'none';
  btn.disabled = !(hasSeed() && S.members.length);
}

/* Realtime updates re-render while people type. Keep what they typed and where the cursor was. */
var KEEP = ['ver-name', 'ver-by', 'mix-by', 'seed-by', 'seed-role', 'meta-bpm'];
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
  keepInputs(function () { renderSeed(); renderDaw(); renderBoards(); renderArchive(); renderLock(); renderVersionLists(); });
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
    '<p class="tiny muted">Balance it with the faders on the floor if you want, that is what the room hears.</p>' +
    '<button class="btn btn-sm" type="button" id="dl-all2">' + I_DL + ' Download the stems</button>';

  el('mix-box').innerHTML = S.mix
    ? '<div class="rawrow"><button class="btn btn-ember btn-sm" type="button" id="play-mix">' + I_PLAY + ' Play the mix</button>' +
      '<div><b>' + esc(S.mix.by) + '</b><div class="tiny muted">' + esc(S.mix.fileName) + '</div></div></div>' +
      '<p class="tiny muted">Sits next to the raw version, it does not replace it.</p>'
    : isOpen()
      ? '<p class="tiny muted">Anyone can add a mixed version once the host closes the session.</p>'
      : '<div class="dropzone" id="mixzone"><b>Upload a mixed version</b>' +
        '<span class="tiny muted">optional, anyone can do it</span>' +
        '<input type="file" id="mix-file" accept="audio/*" aria-label="Upload a mixed version"></div>' +
        '<label class="field"><span class="tiny muted">Who mixed it</span>' +
        '<input type="text" id="mix-by" placeholder="your name" value="' + esc(savedName()) + '"></label>';

  el('credits').innerHTML =
    (hasSeed() ? '<div class="credit">' + ico('seed', 'var(--ember)') + '<div><b>' + esc(host ? 'you' : S.seed.by) + '</b><small>the seed' + (seedInstr() ? ', ' + seedInstr().label.toLowerCase() : '') + '</small></div></div>' : '') +
    S.members.map(function (m) {
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

/* ---------- seed ---------- */
function loadSeed(file) {
  var nameEl = el('seed-by');
  var name = ((nameEl && nameEl.value) || S.seed.by || savedName()).trim();
  var roleEl = el('seed-role');
  if (!name) { flash('Add your name first, it goes in the credits.'); if (nameEl) nameEl.focus(); return; }
  if (!me) { flash('Still connecting, try again in a second.'); return; }
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
    if (roleEl) patch.seed_role = roleEl.value || null;
    if (an && (an.tempo || an.key)) {
      patch.bpm = an.tempo ? an.tempo.bpm : null;
      patch.music_key = an.key ? an.key.key : null;
      patch.key_alt = an.key ? an.key.runnerUp : null;
      patch.meta_from = 'detected';
      patch.meta_sure = sureness(Math.min(an.tempo ? an.tempo.conf : 0, an.key ? an.key.conf : 0));
    }
    return db.updateSession(S.session.id, patch).then(function () {
      stopAll();
      flash((created ? 'Session started. Share the link from the bar below. ' : '') +
        (patch.bpm ? 'Heard about ' + patch.bpm + ' bpm in ' + patch.music_key + '. Correct it if it is off.' : 'Seed loaded.'));
      return refresh();
    });
  }).catch(function (e) {
    oops(e);
  }).then(function () {
    S.seedBusy = false; S.meta.busy = false; render();
  });
}

var pendingAttach = null;
el('attach-file').addEventListener('change', function () {
  var file = this.files[0];
  this.value = '';
  if (!file || pendingAttach !== 'seed') return;
  pendingAttach = null;
  loadSeed(file);
});

/* ---------- take modal ---------- */
var lastFocus = null;
function fillRoles(sel) {
  el('take-role').innerHTML = ROLES.map(function (r) {
    var free = cap(r.id) - inSong(r.id).length;
    return '<option value="' + r.id + '"' + (r.id === sel ? ' selected' : '') + '>' +
      r.label + (seedHolds(r.id) ? ' (the seed)' : free > 0 ? ' (' + free + ' free)' : ' (taken)') + '</option>';
  }).join('');
  roleHint();
}
function roleHint() {
  var id = el('take-role').value, r = role(id), free = cap(id) - inSong(id).length;
  el('modal-ico').innerHTML = ico(r.icon, col(r));
  el('role-hint').textContent = seedHolds(id)
    ? 'The seed plays this part, so it cannot join the line-up. People can still use it in their own versions.'
    : free > 0
    ? 'There is room here. It lands in the waiting list for this instrument.'
    : 'Taken right now. Get let in and you push that take back to the waiting list.';
}
function openModal(roleId) {
  if (!hasSeed()) { flash('Load a seed first, it sets the length for everyone.'); return; }
  if (!isOpen()) { flash('This session is closed.'); return; }
  lastFocus = document.activeElement;
  fillRoles(roleId || ROLES[0].id);
  el('modal-sub').textContent = 'One instrument per take. Dry, from bar 1, exactly ' + fmt(target()) + ' long.';
  el('modal-err').classList.remove('on');
  el('take-file').value = ''; el('take-name').value = savedName(); el('take-note').value = '';
  el('file-name').textContent = 'wav or mp3, dry, starting at bar 1';
  el('modal-send').disabled = false; el('modal-send').textContent = 'Put it on the floor';
  el('scrim').classList.add('on');
  el('take-name').focus();
}
function closeModal(){ el('scrim').classList.remove('on'); if (lastFocus) lastFocus.focus(); }

el('take-role').addEventListener('change', roleHint);
el('take-file').addEventListener('change', function () {
  el('file-name').textContent = this.files.length ? this.files[0].name : 'wav or mp3, dry, starting at bar 1';
});
el('modal-cancel').addEventListener('click', closeModal);
el('scrim').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
el('modal-send').addEventListener('click', function () {
  var name = el('take-name').value.trim(), f = el('take-file').files[0], btn = this;
  function fail(m){ el('modal-err').textContent = m; el('modal-err').classList.add('on'); btn.disabled = false; btn.textContent = 'Put it on the floor'; }
  if (!f) return fail('Pick an audio file first.');
  if (!name) return fail('Add your name for the credits.');
  btn.disabled = true; btn.textContent = 'Uploading...';
  decode(f).then(function (buf) {
    if (target() && Math.abs(buf.duration - target()) > TOL)
      return fail('Your file is ' + fmt(buf.duration) + ', the session is ' + fmt(target()) + '. Trim or pad it to match.');
    rememberName(name);
    return uploadTake(f, buf, { role:el('take-role').value, status:'waiting', name:name, note:el('take-note').value.trim(), analyse:true })
      .then(function () {
        closeModal();
        flash('On the floor. The host lets it in or vetoes it.');
        return refresh();
      }, function (e) { console.error(e); fail((e && e.message) || 'The upload failed. Try again.'); });
  }).catch(function () { fail('That file could not be read.'); });
});

/* the seed takes a slot in its instrument; the database bumps the oldest takes if that overfills it */
function setSeedRole(id) {
  var out = id ? inSong(id).slice(0, Math.max(0, inSong(id).length - (role(id).slots - 1))) : [];
  S.meta.seedRole = id;
  render();
  patchSession({ seed_role:id }).then(function () {
    if (out.length && S.session.seed_role === id) flash(out.map(function (t) { return t.by; }).join(' and ') + (out.length > 1 ? ' are' : ' is') + ' back in the waiting list, the seed plays ' + role(id).label.toLowerCase() + '.');
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
  var at = e.target.closest('[data-attach]');
  if (at) { pendingAttach = at.dataset.attach; el('attach-file').click(); return; }
  var d = e.target.closest('[data-dl]');
  if (d) { download(findTake(d.dataset.dl)); return; }
  var pv = e.target.closest('[data-prev]');
  if (pv) { preview(findTake(pv.dataset.prev)); return; }
  var vw = e.target.closest('[data-view]');
  if (vw) {
    stopAll();
    S.override = null; S.view = vw.dataset.view;
    if (S.view === 'build') S.trial = null;
    refreshGains(); render();
    flash(S.view === 'build' ? 'Pick takes from every instrument, then save your version.' : 'Back to the official line-up.');
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
      S.build = { picks:src.picks.slice(), ctl:JSON.parse(JSON.stringify(src.ctl || {})) };
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
    if (S.trial) { play(0); flash('Playing the line-up with this take on top.'); }
    else flash('Back to the line-up as it stands.');
    return;
  }
  if (e.target.closest('[data-untrial]')) { S.trial = null; stopAll(); render(); return; }
  var vt = e.target.closest('[data-vote]');
  if (vt) {
    var vtake = findTake(vt.dataset.take);
    if (!vtake || !canVote(vtake)) return;
    db.castVote({ takeId:vtake.dbId, sessionId:S.session.id, voterId:me.id, value:vt.dataset.vote })
      .then(function () { flash('Vote counted. The host still makes the call.'); return refresh(); })
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
  var react = e.target.closest('[data-react]');
  if (react && S.session && me && !S.reacted[react.dataset.react]) {
    var kind = react.dataset.react;
    S.reacted[kind] = true; S.reactions[kind] = (S.reactions[kind] || 0) + 1; renderRelease();
    db.react({ sessionId:S.session.id, userId:me.id, kind:kind }).then(refresh).catch(oops);
    return;
  }
  if (e.target.closest('#copy-link')) {
    if (!S.session) { flash('Load a seed first, then you get a link to share.'); return; }
    var link = location.origin + '/s/' + S.session.slug;
    (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject())
      .then(function () { flash('Link copied. Anyone with it can send takes.'); },
            function () { flash('Share this link: ' + link); });
  }
});

document.addEventListener('input', function (e) {
  if (e.target.dataset.vol) {
    var t = findTake(e.target.dataset.vol);
    if (t) { ctl(t).vol = +e.target.value; refreshGains(); }
  }
  if (e.target.id === 'meta-bpm' && isHost()) {
    S.meta.bpm = +e.target.value || null; S.meta.from = 'you';
    clearTimeout(bpmTimer);
    bpmTimer = setTimeout(function () { patchSession({ bpm:S.meta.bpm, meta_from:'you' }); }, 600);
  }
  if (e.target.id === 'song-title' && isHost()) {
    S.title = e.target.value;
    clearTimeout(titleTimer);
    titleTimer = setTimeout(function () { patchSession({ title:(S.title || 'Untitled').slice(0, 120) }); }, 600);
  }
});
document.addEventListener('change', function (e) {
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
window.addEventListener('resize', function () { tracks().forEach(drawWave); });

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
    if (!m) { flash('Load a seed to start a session. You will get a link to share.'); render(); return; }
    return db.loadSessionBySlug(m[1]).then(function (sess) {
      if (!sess) { flash('That session does not exist. Load a seed to start a new one.'); history.replaceState(null, '', '/'); render(); return; }
      S.session = sess;
      watch(sess.id);
      return refresh().then(function () {
        flash(isHost() ? 'You host this session. Copy the link to invite people.' : 'You are on the floor. Send a take on any instrument.');
      });
    });
  }).catch(oops);
}
boot();

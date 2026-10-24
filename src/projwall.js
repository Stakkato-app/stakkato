/* The wall in the project (/s/<slug>): the same wall as on the homepage (src/wall.js), drawn under
   the tracks from the project's own state. Picking a tile switches the tracks above to that stack
   (wallSwitch() in app.js); ▶ on a tile plays it there. S on a tile and "Play the whole song from
   the start" play here, with the project's audio context.

   Egress: nothing here downloads audio. The tiles draw from takes.peaks or from the buffers the
   project already decoded (TAKES), and what plays is what the project plays (playBuf(): the take,
   or its amp's render, stored or made here). */

import { initWall, wallHtml, wallTree, wallKey, wallSeek, wallSolo, wallPick, wallHead, wallScrolls, wallFullId, ghostOff } from './wall.js';
import { decodePeaks, columns } from './peaks.js';
import { fadeIn, fadeOut } from './rec.js';
import { ROLES } from './roles.js';
import * as db from './data.js';

var A = null;                       /* what app.js hands over: initProjectWall() */
var S = { expanded:{}, ov:null, playing:null, wback:null, sure:null };
var BUF = {}, SRC = [], FADE = null, SEQ = 0, CLOCK = null, R = null;

var LAYERS = { seed:{ label:'original track', c:'var(--seed)' }, part:{ label:'new part', c:'var(--part)' }, wild:{ label:'take', c:'var(--wave)' } };
ROLES.forEach(function (r) { LAYERS[r.id] = { label:r.label.toLowerCase(), c:'var(' + r.color + ')' }; });
function lay(id) { return LAYERS[id] || LAYERS.wild; }
function el(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function mmss(t) { t = Math.max(0, t || 0); return Math.floor(t / 60) + ':' + ('0' + Math.floor(t % 60)).slice(-2); }
/* the length as stored (duration_sec), like the homepage shows it; a decoded buffer can come out a few samples shorter */
function durOf(t) { return t.dsec || t.len; }

/* ---------- the jam as the wall wants it (the homepage's shape, see build() in home.js) ---------- */
function build() {
  var st = A.S(), TK = A.TAKES(), me = A.me(), s = st.session, seed = st.seed;
  var votes = st.tVotes || {}, posts = [];
  function mine(uid) { return !!(me && uid === me.id); }
  function idOf(t) { return t.dbId || t.id; }
  function carried(ids) {
    return (ids || []).map(function (id) {
      if (seed && id === seed.dbId) return { id:'riff', isRiff:true, by:seed.by, layer:LAYERS[s.seed_role] ? s.seed_role : 'seed', dur:durOf(seed), peaks:seed.pk || null };
      var c = TK[id]; if (!c || c.status === 'deleted' || c.roleId === 'part' || c.roleId === 'mix') return null;
      return { id:id, tid:id, by:c.by, uid:c.authorId, layer:LAYERS[c.roleId] ? c.roleId : 'wild', dur:durOf(c), peaks:c.pk || null };
    }).filter(Boolean);
  }
  Object.keys(TK).forEach(function (k) {
    var t = TK[k], id = idOf(t);
    if (t === seed || t.roleId === 'seed' || t.roleId === 'mix' || t.status === 'own' || t.status === 'seed' || t.status === 'mix') return;
    if (t.status === 'deleted') {
      if (t.roleId !== 'part') posts.push({ id:id, parent:t.replyTo || t.sec || null, deleted:true, created:t.created, likes:0 });
      return;
    }
    var base = { id:id, tid:id, by:t.by, uid:t.authorId, mine:mine(t.authorId), created:t.created, text:t.note, path:t.path, copy:t.copy || null,
      dur:durOf(t), peaks:t.pk || null, likes:votes[id] || 0, status:t.status };
    if (t.roleId === 'part') {
      if (t.status !== 'in' && t.status !== 'waiting') return;
      posts.push(Object.assign(base, { parent:t.replyTo || null, kind:'part', layer:'part', pos:t.pos, carry:carried(t.carry) }));
      return;
    }
    posts.push(Object.assign(base, { parent:t.replyTo || t.sec || null, section:t.sec || null, group:t.group || null, layer:LAYERS[t.roleId] ? t.roleId : 'wild' }));
  });
  (st.words || []).forEach(function (w) {
    var parent = w.toTake || w.toWord || null;
    if (w.deleted) { posts.push({ id:w.id, parent:parent, deleted:true, isComment:true, created:w.created, likes:0 }); return; }
    posts.push({ id:w.id, parent:parent, by:w.by, uid:w.authorId, mine:mine(w.authorId), time:A.agoOf(w.created), created:w.created, text:w.body,
      likes:votes[w.id] || 0, isComment:true });
  });
  var groups = {};
  posts.sort(function (a, b) { return String(a.created).localeCompare(String(b.created)); });
  posts = posts.filter(function (p) {
    var g = p.group; if (!g || p.deleted) return true;
    if (!groups[g]) { groups[g] = p; p.stems = []; return true; }
    groups[g].stems.push({ id:p.id, tid:p.tid, by:p.by, uid:p.uid, mine:p.mine, layer:p.layer, path:p.path, copy:p.copy, dur:p.dur, peaks:p.peaks }); return false;
  });
  var ids = {}; posts.forEach(function (p) { ids[p.id] = 1; });
  posts.forEach(function (p) { if (p.parent && !ids[p.parent]) p.parent = null; });
  for (var again = true; again;) {
    again = false;
    posts = posts.filter(function (p) {
      if (!p.deleted || posts.some(function (k) { return k.parent === p.id; })) return true;
      again = true; return false;
    });
  }
  return { id:s.id, slug:s.slug, by:seed.by, uid:s.host_id, title:s.title, text:seed.note, path:seed.path, layer:LAYERS[s.seed_role] ? s.seed_role : 'seed',
    dur:durOf(seed), peaks:seed.pk || null, likes:votes[s.id] || 0, host:A.isHost(), open:s.status === 'open', posts:posts };
}
function riff() { return R; }
function postOf(r, id) { return r.posts.filter(function (p) { return p.id === id; })[0]; }
/* the post a take belongs to: itself, or the reply it was sent with */
function postFor(r, id) { return r.posts.filter(function (p) { return p.id === id || (p.stems || []).some(function (x) { return x.id === id; }); })[0]; }
function stemsOf(p) { return [p].concat((p.stems || []).map(function (x) { return Object.assign({}, x, { id:p.id + '~' + x.id, dbId:x.id }); })); }
function chainOf(r, pid) {
  var out = [];
  for (var p = pid ? postOf(r, pid) : null; p; p = p.parent ? postOf(r, p.parent) : null) {
    if (p.kind === 'part') return [{ id:p.id, tid:p.tid, by:p.by, mine:p.mine, layer:'part', dur:p.dur, peaks:p.peaks, isPart:true }].concat(p.carry || [], out);
    if (p.layer) out = stemsOf(p).concat(out);
  }
  return [{ id:'riff', by:r.by, uid:r.uid, layer:r.layer, dur:r.dur, peaks:r.peaks, isRiff:true, mine:r.host }].concat(out);
}
function bufKey(r, p) { return p.isRiff ? r.id + ':riff' : r.id + ':' + p.id; }
function chipLabel(p) { return p.isRiff ? 'clip' : p.isPart ? 'new part' : lay(p.layer).label; }

/* ---------- audio: only what the project already decoded ---------- */
function takeOf(p) { return p.isRiff ? A.S().seed : A.TAKES()[p.dbId || p.tid || p.id] || null; }
/* the wall's "load": point at the project's buffer, never fetch */
function load(r, p) {
  var t = takeOf(p), b = t && t.buf, k = bufKey(r, p);
  if (b && BUF[k] !== b) { BUF[k] = b; dropMixes(); }
  return Promise.resolve();
}
function dropMixes() { Object.keys(BUF).forEach(function (k) { if (k.indexOf('wmix:') === 0 && k.slice(-5) !== ':busy') delete BUF[k]; }); }
/* what a take sounds like: the project's own (its amp's render when it has one; silent until that is ready) */
function bufFor(r, p) { var t = takeOf(p); return t ? A.playBuf(t) : null; }
function ac() { return A.ac(); }
function silence() { SEQ++; if (SRC.length) fadeOut(ac(), FADE, SRC); SRC = []; FADE = null; }
function stop() { silence(); S.playing = null; CLOCK = null; tickHeads(); }
/* the project's transport and the wall never play at the same time */
function quietProject() { if (A.running()) A.stopAll(true); }
function playList(k, r, c, at) {
  var seek = typeof at === 'number';
  if (S.playing === k && !seek) { stop(); renderWall(); return; }
  quietProject();
  silence(); CLOCK = null;
  S.playing = k; renderWall();
  var a = ac(); a.resume(); var T = a.currentTime + 0.05, len = 0;
  c.forEach(function (p) { var b = bufFor(r, p); if (b) len = Math.max(len, b.duration); });
  if (!len) return;
  var from = seek ? ((at % len) + len) % len : 0, fade = FADE = fadeIn(a, T, a.destination);
  c.forEach(function (p) {
    var b = bufFor(r, p); if (!b) return;
    var s = a.createBufferSource(); s.buffer = b; s.loop = true; s.connect(fade);
    s.start(T, from % b.duration); SRC.push(s);
  });
  CLOCK = { k:k, t0:T - from, len:len };
  tickHeads();
}
function playPos() {
  if (!CLOCK || CLOCK.k !== S.playing || !CLOCK.len) return null;
  var t = ac().currentTime - CLOCK.t0; return ((t % CLOCK.len) + CLOCK.len) % CLOCK.len;
}
/* segs play one after the other, then again from the top. opt.then 'last' keeps repeating only the
   last one (a stack built up layer by layer, then looped), 'stop' stops after one time through;
   opt.onSeg(i) says when segment i starts the first time through (and segs.length at its end) */
function playSeq(k, r, segs, from, opt) {
  opt = opt || {};
  from = from || 0;
  quietProject();
  silence(); CLOCK = null;
  var mine = SEQ, first = true;
  S.playing = k; renderWall();
  (function round() {
    if (S.playing !== k || SEQ !== mine) return;
    var a = ac(); a.resume(); var T0 = a.currentTime + 0.05, T = T0, fade = FADE = fadeIn(a, T0, a.destination), skip = from, total = 0;
    segs.forEach(function (seg) { var lead = bufFor(r, seg[0]); total += lead ? lead.duration : 0; });
    if (!total) return;
    CLOCK = { k:k, t0:T0 - from, len:total }; tickHeads();
    segs.forEach(function (seg, si) {
      var lead = bufFor(r, seg[0]), len = lead ? lead.duration : 0;
      if (first && opt.onSeg && skip < len) (function (at, i) { setTimeout(function () { if (S.playing === k && SEQ === mine) opt.onSeg(i); }, Math.max(0, (at - a.currentTime) * 1000)); })(T, si);
      if (skip >= len) { skip -= len; return; }
      seg.forEach(function (x) {
        var b = bufFor(r, x); if (!b || !len) return;
        var s = a.createBufferSource(); s.buffer = b; s.loop = true; s.connect(fade);
        s.start(T, skip % b.duration); s.stop(T + len - skip); SRC.push(s);
      });
      T += len - skip; skip = 0;
    });
    from = 0;
    var endAt = Math.max(0, (T - a.currentTime) * 1000) - 30, wasFirst = first, nSeg = segs.length; first = false;
    if (wasFirst && opt.onSeg) setTimeout(function () { if (S.playing === k && SEQ === mine) opt.onSeg(nSeg); }, endAt + 30);
    if (wasFirst && opt.then === 'stop') { setTimeout(function () { if (S.playing === k && SEQ === mine) { stop(); renderWall(); } }, endAt + 30); return; }
    if (wasFirst && opt.then === 'last' && segs.length > 1) { segs = [segs[segs.length - 1]]; }
    setTimeout(function () { if (S.playing === k && SEQ === mine) round(); }, endAt);
  })();
}
/* app.js calls this when the project starts playing */
export function wallStop() { if (S.playing) { stop(); renderWall(); } }

/* ---------- playheads and seeking (only inside the wall) ---------- */
function headOf(cv, cls) {
  var box = cv.parentNode, h = box.querySelector(':scope > .' + cls + '[data-for="' + cv.dataset.wave + '"]');
  if (!h) { h = document.createElement('span'); h.className = cls; h.dataset.for = cv.dataset.wave; h.setAttribute('aria-hidden', 'true'); box.appendChild(h); }
  h.style.top = cv.offsetTop + 'px'; h.style.height = cv.offsetHeight + 'px';
  return h;
}
var headRaf = 0;
function tickHeads() {
  cancelAnimationFrame(headRaf);
  [].forEach.call(document.querySelectorAll('#wall .phead'), function (h) { h.hidden = true; });
  if (!CLOCK || S.playing !== CLOCK.k) { wallHead(0, 0); return; }
  var pos = ((ac().currentTime - CLOCK.t0) % CLOCK.len + CLOCK.len) % CLOCK.len, f = CLOCK.len ? pos / CLOCK.len : 0;
  wallHead(pos, CLOCK.len);
  [].forEach.call(document.querySelectorAll('#wall canvas[data-wave]'), function (cv) {
    if (cv.closest('.wm-wave')) return;
    if (S.playing !== cv.dataset.wave && S.playing !== cv.dataset.of) return;
    var h = headOf(cv, 'phead'); h.hidden = false; h.style.left = (cv.offsetLeft + cv.offsetWidth * f) + 'px';
  });
  headRaf = requestAnimationFrame(tickHeads);
}
function waveOf(k) {
  var i = k.indexOf(':'), r = R, pid = k.slice(i + 1); if (!r) return null;
  if (pid === 'riff') return r;
  var ids = pid.split('~'), p = postOf(r, ids[0]);
  if (p && ids[1]) return (p.stems || []).filter(function (x) { return x.id === ids[1]; })[0] || null;
  return p || null;
}
function lenOf(cv) { var b = BUF[cv.dataset.wave], w = !b && waveOf(cv.dataset.wave); return b ? b.duration : w && w.dur || 0; }
document.addEventListener('mousemove', function (e) {
  var cv = e.target.closest && e.target.closest('#wall canvas[data-wave]');
  [].forEach.call(document.querySelectorAll('#wall .shead'), function (h) { if (!cv || h.dataset.for !== cv.dataset.wave) h.hidden = true; });
  if (!cv || !cv.classList.contains('wseekable') || !lenOf(cv)) return;
  var rect = cv.getBoundingClientRect(), f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  var h = headOf(cv, 'shead'); h.hidden = false; h.style.left = (cv.offsetLeft + cv.offsetWidth * f) + 'px';
  h.dataset.t = mmss(f * lenOf(cv));
});

/* ---------- drawing ---------- */
function waveShape(cv, buf, color, peaks) {
  var w = cv.clientWidth, h = cv.clientHeight, dpr = window.devicePixelRatio || 1;
  if (!w || !h) return;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  var g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  g.fillStyle = color;
  var mid = h / 2, pk = !buf && (typeof peaks === 'string' ? decodePeaks(peaks) : peaks);
  if (!buf && !pk) { g.globalAlpha = .35; g.fillRect(0, mid - 1, w, 2); return; }
  var cols = Math.max(1, Math.floor(w)), hi = [], lo = [], peak = 0, x, i;
  if (pk) { var c = columns(pk, cols); hi = c.hi; lo = c.lo; peak = Math.max.apply(null, hi.concat(lo.map(function (v) { return -v; }))); }
  else {
    var d = buf.getChannelData(0), step = d.length / cols;
    for (x = 0; x < cols; x++) {
      var a = Math.floor(x * step), z = Math.min(d.length, Math.floor((x + 1) * step)), mx = 0, mn = 0;
      for (i = a; i < z; i++) { var v = d[i]; if (v > mx) mx = v; else if (v < mn) mn = v; }
      hi.push(mx); lo.push(mn); peak = Math.max(peak, mx, -mn);
    }
  }
  var k = peak ? (mid - 1) / peak : 0;
  g.beginPath(); g.moveTo(0, mid - hi[0] * k);
  for (x = 1; x < cols; x++) g.lineTo(x * w / cols, mid - Math.max(.6, hi[x] * k));
  for (x = cols - 1; x >= 0; x--) g.lineTo(x * w / cols, mid - Math.min(-.6, lo[x] * k));
  g.closePath(); g.fill();
}
function drawWaves() {
  if (CLOCK) requestAnimationFrame(tickHeads);
  var css = getComputedStyle(document.documentElement);
  [].forEach.call(document.querySelectorAll('#wall canvas[data-wave]'), function (cv) {
    var lit = S.playing && (S.playing === cv.dataset.wave || S.playing === cv.dataset.of);
    var tone = lit && !cv.closest('.wb') ? '--sound' : cv.closest('.wb') && cv.dataset.layer && lay(cv.dataset.layer).c.indexOf('var(') === 0 ? lay(cv.dataset.layer).c.slice(4, -1) : '--wave';
    var b = BUF[cv.dataset.wave], wv = !b && (cv.dataset.wave.indexOf('wmix:') === 0 ? { peaks:BUF[cv.dataset.wave + ':pk'] } : waveOf(cv.dataset.wave));
    /* a tile draws from its saved peaks, else from the project's decoded audio */
    if (!b && wv && !wv.peaks && cv.dataset.wave.indexOf('wmix:') !== 0) {
      var ids = cv.dataset.wave.slice(cv.dataset.wave.indexOf(':') + 1).split('~'), t = ids[0] === 'riff' ? A.S().seed : A.TAKES()[ids[1] || ids[0]];
      b = t && t.buf;
    }
    waveShape(cv, b, css.getPropertyValue(tone).trim(), wv && wv.peaks);
  });
}
function lyr(layer) { return '<b class="lyr" style="color:' + lay(layer).c + '">' + lay(layer).label + '</b>'; }
function ava(name, layer, sm) {
  return '<span class="ava' + (sm ? ' sm' : '') + (layer ? '' : ' words') + '"' + (layer ? ' style="background:' + lay(layer).c + '"' : '') + ' aria-hidden="true">' +
    esc(String(name).charAt(0).toUpperCase()) + '</span>';
}
function riffMeta(r) { return r.dur ? mmss(r.dur) : ''; }

/* ---------- votes and deleting ---------- */
function voteHtml(id) {
  var st = A.S(), kind = st.session && id === st.session.id ? 'session' : (st.words || []).some(function (w) { return w.id === id; }) ? 'comment' : 'take';
  return A.tVote(id, kind);
}
function canDelete(owner) { return owner || db.isAdmin(A.me()); }
function delBtn(what, id, label) {
  var k = what + ':' + id, sure = S.sure === k;
  return '<button class="ghost del' + (sure ? ' sure' : '') + '" type="button" data-wkill="' + k + '">' + (sure ? 'Click again to delete' : (label || 'Delete')) + '</button>';
}
var sureT = 0;
function askOrDelete(k) {
  if (S.sure !== k) { S.sure = k; renderWall(); clearTimeout(sureT); sureT = setTimeout(function () { if (S.sure === k) { S.sure = null; renderWall(); } }, 4000); return; }
  S.sure = null;
  var i = k.indexOf(':'), id = k.slice(i + 1), p = R && postOf(R, id);
  if (!p) return;
  if (S.playing) stop();
  var job = p.isComment ? db.deleteThreadComment(id)
    : [p].concat(p.stems || []).reduce(function (pr, x) { return pr.then(function () { return db.deleteThreadTake(x.id, x.path, x.copy); }); }, Promise.resolve());
  job.then(A.refresh).then(function () { A.flash('Deleted. Replies to it stay in the thread.'); }).catch(function (e) { renderWall(); A.oops(e); });
}

/* ---------- rendering ---------- */
export function renderWall() {
  var box = el('wall'), st = A && A.S();
  if (!box || !st || !st.session || !st.seed) { if (box) box.innerHTML = ''; R = null; return; }
  R = build();
  var rid = R.id;
  S.expanded[rid] = true;
  /* the tile that is picked: the stack in the tracks above */
  var cur = st.wallSel && st.stack === st.wallStack ? st.wallSel : st.stack === '__seed' ? 'riff' : st.stack || st.trialPitch || null;
  if (cur && cur !== 'riff') { var cp = postFor(R, cur); cur = cp ? cp.id : null; }
  S.wsel[rid] = cur;
  /* the buffers the project already has (for the master track's waveform and the tiles) */
  load(R, { isRiff:true });
  R.posts.forEach(function (p) {
    if (p.isComment || p.deleted) return;
    stemsOf(p).forEach(function (x) { load(R, x); });
    (p.carry || []).forEach(function (x) { load(R, x); });
  });
  /* keep what's being typed */
  var keep = {}, focus = document.activeElement && document.activeElement.id;
  ['wsay-' + rid, 'wcrep-' + rid].forEach(function (id) { var t = el(id); if (t) keep[id] = t.value; });
  box.innerHTML = wallHtml(R);
  Object.keys(keep).forEach(function (id) { var t = el(id); if (t) { t.value = keep[id]; if (focus === id) t.focus(); } });
  wallScrolls();
  drawWaves();
}

/* ---------- clicks, comments ---------- */
document.addEventListener('click', function (e) {
  if (!R || !e.target.closest || !e.target.closest('#wall')) return;
  var b, rid = R.id;
  var cv = e.target.closest('canvas[data-wave]');
  if (cv && cv.closest('.wb') && cv.dataset.of && S.playing === cv.dataset.of && lenOf(cv)) {
    /* a soloed take: click its waveform to play it from there */
    var rc = cv.getBoundingClientRect();
    wallSolo(rid, null, Math.min(1, Math.max(0, (e.clientX - rc.left) / rc.width)) * lenOf(cv));
    return;
  }
  if ((b = e.target.closest('[data-wkill]'))) { askOrDelete(b.dataset.wkill); return; }
  if (e.target.closest('[data-tvote]')) return;   /* app.js casts the vote */
  if ((b = e.target.closest('[data-wfull]'))) {
    var fid = wallFullId(R, wallTree(R)); if (!fid) return;
    quietProject();
    S.wfull[rid] = fid; S.wsel[rid] = fid;
    wallSeek(rid, fid, 0);
    var fm = document.querySelector('#wall .wmaster'); if (fm) fm.scrollIntoView({ behavior:'smooth', block:'nearest' });
    return;
  }
  if ((b = e.target.closest('[data-wfullclose]'))) { if (S.playing && S.playing.indexOf(rid + ':wall:') === 0) stop(); delete S.wfull[rid]; renderWall(); return; }
  if ((b = e.target.closest('[data-wdot]'))) {
    var dw = document.querySelector('#wall .wwrap'), ds = dw && dw.querySelectorAll('.wsec')[+b.dataset.i];
    if (ds) dw.scrollTo({ left:dw.scrollLeft + ds.getBoundingClientRect().left - dw.getBoundingClientRect().left, behavior:'smooth' });
    return;
  }
  if ((b = e.target.closest('[data-wseek]'))) { var wr = b.getBoundingClientRect(); wallSeek(rid, b.dataset.post, (e.clientX - wr.left) / wr.width); return; }
  if ((b = e.target.closest('[data-wcreply]'))) {
    S.wcrep[rid] = S.wcrep[rid] === b.dataset.post ? null : b.dataset.post; renderWall();
    var ta = el('wcrep-' + rid); if (ta) ta.focus();
    return;
  }
  if ((b = e.target.closest('[data-wcrepx]'))) { S.wcrep[rid] = null; renderWall(); return; }
  if ((b = e.target.closest('[data-wtalkall]'))) { S.wtalk[rid] = true; renderWall(); return; }
  if ((b = e.target.closest('[data-wsolo]'))) { quietProject(); wallSolo(rid, b.dataset.post); return; }
  if ((b = e.target.closest('[data-wpick]'))) { wallPick(rid, b.dataset.post); return; }
  if ((b = e.target.closest('[data-wplus]'))) {
    /* + on a take: record on that stack in the grey track */
    var tile = b.closest('[data-post]');
    ghostOff();
    if (S.playing) stop();
    A.wallSwitch(tile ? tile.dataset.post : 'riff', false);
    A.wallRec(null);
    return;
  }
  if ((b = e.target.closest('[data-wtalk]'))) { S.wtalk[rid] = S.wtalk[rid] === false; renderWall(); return; }
  if ((b = e.target.closest('[data-wshow]'))) {
    wallPick(rid, b.dataset.post);
    var ww = document.querySelector('#wall .wwrap'); if (ww) ww.scrollIntoView({ behavior:'smooth', block:'center' });
    return;
  }
  if ((b = e.target.closest('[data-wsay]')) && !e.target.closest('[data-wpick]')) {
    S.wtalk[rid] = true; S.wsay[rid] = b.dataset.post; renderWall();
    var st = el('wsay-' + rid); if (st) { st.scrollIntoView({ behavior:'smooth', block:'center' }); st.focus({ preventScroll:true }); }
    return;
  }
  if ((b = e.target.closest('[data-wsel]'))) {
    /* a tile: its stack goes into the tracks above */
    var id = b.dataset.post, part = wallTree(R).partOf[id];
    if (S.playing) stop();
    delete S.wfull[rid]; S.wsel[rid] = id; if (!part) S.wcore[rid] = id;
    A.wallSwitch(id, false);
    return;
  }
});
document.addEventListener('change', function (e) {
  if (!R || !e.target.dataset || !e.target.dataset.wsaywhat) return;
  S.wsay[R.id] = e.target.value; renderWall();
  var t = el('wsay-' + R.id); if (t) t.focus();
});
document.addEventListener('submit', function (e) {
  var f = e.target.closest && e.target.closest('#wall [data-wcrepform], #wall [data-wsayform]'); if (!f || !R) return;
  e.preventDefault();
  var rid = R.id, reply = !!f.dataset.wcrepform, t = el((reply ? 'wcrep-' : 'wsay-') + rid), text = t ? t.value.trim() : '', go = f.querySelector('button[type=submit]');
  if (!text) { if (t) t.focus(); if (!reply) A.flash('Write something first.'); return; }
  var on = reply ? f.dataset.post : S.wsay[rid] || '', p = on && on !== 'riff' ? postOf(R, on) : null;
  if (go) go.disabled = true;
  A.need('reply').then(function () {
    var me = A.me();
    return db.addThreadComment({ session_id:rid, reply_to_take:p && !p.isComment ? p.id : null, reply_to_comment:p && p.isComment ? p.id : null,
      author_id:me.id, author_name:db.accountName(me), body:text });
  }).then(function () {
    if (t) t.value = '';
    if (reply) S.wcrep[rid] = null; else { S.wsay[rid] = ''; delete S.wtalk[rid]; }
    return A.refresh();
  }).then(function () { A.flash(reply ? 'Your reply is posted.' : 'Your comment is posted.'); })
    .catch(function (err) { if (go) go.disabled = false; A.flash((err && err.message) || 'That didn’t work, try again.'); });
});
window.addEventListener('resize', function () { if (R) drawWaves(); });
document.addEventListener('stackato:theme', function () { if (R) drawWaves(); });

/* app.js hands over its state and audio: getters, since its state object is replaced on a new session */
export function initProjectWall(app) {
  A = app;
  initWall({ S:S, BUF:BUF, esc:esc, lay:lay, mmss:mmss, ava:ava, lyr:lyr, nameOf:app.nameOf, riffMeta:riffMeta, voteHtml:voteHtml, canDelete:canDelete, delBtn:delBtn,
    riff:riff, postOf:postOf, stemsOf:stemsOf, chainOf:chainOf, chipLabel:chipLabel, bufKey:bufKey,
    ac:ac, load:load, playList:playList, playSeq:playSeq, playPos:playPos, stop:stop, render:renderWall, drawWaves:drawWaves,
    project:true, pick:function (id, playIt) { A.wallSwitch(id, playIt); },
    /* the tracks above play this stack, all at once */
    tracksOn:function (id) { return A.running() && A.S().wallSel === id; }, stopTracks:function () { A.stopAll(true); } });
}

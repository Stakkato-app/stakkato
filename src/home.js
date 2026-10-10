/* The homepage (/): a feed of jams with their threads.

   A jam is a session with an original track. Its thread holds the audio replies (takes;
   takes.reply_to says which take a reply was played on top of) and the written replies
   (thread_comments), and anyone can up- or downvote the jam, a take or a comment
   (thread_votes). Reading needs no sign-in. The first write (a comment, a vote, a take,
   a new jam) signs the visitor in anonymously, like the song view does; an account is
   optional. Playing a take plays it with everything above it in its thread.

   The markup is built from strings like in app.js; render() redraws the whole list. */

import './theme.js';
import { configured } from './supabase.js';
import * as db from './data.js';
import { analyse, sureness } from './analysis.js';
import { ROLES, role } from './roles.js';
import { ico } from './icons.js';

var NAME_KEY = 'riffraff:name';    /* shared with the song view */
var TOL = 0.6;                     /* seconds a take may differ from what it plays on (as in app.js) */

var LAYERS = { seed:{ label:'original track', c:'var(--ember)' }, part:{ label:'new part', c:'var(--cyan)' } };
ROLES.forEach(function (r) { LAYERS[r.id] = { label:r.label.toLowerCase(), c:'var(' + r.color + ')' }; });
function lay(id) { return LAYERS[id] || LAYERS.wild; }

var RIFFS = [];
var S = { tab:'fresh', expanded:{}, fold:{}, vote:{}, playing:null, cmt:{ at:null, text:'', name:'' }, loaded:false, failed:null, sure:null };
var KIND = {};                     /* target id -> { kind, sid } for votes */
var me = null;                     /* the signed-in Supabase user (anonymous or an account), or null */
var AC = null, BUF = {}, SRC = [];

function el(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function savedName() { try { return localStorage.getItem(NAME_KEY) || ''; } catch (e) { return ''; } }
function rememberName(n) { try { if (n) localStorage.setItem(NAME_KEY, n); } catch (e) {} }
function myName() { return db.accountName(me) || savedName(); }
function extOf(name) { return (name && name.indexOf('.') > -1) ? name.split('.').pop().toLowerCase() : 'wav'; }
function typeFor(file) {
  if (file.type) return file.type;
  var map = { wav:'audio/wav', mp3:'audio/mpeg', m4a:'audio/mp4', aac:'audio/aac', ogg:'audio/ogg', flac:'audio/flac', aif:'audio/aiff', aiff:'audio/aiff', webm:'audio/webm' };
  return map[extOf(file.name)] || 'audio/wav';
}
function ago(iso) {
  var m = Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return Math.round(m) + ' minute' + (Math.round(m) > 1 ? 's' : '') + ' ago';
  var h = m / 60; if (h < 24) return Math.round(h) + ' hour' + (Math.round(h) > 1 ? 's' : '') + ' ago';
  var d = h / 24; if (d < 2) return 'yesterday';
  if (d < 7) return Math.round(d) + ' days ago';
  if (d < 14) return 'last week';
  return new Date(iso).toLocaleDateString(undefined, { day:'numeric', month:'short' });
}
function mmss(t) { t = Math.max(0, t || 0); return Math.floor(t / 60) + ':' + ('0' + Math.floor(t % 60)).slice(-2); }
var toastT = 0;
function toast(m) { var t = el('toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('on'); }, 4500); }
function oops(e) { console.error(e); toast((e && e.message) || 'Something went wrong. Try again.'); }

/* sign in anonymously on the first write, so reading the feed creates no users */
function ensureMe() {
  if (me) return Promise.resolve(me);
  return db.ensureUser().then(function (u) { me = u; return u; });
}

/* ---------- data -> the feed ---------- */
function build(feed) {
  var votes = {}, mine = {};
  KIND = {};
  feed.votes.forEach(function (v) {
    if (me && v.voter_id === me.id) mine[v.target_id] = v.value;
    else votes[v.target_id] = (votes[v.target_id] || 0) + v.value;
  });
  S.vote = mine;
  RIFFS = feed.sessions.map(function (s) {
    var tk = feed.takes.filter(function (t) { return t.session_id === s.id; });
    var seed = tk.filter(function (t) { return t.id === s.seed_take_id; })[0];
    if (!seed) return null;
    var title = s.title && s.title !== 'Untitled' ? s.title : seed.author_name + '’s track';
    var posts = [], mix = null;
    KIND[s.id] = { kind:'session', sid:s.id };
    tk.forEach(function (t) {
      if (t.id === s.seed_take_id || t.role_id === 'seed') return;
      if (t.role_id === 'mix') { if (t.status === 'mix') mix = { by:t.author_name, url:db.publicUrl(t.storage_path) }; return; }
      if (t.status === 'own') return;   /* own takes only live in someone's version */
      if (t.status === 'deleted') {
        /* a deleted take stays as an empty spot, so the replies played on it keep their place */
        if (t.role_id !== 'part') posts.push({ id:t.id, parent:t.reply_to || t.section_id || null, deleted:true, created:t.created_at, likes:0 });
        return;
      }
      var base = { id:t.id, by:t.author_name, mine:!!(me && t.author_id === me.id), time:ago(t.created_at), created:t.created_at,
        text:t.note, url:db.publicUrl(t.storage_path), path:t.storage_path, dur:t.duration_sec, likes:votes[t.id] || 0, status:t.status };
      KIND[t.id] = { kind:'take', sid:s.id };
      if (t.role_id === 'part') {
        if (t.status !== 'in' && t.status !== 'waiting') return;
        posts.push(Object.assign(base, { parent:null, kind:'part', layer:'part', pos:t.part_pos }));
        return;
      }
      posts.push(Object.assign(base, { parent:t.reply_to || t.section_id || null, section:t.section_id || null, group:t.group_id || null,
        layer:LAYERS[t.role_id] ? t.role_id : 'wild', inSong:t.status === 'in' && !t.section_id }));
    });
    feed.comments.filter(function (c) { return c.session_id === s.id; }).forEach(function (c) {
      KIND[c.id] = { kind:'comment', sid:s.id };
      if (c.deleted_at) { posts.push({ id:c.id, parent:c.reply_to_take || c.reply_to_comment || null, deleted:true, isComment:true, created:c.created_at, likes:0 }); return; }
      posts.push({ id:c.id, parent:c.reply_to_take || c.reply_to_comment || null, by:c.author_name, mine:!!(me && c.author_id === me.id),
        time:ago(c.created_at), created:c.created_at, text:c.body, likes:votes[c.id] || 0, isComment:true });
    });
    /* takes sent together as one reply: the first is the post, the others play as its stems */
    var groups = {};
    posts = posts.filter(function (p) {
      var g = p.group; if (!g || p.deleted) return true;
      if (!groups[g]) { groups[g] = p; p.stems = []; return true; }
      groups[g].stems.push({ id:p.id, by:p.by, mine:p.mine, layer:p.layer, url:p.url, path:p.path, dur:p.dur }); return false;
    });
    posts.sort(function (a, b) { return String(a.created).localeCompare(String(b.created)); });
    /* a reply on something the feed leaves out (a deleted take) moves up to the jam */
    var ids = {}; posts.forEach(function (p) { ids[p.id] = 1; });
    posts.forEach(function (p) { if (p.parent && !ids[p.parent]) p.parent = null; });
    /* deleted posts nobody replied to disappear; the ones with replies stay as a placeholder */
    for (var again = true; again;) {
      again = false;
      posts = posts.filter(function (p) {
        if (!p.deleted || posts.some(function (k) { return k.parent === p.id; })) return true;
        again = true; return false;
      });
    }
    var r = { id:s.id, slug:s.slug, by:seed.author_name, title:title, bpm:s.bpm, key:s.music_key || '', sig:s.time_sig && s.time_sig !== '4/4' ? s.time_sig : '',
      time:ago(s.created_at), text:seed.note, layer:LAYERS[s.seed_role] ? s.seed_role : 'seed', url:db.publicUrl(seed.storage_path), dur:seed.duration_sec,
      likes:votes[s.id] || 0, host:!!(me && s.host_id === me.id), open:s.status === 'open', mix:mix, posts:posts };
    if (s.status === 'released') r.song = { name:title, musicians:players(r).length + 1 };
    return r;
  }).filter(Boolean);
}
/* coming back from the song view: /?open=<jam id>&tid=<take id> opens that thread at that take */
var LANDING = (function () { try { var q = new URLSearchParams(location.search); return q.get('open') ? { open:q.get('open'), tid:q.get('tid') } : null; } catch (e) { return null; } })();
function land() {
  var r = LANDING && riff(LANDING.open); if (!r) { LANDING = null; return; }
  var hit = LANDING.tid ? postOf(r, LANDING.tid) || r.posts.filter(function (p) { return (p.stems || []).some(function (x) { return x.id === LANDING.tid; }); })[0] : null;
  LANDING = null;
  S.expanded[r.id] = true; if (hit) openTo(r, hit);
  render();
  setTimeout(function () {
    var n = hit ? el('post-' + r.id + '-' + hit.id) : el('riff-' + r.id);
    if (n) { n.scrollIntoView({ block: hit ? 'center' : 'start' }); if (hit) n.classList.add('hl'); }
  }, 60);
}
function reload() {
  if (!configured) { S.failed = 'Supabase is not configured. Copy .env.example to .env.local and fill it in.'; render(); return Promise.resolve(); }
  return db.loadFeed(20).then(function (feed) { build(feed); S.loaded = true; S.failed = null; render(); if (LANDING) land(); })
    .catch(function (e) { console.error(e); S.failed = 'The jams could not be loaded. Check your connection and reload the page.'; render(); });
}

/* ---------- votes: the score is everyone else's votes plus yours ---------- */
function score(base, k) { return base + (S.vote[k] || 0); }
function voteHtml(k, base) {
  var v = S.vote[k] || 0;
  return '<span class="vote" role="group" aria-label="Vote">' +
    '<button type="button" class="up" data-vote="' + k + '" data-dir="1" aria-pressed="' + (v === 1) + '" aria-label="Upvote">&#9650;</button>' +
    '<b>' + score(base, k) + '</b>' +
    '<button type="button" class="down" data-vote="' + k + '" data-dir="-1" aria-pressed="' + (v === -1) + '" aria-label="Downvote">&#9660;</button></span>';
}
function vote(k, dir) {
  var t = KIND[k]; if (!t) return;
  var before = S.vote[k] || 0, value = before === dir ? 0 : dir;
  S.vote[k] = value; render();
  ensureMe().then(function (u) {
    return db.voteInThread({ targetId:k, targetKind:t.kind, sessionId:t.sid, voterId:u.id, value:value });
  }).catch(function (e) { S.vote[k] = before; render(); oops(e); });
}

/* ---------- comments: reply with words only, no account needed ---------- */
function commentBtn(r, pid, label) {
  return '<button class="ghost" type="button" data-comment="' + r.id + '" data-post="' + (pid || '') + '">' + (label || 'Comment') + '</button>';
}
function commentForm(r, pid) {
  if (S.cmt.at !== key(r, pid)) return '';
  var p = pid ? postOf(r, pid) : null, to = !p ? r.by : p.mine ? 'yourself' : p.by, acct = db.accountName(me);
  var who = acct ? '<span class="cnote">Posting as <b>' + esc(acct) + '</b></span>'
    : '<input type="text" id="c-name" maxlength="60" placeholder="Your name (optional)" aria-label="Your name (optional)" value="' + esc(S.cmt.name) + '">';
  return '<form class="cbox" id="c-form" data-cform="' + key(r, pid) + '">' +
    '<textarea id="c-text" maxlength="500" placeholder="Say something to ' + esc(to) + '" aria-label="Your comment">' + esc(S.cmt.text) + '</textarea>' +
    '<div class="crow">' + who + '<span class="grow"></span>' +
      '<button class="btn btn-sm" type="button" data-ccancel="1">Cancel</button><button class="btn btn-sm btn-ember" type="submit" id="c-go">Post comment</button></div>' +
    '<p class="err" id="c-err"></p>' +
    (acct ? '' : '<span class="cnote">No account needed. Leave your name empty to post as Guest.</span>') + '</form>';
}
function openComment(rid, pid) {
  var r = riff(rid), k = key(r, pid || null);
  if (S.cmt.at === k) { S.cmt.at = null; render(); return; }
  S.cmt = { at:k, text:'', name:S.cmt.name || savedName() };
  if (pid) { S.expanded[rid] = true; openTo(r, postOf(r, pid)); }
  render();
  var t = el('c-text'); if (t) t.focus();
}
function postComment() {
  var text = el('c-text').value.trim();
  if (!text) { el('c-err').textContent = 'Write something first.'; el('c-text').focus(); return; }
  var parts = S.cmt.at.split(':'), r = riff(parts[0]), pid = parts[1] === 'riff' ? null : parts[1], p = pid ? postOf(r, pid) : null;
  var name = (db.accountName(me) || S.cmt.name.trim() || 'Guest').slice(0, 60);
  el('c-go').disabled = true;
  ensureMe().then(function (u) {
    if (!db.accountName(u) && S.cmt.name.trim()) rememberName(S.cmt.name.trim());
    return db.addThreadComment({ session_id:r.id, reply_to_take:p && !p.isComment ? p.id : null, reply_to_comment:p && p.isComment ? p.id : null,
      author_id:u.id, author_name:name, body:text });
  }).then(function (row) {
    S.cmt = { at:null, text:'', name:S.cmt.name };
    S.expanded[r.id] = true; if (pid) S.fold[r.id + ':' + pid] = true;
    return reload().then(function () {
      var n = el('post-' + r.id + '-' + row.id); if (n) { n.scrollIntoView({ behavior:'smooth', block:'center' }); n.classList.add('hl'); }
      toast('Your comment is posted.');
    });
  }).catch(function (e) { if (el('c-go')) el('c-go').disabled = false; if (el('c-err')) el('c-err').textContent = (e && e.message) || 'That didn’t work, try again.'; });
}
document.addEventListener('input', function (e) {
  if (e.target.id === 'c-text') S.cmt.text = e.target.value;
  if (e.target.id === 'c-name') S.cmt.name = e.target.value;
});
document.addEventListener('submit', function (e) { if (e.target.id === 'c-form') { e.preventDefault(); postComment(); } });
document.addEventListener('keydown', function (e) {
  if (e.target.id === 'c-text' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); postComment(); }
});

/* ---------- deleting: your own things, or anyone's as admin; two clicks ---------- */
function canDelete(owner) { return owner || db.isAdmin(me); }
function delBtn(what, id, label) {
  var k = what + ':' + id, sure = S.sure === k;
  return '<button class="ghost del' + (sure ? ' sure' : '') + '" type="button" data-del="' + k + '">' + (sure ? 'Click again to delete' : (label || 'Delete')) + '</button>';
}
var sureT = 0;
function askOrDelete(k) {
  if (S.sure !== k) { S.sure = k; render(); clearTimeout(sureT); sureT = setTimeout(function () { if (S.sure === k) { S.sure = null; render(); } }, 4000); return; }
  S.sure = null;
  var i = k.indexOf(':'), what = k.slice(0, i), id = k.slice(i + 1), job;
  if (what === 'jam') job = db.deleteJam(id);
  else {
    var r = RIFFS.filter(function (x) { return postOf(x, id); })[0], p = r && postOf(r, id);
    if (!p) return;
    if (S.playing && S.playing.indexOf(r.id) === 0) stop();
    job = p.isComment ? db.deleteThreadComment(id)
      : [p].concat(p.stems || []).reduce(function (pr, x) { return pr.then(function () { return db.deleteThreadTake(x.id, x.path); }); }, Promise.resolve());
  }
  job.then(reload).then(function () {
    toast(what === 'jam' ? 'The jam is deleted.' : 'Deleted. Replies to it stay in the thread.');
  }).catch(function (e) { render(); oops(e); });
}

/* ---------- the thread ---------- */
function mixLink(label, r, tid) {
  return '<a class="ghost mixlink" href="/s/' + encodeURIComponent(r.slug) + (tid ? '?stack=' + encodeURIComponent(tid) : '') + '">' + label + '</a>';
}
function songOf(r) { return r.posts.filter(function (p) { return p.inSong; }); }
function riff(id) { return RIFFS.filter(function (r) { return r.id === id; })[0]; }
function postOf(r, id) { return r.posts.filter(function (p) { return p.id === id; })[0]; }
function kids(r, id) { return r.posts.filter(function (p) { return p.parent === id; }); }
function audioPosts(r) { return r.posts.filter(function (p) { return p.layer && p.kind !== 'part'; }); }
function livePosts(r) { return r.posts.filter(function (p) { return !p.deleted; }); }
function players(r) { var seen = {}; return audioPosts(r).filter(function (p) { if (seen[p.by]) return false; seen[p.by] = 1; return true; }); }
function key(r, pid) { return r.id + ':' + (pid || 'riff'); }
function whose(p) { return p.mine ? 'your' : p.by + '’s'; }
/* the original track (or the new part a take sits on) plus every take from the top of the thread down to this one */
function stemsOf(p) { return [p].concat((p.stems || []).map(function (x) { return Object.assign({}, x, { id:p.id + '~' + x.id, dbId:x.id }); })); }
function chainOf(r, pid) {
  var out = [];
  for (var p = pid ? postOf(r, pid) : null; p; p = p.parent ? postOf(r, p.parent) : null) {
    if (p.kind === 'part') return [{ id:p.id, by:p.by, mine:p.mine, layer:'part', url:p.url, dur:p.dur, isPart:true }].concat(out);
    if (p.layer) out = stemsOf(p).concat(out);
  }
  return [{ id:'riff', by:r.by, layer:r.layer, url:r.url, dur:r.dur, isRiff:true, mine:r.host }].concat(out);
}
function bufKey(r, p) { return p.isRiff ? r.id + ':riff' : r.id + ':' + p.id; }
function chipLabel(p) { return p.isRiff ? 'clip' : p.isPart ? 'new part' : lay(p.layer).label; }
function chainChips(r, c) { return c.map(function (p) { return '<span class="chip"><span class="dot" style="background:' + lay(p.layer).c + '"></span>' + esc(whose(p)) + ' ' + chipLabel(p) + '</span>'; }).join(''); }

/* ---------- audio ---------- */
function ac() { if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)(); return AC; }
function load(r, p) {
  var k = bufKey(r, p);
  if (BUF[k] || BUF[k + ':loading'] || !p.url) return Promise.resolve();
  BUF[k + ':loading'] = true;
  return fetch(p.url).then(function (x) { if (!x.ok) throw new Error(x.status); return x.arrayBuffer(); })
    .then(function (ab) { return ac().decodeAudioData(ab); })
    .then(function (b) { BUF[k] = b; drawWaves(); })
    .catch(function (e) { console.warn('Could not load audio', p.url, e); });
}
function stop() { SRC.forEach(function (s) { try { s.stop(); } catch (e) {} }); SRC = []; S.playing = null; CLOCK = null; }
/* CLOCK: when the loop that is playing started and how long it is, for the playhead */
var CLOCK = null;
/* play a list of takes together, looped; `at` (seconds) starts somewhere in the middle.
   Playing what already plays stops it, unless `at` is given: then it jumps there. */
function playList(k, r, c, at) {
  var seek = typeof at === 'number';
  if (S.playing === k && !seek) { stop(); render(); return; }
  var was = S.playing;
  SRC.forEach(function (s) { try { s.stop(); } catch (e) {} }); SRC = []; CLOCK = null;
  S.playing = k; if (was !== k) render();
  Promise.all(c.map(function (p) { return load(r, p); })).then(function () {
    if (S.playing !== k) return;
    var a = ac(); a.resume(); var T = a.currentTime + 0.05, len = 0;
    c.forEach(function (p) { var b = BUF[bufKey(r, p)]; if (b) len = Math.max(len, b.duration); });
    var from = seek ? ((at % len) + len) % len : 0;
    c.forEach(function (p) {
      var b = BUF[bufKey(r, p)]; if (!b) return;
      var s = a.createBufferSource(); s.buffer = b; s.loop = true; s.connect(a.destination);
      s.start(T, from % b.duration); SRC.push(s);
    });
    CLOCK = { k:k, t0:T - from, len:len };
    tickHeads();
  });
}
function play(rid, pid, at) { var r = riff(rid); playList(key(r, pid), r, chainOf(r, pid), at); }
function playSong(rid) { var r = riff(rid); playList(rid + ':song', r, chainOf(r, null).concat(songOf(r))); }
function playMix(rid) { var r = riff(rid); playList(rid + ':mix', r, [{ id:'mix', url:r.mix.url }]); }

/* ---------- seeking: click anywhere in a waveform to play from there ---------- */
function headOf(cv, cls) {
  var box = cv.parentNode, h = box.querySelector(':scope > .' + cls + '[data-for="' + cv.dataset.wave + '"]');
  if (!h) { h = document.createElement('span'); h.className = cls; h.dataset.for = cv.dataset.wave; h.setAttribute('aria-hidden', 'true'); box.appendChild(h); }
  h.style.top = cv.offsetTop + 'px'; h.style.height = cv.offsetHeight + 'px';
  return h;
}
var headRaf = 0;
function tickHeads() {
  cancelAnimationFrame(headRaf);
  [].forEach.call(document.querySelectorAll('.phead'), function (h) { h.hidden = true; });
  if (!CLOCK || S.playing !== CLOCK.k) return;
  var pos = ((ac().currentTime - CLOCK.t0) % CLOCK.len + CLOCK.len) % CLOCK.len, f = CLOCK.len ? pos / CLOCK.len : 0;
  [].forEach.call(document.querySelectorAll('canvas[data-wave]'), function (cv) {
    if (S.playing !== cv.dataset.wave && S.playing !== cv.dataset.of) return;
    var h = headOf(cv, 'phead'); h.hidden = false; h.style.left = (cv.offsetLeft + cv.offsetWidth * f) + 'px';
  });
  headRaf = requestAnimationFrame(tickHeads);
}
function seekTarget(cv) {
  var w = cv.dataset.wave, i = w.indexOf(':'), rid = w.slice(0, i), pid = w.slice(i + 1);
  var r = riff(rid); if (!r) return null;
  if (pid === 'riff') return { r:r, pid:null };
  var p = postOf(r, pid) || postOf(r, pid.split('~')[0]);   /* a stem of a grouped reply plays its reply */
  return p ? { r:r, pid:p.id } : null;
}
function lenOf(cv) { var b = BUF[cv.dataset.wave]; return b ? b.duration : 0; }
document.addEventListener('mousemove', function (e) {
  var cv = e.target.closest && e.target.closest('canvas[data-wave]');
  [].forEach.call(document.querySelectorAll('.shead'), function (h) { if (!cv || h.dataset.for !== cv.dataset.wave) h.hidden = true; });
  if (!cv || !lenOf(cv)) return;
  var rect = cv.getBoundingClientRect(), f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  var h = headOf(cv, 'shead'); h.hidden = false; h.style.left = (cv.offsetLeft + cv.offsetWidth * f) + 'px';
  h.dataset.t = mmss(f * lenOf(cv));
});
document.addEventListener('mouseleave', function () { [].forEach.call(document.querySelectorAll('.shead'), function (h) { h.hidden = true; }); }, true);
document.addEventListener('click', function (e) {
  var cv = e.target.closest && e.target.closest('canvas[data-wave]'); if (!cv || !lenOf(cv)) return;
  var t = seekTarget(cv); if (!t) return;
  var rect = cv.getBoundingClientRect(), f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  play(t.r.id, t.pid, f * lenOf(cv));
});
/* a real waveform: the highest and lowest sample in every pixel column, drawn as one shape */
function waveShape(cv, buf, color) {
  var w = cv.clientWidth, h = cv.clientHeight, dpr = window.devicePixelRatio || 1;
  if (!w || !h) return;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  var g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  g.fillStyle = color;
  var mid = h / 2;
  if (!buf) { g.globalAlpha = .35; g.fillRect(0, mid - 1, w, 2); return; }
  var d = buf.getChannelData(0), cols = Math.max(1, Math.floor(w)), step = d.length / cols, hi = [], lo = [], peak = 0, x, i;
  for (x = 0; x < cols; x++) {
    var a = Math.floor(x * step), z = Math.min(d.length, Math.floor((x + 1) * step)), mx = 0, mn = 0;
    for (i = a; i < z; i++) { var v = d[i]; if (v > mx) mx = v; else if (v < mn) mn = v; }
    hi.push(mx); lo.push(mn); peak = Math.max(peak, mx, -mn);
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
  [].forEach.call(document.querySelectorAll('canvas[data-wave]'), function (cv) {
    var lit = S.playing && (S.playing === cv.dataset.wave || S.playing === cv.dataset.of);
    waveShape(cv, BUF[cv.dataset.wave], css.getPropertyValue(lit ? '--ink' : '--wave').trim());
  });
}

/* ---------- rendering ---------- */
function lyr(layer) { return '<b class="lyr" style="color:' + lay(layer).c + '">' + lay(layer).label + '</b>'; }
function ava(name, layer, sm) { return '<span class="ava' + (sm ? ' sm' : '') + '" style="background:' + (layer ? lay(layer).c : 'var(--muted)') + '">' + esc(String(name).charAt(0).toUpperCase()) + '</span>'; }
/* folding: every level of replies opens and closes on its own */
function folded(k) { return !S.fold[k]; }
function countDesc(r, id) { return kids(r, id).reduce(function (n, k) { return n + 1 + countDesc(r, k.id); }, 0); }
function foldBtn(r, id) {
  var n = countDesc(r, id), k = r.id + ':' + id;
  return '<button class="fold' + (folded(k) ? '' : ' open') + '" type="button" data-fold="' + k + '" aria-expanded="' + !folded(k) + '">' + (folded(k) ? '&#9656; Show ' + n + (n > 1 ? ' replies' : ' reply') : '&#9662; Hide replies') + '</button>';
}
function kidsHtml(r, p, depth) {
  var ks = kids(r, p.id);
  if (!ks.length) return '';
  return foldBtn(r, p.id) + (folded(r.id + ':' + p.id) ? '' : '<div class="kids">' + ks.map(function (k) { return replyHtml(r, k, depth + 1); }).join('') + '</div>');
}
/* open every level above a post, so a link can land on it */
function openTo(r, p) {
  var x = p;
  while (x && x.parent) { S.fold[r.id + ':' + x.parent] = true; x = postOf(r, x.parent); }
}
function partHtml(r, p, depth) {
  var on = S.playing === key(r, p.id), kept = p.status === 'in';
  var html = '<div class="rep upd" id="post-' + r.id + '-' + p.id + '">' + ava(p.mine ? 'You' : p.by, null, true) +
    '<div class="rbody"><div class="rmeta"><b>' + esc(p.mine ? 'You' : p.by) + '</b> <span class="act">' + (kept ? 'extended the jam' : 'pitched a new part') + '</span>' +
      '<span class="time">' + esc(p.time) + '</span></div>' +
    (p.text ? '<p class="rtext">' + esc(p.text) + '</p>' : '') +
    '<div class="ra' + (on ? ' on' : '') + '"><button class="play' + (on ? ' on' : '') + '" type="button" data-play="' + r.id + '" data-post="' + p.id + '" aria-label="Play the new part">' + (on ? '&#10074;&#10074;' : '&#9654;') + '</button>' +
      '<canvas data-wave="' + r.id + ':' + p.id + '" data-layer="part"></canvas><div class="with">plays ' + (p.pos === 'before' ? 'before' : 'after') + ' the original clip</div></div>' +
    '<div class="rsub">' + (r.open && kept ? '<button class="ghost ember" type="button" data-reply="' + r.id + '" data-post="' + p.id + '">+ Play on the new part</button>' : '') +
      mixLink('Open in mix view', r, p.id) + commentBtn(r, p.id) + voteHtml(p.id, p.likes) + '</div>' + commentForm(r, p.id) + '</div></div>';
  return html + kidsHtml(r, p, depth);
}
function goneHtml(r, p, depth) {
  return '<div class="rep gone" id="post-' + r.id + '-' + p.id + '"><span class="ava sm" style="background:var(--line)"></span>' +
    '<div class="rbody"><p class="rtext muted">' + (p.isComment ? 'This comment was deleted.' : 'This take was deleted. The replies played on it stay.') + '</p></div></div>' + kidsHtml(r, p, depth);
}
function replyHtml(r, p, depth) {
  if (p.deleted) return goneHtml(r, p, depth);
  if (p.kind === 'part') return partHtml(r, p, depth);
  var on = S.playing === key(r, p.id);
  var html = '<div class="rep" id="post-' + r.id + '-' + p.id + '">' + ava(p.mine ? 'You' : p.by, p.layer, true) +
    '<div class="rbody"><div class="rmeta"><b>' + esc(p.mine ? 'You' : p.by) + '</b> <span class="act">' + (p.layer ? 'added ' + stemsOf(p).map(function (x) { return lyr(x.layer); }).join(' + ') : 'replied') + '</span>' +
      (p.inSong ? '<span class="songtag">In the song</span>' : '') + '<span class="time">' + esc(p.time) + '</span></div>' +
    (p.text ? '<p class="rtext">' + esc(p.text) + '</p>' : '') +
    (p.layer ? '<div class="ra' + (on ? ' on' : '') + '"><button class="play' + (on ? ' on' : '') + '" type="button" data-play="' + r.id + '" data-post="' + p.id + '" aria-label="' + (on ? 'Stop' : 'Play with everything above it') + '">' + (on ? '&#10074;&#10074;' : '&#9654;') + '</button>' +
      (p.stems && p.stems.length ? '<div class="mixlanes">' + stemsOf(p).map(function (x) { return '<canvas data-wave="' + r.id + ':' + x.id + '" data-of="' + key(r, p.id) + '" data-layer="' + x.layer + '"></canvas>'; }).join('') + '</div>'
        : '<canvas data-wave="' + r.id + ':' + p.id + '" data-of="' + key(r, p.id) + '" data-layer="' + p.layer + '"></canvas>') +
      '<div class="with">on top of ' + chainChips(r, chainOf(r, p.id).slice(0, -stemsOf(p).length)) + '</div></div>' : '') +
    '<div class="rsub">' + (p.layer && r.open ? '<button class="ghost ember" type="button" data-reply="' + r.id + '" data-post="' + p.id + '">+ Reply with audio</button>' : '') +
      (p.layer && r.host && r.open && p.status === 'waiting' && !p.section ? '<button class="ghost song-pick" type="button" data-letin="' + p.id + '">&#9734; Add to song</button>' : '') +
      (p.layer ? mixLink('Open in mix view', r, p.id) : '') + commentBtn(r, p.id, p.layer ? 'Comment' : 'Reply') +
      (canDelete(p.mine) ? delBtn(p.isComment ? 'comment' : 'take', p.id) : '') + voteHtml(p.id, p.likes) + '</div>' + commentForm(r, p.id) + '</div></div>';
  return html + kidsHtml(r, p, depth);
}
/* The thread bar: the way into a jam's replies, across the bottom of the card. It shows who
   replied, what kind of replies there are and the latest one, so it reads as "there's a
   conversation here" rather than a small link. */
function threadBar(r, open) {
  var live = livePosts(r), n = live.length;
  if (!r.posts.length) return '';
  var takes = live.filter(function (p) { return p.layer && p.kind !== 'part'; }).length, parts = live.filter(function (p) { return p.kind === 'part'; }).length;
  var words = n - takes - parts, seen = {}, faces = [];
  live.forEach(function (p) { var who = p.mine ? 'You' : p.by; if (!seen[who]) { seen[who] = 1; faces.push(ava(who, p.layer && p.kind !== 'part' ? p.layer : null, true)); } });
  var last = live.slice().sort(function (a, b) { return String(b.created).localeCompare(String(a.created)); })[0];
  var what = [takes ? takes + (takes > 1 ? ' takes' : ' take') : '', parts ? parts + (parts > 1 ? ' new parts' : ' new part') : '', words ? words + (words > 1 ? ' comments' : ' comment') : ''].filter(Boolean).join(', ');
  var lastTxt = last ? (last.mine ? 'You' : last.by) + (last.layer && last.kind !== 'part' ? ' added ' + lay(last.layer).label : last.kind === 'part' ? ' added a new part' : ': “' + (last.text.length > 60 ? last.text.slice(0, 57) + '…' : last.text) + '”') + ', ' + last.time : '';
  return '<button class="threadbar' + (open ? ' open' : '') + '" type="button" data-expand="' + r.id + '" aria-expanded="' + open + '" aria-controls="replies-' + r.id + '">' +
    (faces.length ? '<span class="faces">' + faces.slice(0, 4).join('') + '</span>' : '') +
    '<span class="tb-txt"><b>' + (n ? n + (n > 1 ? ' replies' : ' reply') : 'Replies') + '</b>' + (what ? ' · ' + what : '') +
      (lastTxt && !open ? '<small>Latest: ' + esc(lastTxt) + '</small>' : '') + '</span>' +
    '<span class="tb-go">' + (open ? 'Hide the thread <i aria-hidden="true">&#9652;</i>' : 'Show the thread <i aria-hidden="true">&#9662;</i>') + '</span></button>';
}
function riffHtml(r) {
  var on = S.playing === key(r), ps = players(r), n = livePosts(r).length, open = !!S.expanded[r.id], song = songOf(r);
  var top = r.posts.filter(function (p) { return !p.parent; });
  var html = '<article class="riff' + (r.host ? ' mine' : '') + (open && n ? ' wide-open' : '') + '" id="riff-' + r.id + '">' +
    '<div class="rhead">' + ava(r.by, r.layer) + '<div class="rwho"><b>' + esc(r.by) + (r.host ? ' (you)' : '') + '</b> started a jam' + (r.layer !== 'seed' ? ' · ' + lyr(r.layer) : '') +
      '<small>' + esc(r.time) + (r.bpm ? ' · ' + r.bpm + ' bpm' : '') + (r.key ? ' · ' + esc(r.key) : '') + (r.sig ? ' · ' + esc(r.sig) : '') + '</small></div></div>' +
    '<div class="rtitle"><h2>' + esc(r.title) + (r.song ? '<span class="tag">Became a song</span>' : '') + '</h2>' + (r.text ? '<p>' + esc(r.text) + '</p>' : '') + '</div>' +
    '<div class="player"><button class="play big' + (on ? ' on' : '') + '" type="button" data-play="' + r.id + '" aria-label="' + (on ? 'Stop' : 'Play the clip') + '">' + (on ? '&#10074;&#10074;' : '&#9654;') + '</button>' +
      '<canvas data-wave="' + r.id + ':riff" data-layer="' + r.layer + '"></canvas></div>' +
    '<div class="stats">' + (ps.length ? '<span class="faces">' + ps.slice(0, 5).map(function (p) { return ava(p.mine ? 'You' : p.by, p.layer, true); }).join('') + '</span>' +
      '<span>' + ps.length + ' musician' + (ps.length > 1 ? 's' : '') + ' played along</span>' +
      (song.length ? '<button class="ghost songplay" type="button" data-playsong="' + r.id + '">' + (S.playing === r.id + ':song' ? '&#10074;&#10074; ' : '&#9654; ') + 'The song · ' + song.length + (song.length > 1 ? ' takes' : ' take') + '</button>' : '')
      : '<span>Nobody played along yet. Be the first.</span>') + '</div>' +
    '<div class="racts">' + (r.open ? '<button class="btn btn-sm btn-ember" type="button" data-reply="' + r.id + '">+ Play along</button>' : '') +
      mixLink('Open in mix view', r, null) + commentBtn(r, null) + (canDelete(r.host) ? delBtn('jam', r.id, 'Delete jam') : '') +
      '<span class="grow"></span>' + voteHtml(r.id, r.likes) + '</div>' + commentForm(r, null);
  if (r.song) html += '<div class="became"><p><b>' + esc(r.song.name) + '</b>Released. ' + r.song.musicians + ' musician' + (r.song.musicians > 1 ? 's are' : ' is') + ' on the song.' + (r.mix ? ' ' + esc(r.mix.by) + ' uploaded the mix.' : '') + '</p>' +
    (r.mix ? '<button class="btn btn-sm btn-ember" type="button" data-playmix="' + r.id + '">' + (S.playing === r.id + ':mix' ? '&#10074;&#10074; Stop' : '&#9654; Play the mix') + '</button>' : '') + '</div>';
  html += threadBar(r, open);
  if (open && r.posts.length) html += '<div class="replies" id="replies-' + r.id + '">' + top.map(function (x) { return replyHtml(r, x, 0); }).join('') + '</div>';
  return html + '</article>';
}
function render() {
  var list = RIFFS.slice();
  if (S.tab === 'hot') list.sort(function (a, b) { return players(b).length - players(a).length || score(b.likes, b.id) - score(a.likes, a.id); });
  if (S.tab === 'songs') list = list.filter(function (r) { return r.song; });
  if (S.tab === 'fresh') list = list.filter(function (r) { return !r.song; }).concat(list.filter(function (r) { return r.song; }));
  el('list').innerHTML = S.failed ? '<p class="empty">' + esc(S.failed) + '</p>'
    : !S.loaded ? '<p class="empty">Loading the jams…</p>'
    : list.length ? list.map(riffHtml).join('')
    : '<p class="empty">' + (S.tab === 'songs' ? 'No songs yet.' : 'No jams yet. <a href="#start">Start the first one.</a>') + '</p>';
  [].forEach.call(document.querySelectorAll('#tabs [data-tab]'), function (b) { b.setAttribute('aria-pressed', String(b.dataset.tab === S.tab)); });
  /* every clip loads for its waveform; replies load once their thread is open */
  list.forEach(function (r) {
    load(r, { isRiff:true, url:r.url });
    if (S.expanded[r.id]) r.posts.forEach(function (p) { if (p.url) stemsOf(p).forEach(function (x) { load(r, x); }); });
  });
  drawWaves();
}

/* ---------- reply with audio ---------- */
var R = { rid:null, pid:null, file:null, buf:null };
var MD = null;
function openScrim(id) { el(id).classList.add('on'); }
function closeScrims() { if (S.playing === 'reply') { stop(); mdIdle(); render(); } [].forEach.call(document.querySelectorAll('.scrim'), function (s) { s.classList.remove('on'); }); }
function wantLen(c) { return c[0].dur || 0; }
function openReply(rid, pid) {
  var r = riff(rid); R = { rid:rid, pid:pid || null, file:null, buf:null };
  var c = chainOf(r, pid), used = c.map(function (p) { return p.layer; });
  var pp = pid ? postOf(r, pid) : null;
  el('r-title').textContent = 'Play along with ' + (!pp ? r.title : pp.kind === 'part' ? 'the new part' : whose(pp) + ' ' + lay(pp.layer).label);
  MD = { r:r, c:c, mute:{}, raf:0, dur:wantLen(c) };
  el('r-over').innerHTML = '<div class="md-top"><button class="play" type="button" id="md-play" aria-label="Play what you play on">&#9654;</button>' +
      '<span class="md-time" id="md-time">0:00</span><span class="md-hint">' + (r.bpm ? r.bpm + ' bpm' : 'tempo unknown') + (r.key ? ' · ' + esc(r.key) : '') + (r.sig ? ' · ' + esc(r.sig) : '') + '. Play along first, then add your take.</span>' +
      mixLink('Record in mix view', r, pid) + '</div>' +
    '<div class="md-lanes" id="md-lanes">' + c.map(function (p, i) {
      return '<div class="md-lane"><span class="md-name"><i style="background:' + lay(p.layer).c + '"></i><span><b>' + esc(p.by) + '</b>' + chipLabel(p) + '</span></span>' +
        '<canvas data-md="' + i + '"></canvas><button class="md-m" type="button" data-mdmute="' + i + '" aria-pressed="false" aria-label="Mute">M</button></div>';
    }).join('') +
    '<div class="md-lane you"><span class="md-name"><i style="background:var(--ember)"></i><span><b>You</b><span id="md-you"></span></span></span><div class="md-empty" id="md-empty">Your take lands here</div><span></span></div>' +
    '<div class="md-head" id="md-head" hidden></div></div>';
  el('r-layer').innerHTML = ROLES.map(function (x) { return '<option value="' + x.id + '">' + esc(x.label) + '</option>'; }).join('');
  el('r-layer').value = ROLES.map(function (x) { return x.id; }).filter(function (l) { return used.indexOf(l) < 0; })[0] || 'vocals';
  el('r-err').textContent = ''; el('r-text').value = ''; el('r-file').value = '';
  el('r-len').textContent = MD.dur ? 'Make it ' + mmss(MD.dur) + ' long (' + MD.dur.toFixed(1) + ' s), the length of what you play on.' : '';
  if (!el('r-name').value) el('r-name').value = myName();
  el('r-go').disabled = false;
  openScrim('reply-scrim'); mdYou(); mdDraw(); el('r-layer').focus();
  Promise.all(c.map(function (p) { return load(r, p); })).then(mdDraw);
}
function mdYou() { var y = el('md-you'); if (y) y.textContent = (role(el('r-layer').value) || {}).label || ''; }
function mdDraw() {
  if (!MD) return;
  var ink = getComputedStyle(document.documentElement).getPropertyValue('--wave').trim();
  MD.c.forEach(function (p, i) {
    var b = BUF[bufKey(MD.r, p)], cv = document.querySelector('canvas[data-md="' + i + '"]');
    if (b && !MD.dur) MD.dur = b.duration;
    if (cv) { waveShape(cv, b, ink); cv.style.opacity = MD.mute[i] ? .3 : 1; }
  });
  el('md-time').textContent = '0:00 / ' + mmss(MD.dur);
}
function mdPlay() {
  if (S.playing === 'reply') { stop(); mdIdle(); render(); return; }
  stop(); render(); S.playing = 'reply';
  el('md-play').innerHTML = '&#10074;&#10074;'; el('md-play').classList.add('on');
  var r = MD.r, a = ac(); a.resume(); var T = a.currentTime + 0.05; MD.gains = {};
  var lanes = MD.c.concat(R.buf ? [{ mine:true, buf:R.buf }] : []);
  lanes.forEach(function (p, i) {
    var b = p.buf || BUF[bufKey(r, p)]; if (!b) return;
    var src = a.createBufferSource(), g = a.createGain(); src.buffer = b; src.loop = true;
    g.gain.value = MD.mute[i] ? 0 : 1; src.connect(g); g.connect(a.destination); src.start(T); SRC.push(src); MD.gains[i] = g;
  });
  MD.t0 = T; el('md-head').hidden = false;
  (function tick() {
    if (S.playing !== 'reply' || !MD) return mdIdle();
    var pos = MD.dur ? ((ac().currentTime - MD.t0) % MD.dur + MD.dur) % MD.dur : 0, cv = document.querySelector('canvas[data-md="0"]'), h = el('md-head');
    if (cv && h) h.style.left = (cv.offsetLeft + cv.offsetWidth * pos / (MD.dur || 1)) + 'px';
    el('md-time').textContent = mmss(pos) + ' / ' + mmss(MD.dur);
    MD.raf = requestAnimationFrame(tick);
  })();
}
function mdIdle() {
  if (!el('md-play')) return;
  el('md-play').innerHTML = '&#9654;'; el('md-play').classList.remove('on'); el('md-head').hidden = true;
  if (MD) { cancelAnimationFrame(MD.raf); el('md-time').textContent = '0:00 / ' + mmss(MD.dur); }
}
el('r-layer').addEventListener('change', mdYou);
el('r-over').addEventListener('click', function (e) {
  var b;
  if (e.target.closest('#md-play')) { mdPlay(); return; }
  if ((b = e.target.closest('[data-mdmute]'))) {
    var i = +b.dataset.mdmute; MD.mute[i] = !MD.mute[i]; b.setAttribute('aria-pressed', String(!!MD.mute[i]));
    if (MD.gains && MD.gains[i]) MD.gains[i].gain.value = MD.mute[i] ? 0 : 1;
    mdDraw();
  }
});
el('r-file').addEventListener('change', function () {
  var f = el('r-file').files[0]; R.file = null; R.buf = null; el('r-err').textContent = '';
  if (!f) return;
  f.arrayBuffer().then(function (ab) { return ac().decodeAudioData(ab); }).then(function (b) {
    var want = MD.dur;
    if (want && Math.abs(b.duration - want) > TOL) {
      el('r-err').textContent = 'That take is ' + b.duration.toFixed(1) + ' s, it has to be ' + want.toFixed(1) + ' s (the length of what you play on). Trim it and try again.';
      return;
    }
    R.file = f; R.buf = b;
    var slot = el('md-empty'); if (slot) slot.outerHTML = '<canvas id="md-mine"></canvas>';
    waveShape(el('md-mine'), b, getComputedStyle(document.documentElement).getPropertyValue('--ember').trim());
  }).catch(function () { el('r-err').textContent = 'That file could not be read. Try a wav or mp3.'; });
});
el('r-go').addEventListener('click', function () {
  var who = el('r-name').value.trim();
  if (!R.file) { el('r-err').textContent = el('r-err').textContent || 'Pick your take first, an audio file of the right length.'; return; }
  if (!who) { el('r-err').textContent = 'Add your name first, it goes in the credits.'; el('r-name').focus(); return; }
  var r = riff(R.rid), pp = R.pid ? postOf(r, R.pid) : null, file = R.file, buf = R.buf;
  var section = !pp ? null : pp.kind === 'part' ? pp.id : pp.section || null;
  var replyTo = pp && pp.kind !== 'part' ? pp.id : null;
  el('r-go').disabled = true; el('r-err').textContent = 'Uploading…';
  ensureMe().then(function (u) {
    rememberName(who);
    var path = r.id + '/' + u.id + '/' + crypto.randomUUID() + '.' + extOf(file.name), type = typeFor(file);
    return db.uploadAudio(path, file, type).then(function () {
      return db.insertTake({ session_id:r.id, author_id:u.id, author_name:who.slice(0, 60), role_id:el('r-layer').value, note:el('r-text').value.trim(),
        status:'waiting', storage_path:path, file_name:file.name, mime_type:type, duration_sec:buf.duration, section_id:section, reply_to:replyTo,
        on_takes:section ? null : chainOf(r, R.pid).filter(function (x) { return !x.isRiff && !x.isPart; }).map(function (x) { return x.dbId || x.id; }) });
    });
  }).then(function (row) {
    BUF[r.id + ':' + row.id] = buf;
    closeScrims();
    S.expanded[r.id] = true;
    return reload().then(function () {
      var nr = riff(r.id); if (nr) { openTo(nr, postOf(nr, row.id)); render(); play(nr.id, row.id); }
      setTimeout(function () { var n = el('post-' + r.id + '-' + row.id); if (n) n.scrollIntoView({ behavior:'smooth', block:'center' }); }, 60);
      toast('Your take is posted. Anyone can play along on top of it now.');
    });
  }).catch(function (e) { el('r-go').disabled = false; el('r-err').textContent = (e && e.message) || 'That didn’t work, try again.'; });
});

/* ---------- start a jam from the upload panel ---------- */
var UP = { file:null, buf:null, an:null };
el('up-layer').innerHTML = ROLES.map(function (x) { return '<option value="' + x.id + '">' + esc(x.label) + '</option>'; }).join('');
el('up-layer').value = 'guitar';
function renderInsts() {
  el('inst-row').innerHTML = ROLES.filter(function (x) { return x.id !== 'wild'; }).map(function (x) {
    return '<button class="inst" type="button" data-inst="' + x.id + '" aria-pressed="' + (el('up-layer').value === x.id) + '">' +
      '<span class="ic" style="color:var(' + x.color + ')">' + ico(x.icon, 'var(' + x.color + ')') + '</span>' + esc(x.label) + '</button>';
  }).join('');
}
renderInsts();
el('up-layer').addEventListener('change', renderInsts);
el('inst-row').addEventListener('click', function (e) {
  var b = e.target.closest('[data-inst]'); if (!b) return;
  el('up-layer').value = b.dataset.inst; renderInsts();
  if (el('picked').hidden) toast(role(b.dataset.inst).label + ' it is. Upload your clip, or record it in the song view.');
});
function takeFile(f) {
  if (!f) return;
  el('up-err').textContent = '';
  f.arrayBuffer().then(function (ab) { return ac().decodeAudioData(ab); }).then(function (b) {
    UP = { file:f, buf:b, an:null };
    el('dropzone').hidden = true; el('picked').hidden = false;
    el('up-name').textContent = f.name + ' · ' + b.duration.toFixed(1) + ' s';
    if (!el('up-title').value) el('up-title').value = f.name.replace(/\.[^.]+$/, '');
    if (!el('up-name-in').value) el('up-name-in').value = myName();
    waveShape(el('up-wave'), b, getComputedStyle(document.documentElement).getPropertyValue('--wave').trim());
    el('up-bpm').value = ''; el('up-bpm').placeholder = 'detecting…';
    analyse(f).then(function (an) {
      if (UP.file !== f) return;
      UP.an = an;
      if (an && an.tempo && !el('up-bpm').value) el('up-bpm').value = an.tempo.bpm;
      el('up-bpm').placeholder = 'bpm';
    }).catch(function () { el('up-bpm').placeholder = 'bpm'; });
    el('up-title').focus();
  }).catch(function () { toast('That file could not be read. Try a wav or mp3.'); });
}
el('dropzone').addEventListener('click', function (e) { if (e.target.id !== 'up-file') el('up-file').click(); });
el('dropzone').addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el('up-file').click(); } });
['dragenter','dragover'].forEach(function (ev) { el('dropzone').addEventListener(ev, function (e) { e.preventDefault(); el('dropzone').classList.add('hover'); }); });
['dragleave','drop'].forEach(function (ev) { el('dropzone').addEventListener(ev, function (e) { e.preventDefault(); el('dropzone').classList.remove('hover'); }); });
el('dropzone').addEventListener('drop', function (e) { takeFile(e.dataTransfer.files[0]); });
el('up-file').addEventListener('change', function () { takeFile(el('up-file').files[0]); });
el('up-change').addEventListener('click', function () { el('picked').hidden = true; el('dropzone').hidden = false; el('up-file').value = ''; el('up-file').click(); });
el('up-go').addEventListener('click', function () {
  var title = el('up-title').value.trim(), who = el('up-name-in').value.trim(), f = UP.file, b = UP.buf, an = UP.an;
  if (!title) { el('up-err').textContent = 'Give your jam a name.'; el('up-title').focus(); return; }
  if (!who) { el('up-err').textContent = 'Add your name first, it goes in the credits.'; el('up-name-in').focus(); return; }
  var bpm = +el('up-bpm').value || null, sess = null;
  el('up-go').disabled = true; el('up-err').textContent = 'Uploading…';
  ensureMe().then(function (u) {
    rememberName(who);
    return db.createSession(u.id).then(function (s) {
      sess = s;
      var path = s.id + '/' + u.id + '/' + crypto.randomUUID() + '.' + extOf(f.name), type = typeFor(f);
      return db.uploadAudio(path, f, type).then(function () {
        return db.insertTake({ session_id:s.id, author_id:u.id, author_name:who.slice(0, 60), role_id:'seed', note:el('up-text').value.trim(), status:'seed',
          storage_path:path, file_name:f.name, mime_type:type, duration_sec:b.duration,
          an_bpm:an && an.tempo ? an.tempo.bpm : null, an_key:an && an.key ? an.key.key : null });
      });
    });
  }).then(function (row) {
    var patch = { seed_take_id:row.id, seed_role:el('up-layer').value, title:title.slice(0, 120) };
    if (bpm) patch.bpm = bpm;
    if (an && an.key) { patch.music_key = an.key.key; patch.key_alt = an.key.runnerUp; }
    if (an && (an.tempo || an.key)) {
      patch.meta_from = an.tempo && bpm === an.tempo.bpm ? 'detected' : 'you';
      patch.meta_sure = sureness(Math.min(an.tempo ? an.tempo.conf : 0, an.key ? an.key.conf : 0));
    } else if (bpm) patch.meta_from = 'you';
    return db.updateSession(sess.id, patch);
  }).then(function () {
    BUF[sess.id + ':riff'] = b;
    closeScrims();
    el('picked').hidden = true; el('dropzone').hidden = false; el('up-file').value = ''; el('up-title').value = ''; el('up-text').value = '';
    el('up-go').disabled = false; el('up-err').textContent = '';
    S.tab = 'fresh';
    return reload().then(function () {
      el('feed').scrollIntoView({ behavior:'smooth', block:'start' });
      toast('Your jam is live. When people play along, you’ll see it here.');
    });
  }).catch(function (e) { el('up-go').disabled = false; el('up-err').textContent = (e && e.message) || 'That didn’t work, try again.'; });
});

/* ---------- clicks ---------- */
document.addEventListener('click', function (e) {
  var b = e.target.closest('a[href="#start"], a[href="#feed"]');
  if (b) { e.preventDefault(); el(b.getAttribute('href').slice(1)).scrollIntoView({ behavior:'smooth', block:'start' }); return; }
  if ((b = e.target.closest('[data-close]'))) { closeScrims(); return; }
  if ((b = e.target.closest('[data-upopen]'))) { openScrim('up-scrim'); return; }
  if (e.target.classList && e.target.classList.contains('scrim')) { closeScrims(); return; }
  if ((b = e.target.closest('[data-play]'))) { play(b.dataset.play, b.dataset.post); return; }
  if ((b = e.target.closest('[data-reply]'))) { openReply(b.dataset.reply, b.dataset.post); return; }
  if ((b = e.target.closest('[data-comment]'))) { openComment(b.dataset.comment, b.dataset.post); return; }
  if ((b = e.target.closest('[data-ccancel]'))) { S.cmt.at = null; render(); return; }
  if ((b = e.target.closest('[data-fold]'))) { S.fold[b.dataset.fold] = !S.fold[b.dataset.fold]; render(); return; }
  if ((b = e.target.closest('[data-expand]'))) { S.expanded[b.dataset.expand] = !S.expanded[b.dataset.expand]; render(); return; }
  if ((b = e.target.closest('[data-letin]'))) {
    b.disabled = true;
    db.letIn(b.dataset.letin).then(reload).then(function () { toast('It’s in the song now.'); }).catch(function (x) { b.disabled = false; oops(x); });
    return;
  }
  if ((b = e.target.closest('[data-playsong]'))) { playSong(b.dataset.playsong); return; }
  if ((b = e.target.closest('[data-playmix]'))) { playMix(b.dataset.playmix); return; }
  if ((b = e.target.closest('[data-vote]'))) { vote(b.dataset.vote, +b.dataset.dir); return; }
  if ((b = e.target.closest('[data-del]'))) { askOrDelete(b.dataset.del); return; }
  if ((b = e.target.closest('[data-tab]'))) { e.preventDefault(); S.tab = b.dataset.tab; render(); return; }
});
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeScrims(); });
window.addEventListener('resize', drawWaves);
window.addEventListener('stackato:theme', drawWaves);

/* ---------- sign in (email accounts are real; sign-up and Google are stubbed) ---------- */
var AUTH = { tab:'in' };
function authTab(t) {
  AUTH.tab = t;
  [].forEach.call(document.querySelectorAll('.auth-tabs [data-authtab]'), function (b) { b.setAttribute('aria-selected', String(b.dataset.authtab === t)); });
  el('auth-title').textContent = t === 'up' ? 'Join Stackato' : 'Welcome back';
  el('auth-sub').textContent = t === 'up' ? 'Keep your name on every take, and hear it when someone plays on yours.' : 'Sign in to keep playing where you left off.';
  el('auth-name-f').hidden = t !== 'up';
  el('auth-go').textContent = t === 'up' ? 'Create my account' : 'Sign in';
  el('auth-pass').setAttribute('autocomplete', t === 'up' ? 'new-password' : 'current-password');
  el('auth-switch').innerHTML = t === 'up' ? 'Already have an account? <button class="ghost" type="button" data-authtab="in">Sign in</button>'
    : 'Sign-up opens soon. <button class="ghost" type="button" data-authforgot="1">Forgot your password?</button>';
  el('auth-err').textContent = '';
}
function renderAuth() {
  var name = db.accountName(me), acts = document.querySelector('header.top .hdr-acts');
  [].forEach.call(acts.querySelectorAll('[data-auth], .hdr-user, .hdr-signup, [data-signout]'), function (x) { x.remove(); });
  var slot = acts.querySelector('[data-theme-toggle]');
  (slot ? slot.insertAdjacentHTML.bind(slot, 'afterend') : acts.insertAdjacentHTML.bind(acts, 'afterbegin'))(name
    ? '<span class="hdr-user"><i>' + esc(name.charAt(0).toUpperCase()) + '</i>' + esc(name) + '</span><button class="ghost" type="button" data-signout="1">Sign out</button>'
    : '<button class="ghost" type="button" data-auth="in">Sign in</button><button class="btn hdr-signup" type="button" disabled title="Sign-up opens soon">Sign up</button>');
  [].forEach.call(document.querySelectorAll('.hero-cta'), function (w) { w.hidden = !!name; });
  if (name) ['up-name-in', 'r-name'].forEach(function (id) { if (el(id)) el(id).value = name; });
}
document.addEventListener('click', function (e) {
  var b = e.target.closest('[data-auth]');
  if (b) { authTab('in'); openScrim('auth-scrim'); setTimeout(function () { el(AUTH.tab === 'up' ? 'auth-name' : 'auth-mail').focus(); }, 30); return; }
  if ((b = e.target.closest('[data-authtab]'))) { if (!b.disabled) authTab(b.dataset.authtab); return; }
  if (e.target.closest('[data-authforgot]')) { el('auth-err').textContent = 'Resetting a password isn’t possible yet. Ask Yarne or Jurgen to reset it for you.'; return; }
  if (e.target.closest('[data-authgo="google"]')) { el('auth-err').textContent = 'Signing in with Google is coming soon. Use your email and password for now.'; return; }
  if (e.target.closest('[data-signout]')) {
    db.signOut().then(function () { toast('You’re signed out. You can still vote and comment.'); }).catch(oops);
  }
});
el('auth-form').addEventListener('submit', function (e) {
  e.preventDefault();
  var mail = el('auth-mail').value.trim(), pass = el('auth-pass').value;
  if (AUTH.tab === 'up') { el('auth-err').textContent = 'Signing up isn’t open yet. Ask Yarne or Jurgen for an account, or keep playing without one.'; return; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) { el('auth-err').textContent = 'That email doesn’t look right.'; el('auth-mail').focus(); return; }
  if (!pass) { el('auth-err').textContent = 'Fill in your password.'; el('auth-pass').focus(); return; }
  el('auth-go').disabled = true; el('auth-err').textContent = '';
  db.signInWithEmail(mail, pass).then(function (u) {
    el('auth-pass').value = ''; closeScrims();
    toast('Welcome back, ' + db.accountName(u) + '.');
  }).catch(function (x) {
    el('auth-err').textContent = /invalid/i.test((x && x.message) || '') ? 'That email and password don’t match an account.' : ((x && x.message) || 'That didn’t work, try again.');
  }).then(function () { el('auth-go').disabled = false; });
});

/* ---------- start ---------- */
render();
if (configured) {
  db.currentUser().then(function (u) { me = u; renderAuth(); return reload(); }).catch(function (e) { console.error(e); reload(); });
  db.onAuthChange(function (u, ev) {
    if (ev === 'INITIAL_SESSION' || ev === 'TOKEN_REFRESHED') return;
    var was = me && me.id; me = u; renderAuth();
    if ((u && u.id) !== was) reload();
  });
} else { renderAuth(); reload(); }

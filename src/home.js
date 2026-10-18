/* The homepage (/): a feed of jams with their threads.

   A jam is a session with an original track. Its thread holds the audio replies (takes;
   takes.reply_to says which take a reply was played on top of) and the written replies
   (thread_comments), and anyone can up- or downvote the jam, a take or a comment
   (thread_votes). Reading needs no sign-in; every write (a comment, a vote, a take, a new
   jam) asks for an account first (src/auth.js) and carries on once there is one. Playing a take plays it with everything above it in its thread.

   The markup is built from strings like in app.js; render() redraws the whole list. */

import './theme.js';
import { configured } from './supabase.js';
import * as db from './data.js';
import { requireAccount, onAccount, postingAs, setToast, profileHref } from './auth.js';
import { analyse, sureness } from './analysis.js';
import { stackTree, viewToggle, savedView, rememberView } from './stacktree.js';
import { ROLES, role } from './roles.js';
import { AMPS, renderAmp, liveAmp, dropAmp, preloadAmp } from './amp.js';
import { AMP_ROLES, savedMic, rememberMic, savedAmp, rememberAmp, savedMon, rememberMon, recAmpFor, recWorklet, openMic, listMics, capture, newContext, rateTip, monitorOn, armMonitor, disarmMonitor, allowInputs, inputLatency, blockPeaks,
         beatInfoFor, clickSamples, assembleTake, bleedNote, quietNote, micError, encodeWav } from './rec.js';

var TOL = 0.6;                     /* seconds a take may differ from what it plays on (as in app.js) */

var LAYERS = { seed:{ label:'original track', c:'var(--seed)' }, part:{ label:'new part', c:'var(--part)' } };
ROLES.forEach(function (r) { LAYERS[r.id] = { label:r.label.toLowerCase(), c:'var(' + r.color + ')' }; });
function lay(id) { return LAYERS[id] || LAYERS.wild; }

var RIFFS = [];
var S = { tab:'fresh', tview:savedView(), expanded:{}, fold:{}, vote:{}, playing:null, cmt:{ at:null, text:'' }, loaded:false, failed:null, sure:null };
var KIND = {};                     /* target id -> { kind, sid } for votes */
var me = null;                     /* the signed-in account (src/auth.js), or null */
var AC = null, BUF = {}, SRC = [];

function el(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
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

/* every write needs an account with a name; this asks for one (sign up or sign in) and
   resolves once it's there, so the action carries on. why: a key of auth.js's reasons */
function ensureMe(why) {
  return requireAccount(why).then(function (u) { me = u; return u; });
}
function jamCard(r, why) {
  var a = { play:'Sign up to play along', reply:'Sign up to reply' }[why];
  var b = { play:'Every take carries your name and shows up on your profile. It takes a minute, and you can listen without an account.',
            reply:'Every reply carries your name. It takes a minute, and you can read and listen without an account.' }[why];
  return { heading:a, text:b, jam:{ title:r.title, meta:['by ' + r.by, r.bpm ? r.bpm + ' BPM' : '', r.key || ''].filter(Boolean).join(' · ') } };
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
    var posts = [], mix = null, rowOf = {};
    tk.forEach(function (t) { rowOf[t.id] = t; });
    /* tracks carried into a new part (takes.carry) play again under it */
    function carried(ids) {
      return (ids || []).map(function (id) {
        var c = rowOf[id]; if (!c || c.status === 'deleted' || c.role_id === 'part' || c.role_id === 'mix') return null;
        if (c.id === s.seed_take_id) return { id:'riff', isRiff:true, by:seed.author_name, layer:LAYERS[s.seed_role] ? s.seed_role : 'seed', url:db.publicUrl(seed.storage_path), dur:seed.duration_sec, amp:seed.amp || '' };
        return { id:c.id, by:c.author_name, uid:c.author_id, layer:LAYERS[c.role_id] ? c.role_id : 'wild', url:db.publicUrl(c.storage_path), dur:c.duration_sec, amp:c.amp || '' };
      }).filter(Boolean);
    }
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
      var base = { id:t.id, by:t.author_name, uid:t.author_id, mine:!!(me && t.author_id === me.id), time:ago(t.created_at), created:t.created_at,
        text:t.note, url:db.publicUrl(t.storage_path), path:t.storage_path, dur:t.duration_sec, likes:votes[t.id] || 0, status:t.status, amp:t.amp || '' };
      KIND[t.id] = { kind:'take', sid:s.id };
      if (t.role_id === 'part') {
        if (t.status !== 'in' && t.status !== 'waiting') return;
        posts.push(Object.assign(base, { parent:null, kind:'part', layer:'part', pos:t.part_pos, carry:carried(t.carry) }));
        return;
      }
      posts.push(Object.assign(base, { parent:t.reply_to || t.section_id || null, section:t.section_id || null, group:t.group_id || null,
        layer:LAYERS[t.role_id] ? t.role_id : 'wild', inSong:t.status === 'in' && !t.section_id }));
    });
    feed.comments.filter(function (c) { return c.session_id === s.id; }).forEach(function (c) {
      KIND[c.id] = { kind:'comment', sid:s.id };
      if (c.deleted_at) { posts.push({ id:c.id, parent:c.reply_to_take || c.reply_to_comment || null, deleted:true, isComment:true, created:c.created_at, likes:0 }); return; }
      posts.push({ id:c.id, parent:c.reply_to_take || c.reply_to_comment || null, by:c.author_name, uid:c.author_id, mine:!!(me && c.author_id === me.id),
        time:ago(c.created_at), created:c.created_at, text:c.body, likes:votes[c.id] || 0, isComment:true });
    });
    /* takes sent together as one reply: the first is the post, the others play as its stems */
    var groups = {};
    posts = posts.filter(function (p) {
      var g = p.group; if (!g || p.deleted) return true;
      if (!groups[g]) { groups[g] = p; p.stems = []; return true; }
      groups[g].stems.push({ id:p.id, by:p.by, mine:p.mine, layer:p.layer, url:p.url, path:p.path, dur:p.dur, amp:p.amp }); return false;
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
    var r = { id:s.id, slug:s.slug, by:seed.author_name, uid:s.host_id, title:title, bpm:s.bpm, key:s.music_key || '', sig:s.time_sig && s.time_sig !== '4/4' ? s.time_sig : '',
      time:ago(s.created_at), text:seed.note, layer:LAYERS[s.seed_role] ? s.seed_role : 'seed', url:db.publicUrl(seed.storage_path), dur:seed.duration_sec, amp:seed.amp || '',
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
/* names link to their profiles once we know who has one (user id -> name) */
var PROF = {};
function nameOf(text, uid) {
  return uid && PROF[uid] ? '<a class="pf-name" href="' + profileHref(PROF[uid]) + '">' + esc(text) + '</a>' : esc(text);
}
function askProfiles(feed) {
  var ids = feed.sessions.map(function (s) { return s.host_id; })
    .concat(feed.takes.map(function (t) { return t.author_id; }), feed.comments.map(function (c) { return c.author_id; }))
    .filter(function (id) { return id && !(id in PROF); });
  if (!ids.length) return;
  db.profilesFor(ids).then(function (names) {
    ids.forEach(function (id) { PROF[id] = names[id] || null; });
    if (Object.keys(names).length) render();
  }).catch(function (e) { console.warn('Could not load the profile names', e); });
}
function reload() {
  if (!configured) { S.failed = 'Supabase is not configured. Copy .env.example to .env.local and fill it in.'; render(); return Promise.resolve(); }
  return db.loadFeed(20).then(function (feed) { build(feed); S.loaded = true; S.failed = null; render(); askProfiles(feed); if (LANDING) land(); })
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
  ensureMe('vote').then(function (u) {
    var before = S.vote[k] || 0, value = before === dir ? 0 : dir;
    S.vote[k] = value; render();
    return db.voteInThread({ targetId:k, targetKind:t.kind, sessionId:t.sid, voterId:u.id, value:value })
      .catch(function (e) { S.vote[k] = before; render(); oops(e); });
  });
}

/* ---------- comments: reply with words only ---------- */
function commentBtn(r, pid, label) {
  return '<button class="ghost" type="button" data-comment="' + r.id + '" data-post="' + (pid || '') + '">' + (label || 'Comment') + '</button>';
}
function commentForm(r, pid) {
  if (S.cmt.at !== key(r, pid)) return '';
  var p = pid ? postOf(r, pid) : null, to = !p ? r.by : p.mine ? 'yourself' : p.by;
  return '<form class="cbox" id="c-form" data-cform="' + key(r, pid) + '">' +
    '<textarea id="c-text" maxlength="500" placeholder="Say something to ' + esc(to) + '" aria-label="Your comment">' + esc(S.cmt.text) + '</textarea>' +
    '<div class="crow">' + postingAs() + '<span class="grow"></span>' +
      '<button class="btn btn-sm" type="button" data-ccancel="1">Cancel</button><button class="btn btn-sm btn-main" type="submit" id="c-go">Post comment</button></div>' +
    '<p class="err" id="c-err"></p></form>';
}
function openComment(rid, pid) {
  var r = riff(rid), k = key(r, pid || null);
  if (S.cmt.at === k) { S.cmt.at = null; render(); return; }
  ensureMe(jamCard(r, 'reply')).then(function () {
    S.cmt = { at:k, text:'' };
    if (pid) { S.expanded[rid] = true; openTo(r, postOf(r, pid)); }
    render();
    var t = el('c-text'); if (t) t.focus();
  });
}
function postComment() {
  var text = el('c-text').value.trim();
  if (!text) { el('c-err').textContent = 'Write something first.'; el('c-text').focus(); return; }
  var parts = S.cmt.at.split(':'), r = riff(parts[0]), pid = parts[1] === 'riff' ? null : parts[1], p = pid ? postOf(r, pid) : null;
  el('c-go').disabled = true;
  ensureMe('reply').then(function (u) {
    /* the database writes the account's name over author_name */
    return db.addThreadComment({ session_id:r.id, reply_to_take:p && !p.isComment ? p.id : null, reply_to_comment:p && p.isComment ? p.id : null,
      author_id:u.id, author_name:db.accountName(u), body:text });
  }).then(function (row) {
    S.cmt = { at:null, text:'' };
    S.expanded[r.id] = true; if (pid) S.fold[r.id + ':' + pid] = true;
    return reload().then(function () {
      var n = el('post-' + r.id + '-' + row.id); if (n) { n.scrollIntoView({ behavior:'smooth', block:'center' }); n.classList.add('hl'); }
      toast('Your comment is posted.');
    });
  }).catch(function (e) { if (el('c-go')) el('c-go').disabled = false; if (el('c-err')) el('c-err').textContent = (e && e.message) || 'That didn’t work, try again.'; });
}
document.addEventListener('input', function (e) {
  if (e.target.id === 'c-text') S.cmt.text = e.target.value;
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
    if (p.kind === 'part') return [{ id:p.id, by:p.by, mine:p.mine, layer:'part', url:p.url, dur:p.dur, isPart:true }].concat(p.carry || [], out);
    if (p.layer) out = stemsOf(p).concat(out);
  }
  return [{ id:'riff', by:r.by, layer:r.layer, url:r.url, dur:r.dur, isRiff:true, mine:r.host, amp:r.amp }].concat(out);
}
function bufKey(r, p) { return p.isRiff ? r.id + ':riff' : r.id + ':' + p.id; }
function chipLabel(p) { return p.isRiff ? 'clip' : p.isPart ? 'new part' : lay(p.layer).label; }
function chainChips(r, c) { return c.map(function (p) { return '<span class="chip"><span class="dot" style="background:' + lay(p.layer).c + '"></span>' + esc(whose(p)) + ' ' + chipLabel(p) + '</span>'; }).join(''); }

/* ---------- audio ---------- */
function ac() { if (!AC) AC = newContext(); return AC; }
function load(r, p) {
  var k = bufKey(r, p);
  if (BUF[k] || BUF[k + ':loading'] || !p.url) return Promise.resolve();
  BUF[k + ':loading'] = true;
  return fetch(p.url).then(function (x) { if (!x.ok) throw new Error(x.status); return x.arrayBuffer(); })
    .then(function (ab) { return ac().decodeAudioData(ab); })
    .then(function (b) { BUF[k] = b; drawWaves(); })
    .catch(function (e) { console.warn('Could not load audio', p.url, e); });
}
/* A take with an amp (a dry DI guitar, set in the song view) plays rendered through it.
   The render is made once and kept next to the dry audio; if it fails, the take plays dry. */
function ampKey(r, p) { return bufKey(r, p) + '@' + p.amp; }
function amped(r, p) {
  var b = BUF[bufKey(r, p)], k = ampKey(r, p);
  if (!p.amp || !b || BUF[k] || BUF[k + ':failed']) return Promise.resolve();
  if (!BUF[k + ':busy']) BUF[k + ':busy'] = renderAmp(b, p.amp).then(function (x) { BUF[k] = x; }, function (e) { console.warn('Could not render the amp', e); BUF[k + ':failed'] = true; });
  return BUF[k + ':busy'];
}
function bufFor(r, p) { return (p.amp && BUF[ampKey(r, p)]) || BUF[bufKey(r, p)]; }
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
    return Promise.all(c.map(function (p) { return amped(r, p); }));
  }).then(function () {
    if (S.playing !== k) return;
    var a = ac(); a.resume(); var T = a.currentTime + 0.05, len = 0;
    c.forEach(function (p) { var b = bufFor(r, p); if (b) len = Math.max(len, b.duration); });
    var from = seek ? ((at % len) + len) % len : 0;
    c.forEach(function (p) {
      var b = bufFor(r, p); if (!b) return;
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
    /* a take in a thread wears its instrument's colour; everything turns green while you hear it */
    var tone = lit ? '--sound' : cv.closest('.take') && cv.dataset.layer ? lay(cv.dataset.layer).c.slice(4, -1) : '--wave';
    waveShape(cv, BUF[cv.dataset.wave], css.getPropertyValue(tone).trim());
  });
}

/* ---------- rendering ---------- */
function lyr(layer) { return '<b class="lyr" style="color:' + lay(layer).c + '">' + lay(layer).label + '</b>'; }
/* a take's avatar wears its instrument's colour; written replies get an outlined one */
function ava(name, layer, sm) {
  return '<span class="ava' + (sm ? ' sm' : '') + (layer ? '' : ' words') + '"' + (layer ? ' style="background:' + lay(layer).c + '"' : '') + ' aria-hidden="true">' +
    esc(String(name).charAt(0).toUpperCase()) + '</span>';
}
/* folding: every level of replies opens and closes on its own */
function folded(k) { return !S.fold[k]; }
function countDesc(r, id) { return kids(r, id).reduce(function (n, k) { return n + 1 + countDesc(r, k.id); }, 0); }
function foldBtn(r, id) {
  var n = countDesc(r, id), k = r.id + ':' + id;
  return '<button class="fold' + (folded(k) ? '' : ' open') + '" type="button" data-fold="' + k + '" aria-expanded="' + !folded(k) + '">' + (folded(k) ? 'Show ' + n + (n > 1 ? ' replies' : ' reply') : 'Hide replies') + '</button>';
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
function metaTime(p) { return '<span class="muted">· ' + esc(p.time) + '</span>'; }
/* a reply in the thread: an avatar, then who and what, the words, the take, what you can do, and its own replies */
function node(r, p, cls, aside, body, depth) {
  return '<div class="node' + (cls ? ' ' + cls : '') + '" id="post-' + r.id + '-' + p.id + '">' + aside +
    '<div class="nbody">' + body + kidsHtml(r, p, depth) + '</div></div>';
}
function partHtml(r, p, depth) {
  var on = S.playing === key(r, p.id), kept = p.status === 'in';
  return node(r, p, 'upd', '<span class="ava upd-ava" aria-hidden="true">&#8596;</span>',
    '<div class="meta"><b>' + nameOf(p.mine ? 'You' : p.by, p.uid) + '</b><span class="muted">' + (kept ? 'extended the jam' : 'pitched a new part') + '</span>' + metaTime(p) + '</div>' +
    (p.text ? '<p class="bubble">' + esc(p.text) + '</p>' : '') +
    '<div class="take' + (on ? ' on' : '') + '"><div class="take-row"><button class="play sm' + (on ? ' on' : '') + '" type="button" data-play="' + r.id + '" data-post="' + p.id + '" aria-label="' + (on ? 'Stop' : 'Play the new part') + '">' + (on ? '&#10074;&#10074;' : '&#9654;') + '</button>' +
      '<canvas data-wave="' + r.id + ':' + p.id + '" data-layer="part"></canvas></div><div class="chain">plays ' + (p.pos === 'before' ? 'before' : 'after') + ' the original clip' +
      ((p.carry || []).length ? ', with ' + chainChips(r, p.carry) : '') + '</div></div>' +
    '<div class="acts">' + (r.open && kept ? '<button class="ghost accent" type="button" data-reply="' + r.id + '" data-post="' + p.id + '">+ Play on the new part</button>' : '') +
      mixLink('Show in the project', r, p.id) + commentBtn(r, p.id, 'Reply') + voteHtml(p.id, p.likes) + '</div>' + commentForm(r, p.id), depth);
}
function goneHtml(r, p, depth) {
  return node(r, p, 'gone', '<span class="ava words" aria-hidden="true"></span>',
    '<p class="gone-txt">' + (p.isComment ? 'This reply was deleted.' : 'This take was deleted. The replies played on it stay.') + '</p>', depth);
}
function replyHtml(r, p, depth) {
  if (p.deleted) return goneHtml(r, p, depth);
  if (p.kind === 'part') return partHtml(r, p, depth);
  var on = S.playing === key(r, p.id);
  return node(r, p, '', ava(p.mine ? 'You' : p.by, p.layer),
    '<div class="meta"><b>' + nameOf(p.mine ? 'You' : p.by, p.uid) + '</b>' + (p.layer ? '<span class="muted">added</span>' + stemsOf(p).map(function (x) { return lyr(x.layer); }).join(' + ') : '') +
      (p.inSong ? '<span class="songtag">In the song</span>' : '') + metaTime(p) + '</div>' +
    (p.text ? '<p class="bubble">' + esc(p.text) + '</p>' : '') +
    (p.layer ? '<div class="take' + (on ? ' on' : '') + '"><div class="take-row"><button class="play sm' + (on ? ' on' : '') + '" type="button" data-play="' + r.id + '" data-post="' + p.id + '" aria-label="' + (on ? 'Stop' : 'Play with everything above it') + '">' + (on ? '&#10074;&#10074;' : '&#9654;') + '</button>' +
      (p.stems && p.stems.length ? '<div class="mixlanes">' + stemsOf(p).map(function (x) { return '<canvas data-wave="' + r.id + ':' + x.id + '" data-of="' + key(r, p.id) + '" data-layer="' + x.layer + '"></canvas>'; }).join('') + '</div>'
        : '<canvas data-wave="' + r.id + ':' + p.id + '" data-of="' + key(r, p.id) + '" data-layer="' + p.layer + '"></canvas>') + '</div>' +
      '<div class="chain">on top of ' + chainChips(r, chainOf(r, p.id).slice(0, -stemsOf(p).length)) + '</div></div>' : '') +
    '<div class="acts">' +
      (p.layer && r.host && r.open && p.status === 'waiting' && !p.section ? '<button class="btn btn-sm btn-main" type="button" data-letin="' + p.id + '">Add to song</button>' : '') +
      (p.layer && r.open ? '<button class="ghost accent" type="button" data-reply="' + r.id + '" data-post="' + p.id + '">+ Reply with audio</button>' : '') +
      commentBtn(r, p.id, 'Reply') + (p.layer ? mixLink('Show in the project', r, p.id) : '') +
      (canDelete(p.mine) ? delBtn(p.isComment ? 'comment' : 'take', p.id) : '') + voteHtml(p.id, p.likes) + '</div>' + commentForm(r, p.id), depth);
}
/* The stack view (src/stacktree.js): the same replies as a tree. The clip is the root, every take
   hangs on what it was played on, so each path is a stack; written replies stay in the thread. */
function treeOf(r) {
  function audio(p) { return p.deleted ? !p.isComment : p.kind === 'part' || (!!p.layer && !p.isComment); }
  function nodeOf(p) {
    var ks = kids(r, p.id).filter(audio).map(nodeOf);
    if (p.deleted) return { gone:true, title:'Deleted take', kids:ks };
    var who = esc(p.mine ? 'You' : p.by), on = S.playing === key(r, p.id);
    if (p.kind === 'part') return { title:who, sub:'new part, plays ' + (p.pos === 'before' ? 'before' : 'after') + ' the clip', dots:['var(--part)'].concat((p.carry || []).map(function (c) { return lay(c.layer).c; })),
      attrs:'data-play="' + r.id + '" data-post="' + p.id + '"', on:on, kids:ks };
    return { title:who, sub:esc(stemsOf(p).map(function (x) { return lay(x.layer).label; }).join(' + ')) + ' · ' + esc(p.time),
      dots:chainOf(r, p.id).map(function (x) { return lay(x.layer).c; }), attrs:'data-play="' + r.id + '" data-post="' + p.id + '"', on:on, song:!!p.inSong, kids:ks };
  }
  var top = r.posts.filter(function (p) { return !p.parent && audio(p); });
  var roots = [{ root:true, title:esc(r.host ? 'Your clip' : r.by + '’s clip'), sub:'where every stack starts', dots:[lay(r.layer).c],
    attrs:'data-play="' + r.id + '"', on:S.playing === key(r), kids:top.filter(function (p) { return p.kind !== 'part'; }).map(nodeOf) }]
    .concat(top.filter(function (p) { return p.kind === 'part'; }).map(nodeOf));
  return stackTree(roots, 'Every path from the left is a stack. Click one to hear it; switch to Thread to reply.');
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
function riffMeta(r) {
  return esc(r.time) + (r.bpm ? ' · ' + r.bpm + ' bpm' : '') + (r.key ? ' · ' + esc(r.key) : '') + (r.sig ? ' · ' + esc(r.sig) : '') + (r.dur ? ' · ' + mmss(r.dur) : '');
}
function riffHtml(r) {
  var on = S.playing === key(r), ps = players(r), open = !!S.expanded[r.id], song = songOf(r);
  var top = r.posts.filter(function (p) { return !p.parent; });
  var html = '<article class="riff' + (r.host ? ' mine' : '') + '" id="riff-' + r.id + '"><div class="rmain">' +
    '<div class="rhead">' + ava(r.by, r.layer) + '<div class="rwho"><b>' + nameOf(r.by, r.uid) + (r.host ? ' (you)' : '') + '</b> started a jam' + (r.layer !== 'seed' ? ' · ' + lyr(r.layer) : '') +
      '<small>' + riffMeta(r) + '</small></div></div>' +
    '<h2 class="rtitle">' + esc(r.title) + (r.song ? '<span class="tag">Became a song</span>' : '') + '</h2>' + (r.text ? '<p class="rtext">' + esc(r.text) + '</p>' : '') +
    '<div class="well"><button class="play big' + (on ? ' on' : '') + '" type="button" data-play="' + r.id + '" aria-label="' + (on ? 'Stop' : 'Play the clip') + '">' + (on ? '&#10074;&#10074;' : '&#9654;') + '</button>' +
      '<canvas data-wave="' + r.id + ':riff" data-layer="' + r.layer + '"></canvas><span class="wtime">' + mmss(r.dur) + '</span></div>' +
    '<div class="racts">' + (r.open ? '<button class="btn btn-main" type="button" data-reply="' + r.id + '">Play along</button>' : '') +
      '<a class="btn" href="/s/' + encodeURIComponent(r.slug) + '">Open the project</a>' +
      (song.length ? '<button class="btn btn-soft" type="button" data-playsong="' + r.id + '">' + (S.playing === r.id + ':song' ? '&#10074;&#10074; ' : '&#9654; ') + 'The song · ' + song.length + (song.length > 1 ? ' takes' : ' take') + '</button>' : '') +
      commentBtn(r, null) + (canDelete(r.host) ? delBtn('jam', r.id, 'Delete jam') : '') +
      '<span class="grow"></span>' +
      (ps.length ? '<span class="played"><span class="faces">' + ps.slice(0, 5).map(function (p) { return ava(p.mine ? 'You' : p.by, p.layer, true); }).join('') + '</span>' +
        ps.length + ' musician' + (ps.length > 1 ? 's' : '') + ' played along</span>' : '<span class="played">Nobody played along yet. Be the first.</span>') +
      voteHtml(r.id, r.likes) + '</div>' + commentForm(r, null);
  if (r.song) html += '<div class="became"><p><b>' + esc(r.song.name) + '</b>Released. ' + r.song.musicians + ' musician' + (r.song.musicians > 1 ? 's are' : ' is') + ' on the song.' + (r.mix ? ' ' + esc(r.mix.by) + ' uploaded the mix.' : '') + '</p>' +
    (r.mix ? '<button class="btn btn-sm btn-sound" type="button" data-playmix="' + r.id + '">' + (S.playing === r.id + ':mix' ? '&#10074;&#10074; Stop' : '&#9654; Play the mix') + '</button>' : '') + '</div>';
  html += '</div>' + threadBar(r, open);
  if (open && r.posts.length) html += '<div class="replies" id="replies-' + r.id + '"><div class="rep-ctrls">' + viewToggle(S.tview) + '</div>' +
    (S.tview === 'stacks' ? treeOf(r) : top.map(function (x) { return replyHtml(r, x, 0); }).join('')) + '</div>';
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
var R = { rid:null, pid:null, file:null, buf:null, src:'file' };
var MD = null;
function openScrim(id) { el(id).classList.add('on'); }
function closeScrims() {
  if (RC.state === 'recording' || RC.state === 'asking') rcCancel();
  disarmMonitor();
  if (S.playing === 'reply') { stop(); mdIdle(); render(); }
  var fromStart = el('start-scrim').classList.contains('on');
  [].forEach.call(document.querySelectorAll('.scrim'), function (s) { s.classList.remove('on'); });
  if (fromStart && startFrom && startFrom.focus && document.contains(startFrom)) startFrom.focus();
}
function wantLen(c) { return c[0].dur || 0; }
function openReply(rid, pid) {
  ensureMe(jamCard(riff(rid), 'play')).then(function () { replyPop(rid, pid); });
}
function replyPop(rid, pid) {
  var r = riff(rid); R = { rid:rid, pid:pid || null, file:null, buf:null, src:'file' };
  rcReset(); RC.click = !!r.bpm; RC.countIn = r.bpm ? 1 : 0;
  var c = chainOf(r, pid), used = c.map(function (p) { return p.layer; });
  var pp = pid ? postOf(r, pid) : null;
  el('r-title').textContent = 'Play along with ' + (!pp ? r.title : pp.kind === 'part' ? 'the new part' : whose(pp) + ' ' + lay(pp.layer).label);
  MD = { r:r, c:c, mute:{}, raf:0, dur:wantLen(c) };
  el('r-over').innerHTML = '<div class="md-top"><button class="play" type="button" id="md-play" aria-label="Play what you play on">&#9654;</button>' +
      '<span class="md-time" id="md-time">0:00</span><span class="md-hint">' + (r.bpm ? r.bpm + ' bpm' : 'tempo unknown') + (r.key ? ' · ' + esc(r.key) : '') + (r.sig ? ' · ' + esc(r.sig) : '') + '. Play along first, then add your take.</span></div>' +
    '<div class="md-lanes" id="md-lanes">' + c.map(function (p, i) {
      return '<div class="md-lane"><span class="md-name"><i style="background:' + lay(p.layer).c + '"></i><span><b>' + esc(p.by) + '</b>' + chipLabel(p) + '</span></span>' +
        '<canvas data-md="' + i + '"></canvas><button class="md-m" type="button" data-mdmute="' + i + '" aria-pressed="false" aria-label="Mute">M</button></div>';
    }).join('') +
    '<div class="md-lane you"><span class="md-name"><i style="background:var(--sound)"></i><span><b>You</b><span id="md-you"></span></span></span><div class="md-slot" id="md-slot"><div class="md-empty" id="md-empty">Your take lands here</div></div><span></span></div>' +
    '<div class="md-head" id="md-head" hidden></div></div>';
  el('r-layer').innerHTML = ROLES.map(function (x) { return '<option value="' + x.id + '">' + esc(x.label) + '</option>'; }).join('');
  el('r-layer').value = ROLES.map(function (x) { return x.id; }).filter(function (l) { return used.indexOf(l) < 0; })[0] || 'vocals';
  el('r-err').textContent = ''; el('r-text').value = ''; el('r-file').value = '';
  el('r-len').textContent = MD.dur ? 'Make it ' + mmss(MD.dur) + ' long (' + MD.dur.toFixed(1) + ' s), the length of what you play on.' : '';
  el('r-as').innerHTML = postingAs();
  el('r-go').disabled = false;
  setRSrc('file');
  openScrim('reply-scrim'); mdYou(); mdDraw(); el('r-layer').focus();
  Promise.all(c.map(function (p) { return load(r, p); })).then(mdDraw);
}
function peakOf(buf) { var d = buf.getChannelData(0), pk = 0; for (var i = 0; i < d.length; i++) { var v = Math.abs(d[i]); if (v > pk) pk = v; } return pk; }
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
  if (RC.state === 'recording' || RC.state === 'asking') return;
  if (S.playing === 'reply') { stop(); mdIdle(); render(); return; }
  stop(); render(); S.playing = 'reply';
  el('md-play').innerHTML = '&#10074;&#10074;'; el('md-play').classList.add('on');
  var r = MD.r, a = ac(); a.resume(); var T = a.currentTime + 0.05; MD.gains = {};
  var m = mine(), lanes = MD.c.concat(m ? [{ mine:true, buf:m.buf, amp:m.amp }] : []);
  lanes.forEach(function (p, i) {
    var b = p.buf || bufFor(r, p); if (!b) return;
    if (!p.buf) amped(r, p);
    var src = a.createBufferSource(), g = a.createGain(); src.buffer = b; src.loop = true;
    g.gain.value = MD.mute[i] ? 0 : 1; src.start(T); SRC.push(src); MD.gains[i] = g;
    /* a fresh take with an amp is heard through it live; the file itself stays dry */
    var la = p.mine && p.amp ? liveAmp(a, p.amp, peakOf(b)) : null;
    if (la) { src.connect(la.input); la.output.connect(g); SRC.push({ stop:function () { dropAmp(la); } }); }
    else src.connect(g);
    g.connect(a.destination);
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
/* ---------- record your reply right here ----------
   The same recorder as in the project (rec.js): a count-in and click, the lanes above (unmuted)
   playing from bar 1, your input through an amp for guitar, lead and bass, and the take cut
   to start exactly at bar 1 and run exactly as long as what you play on. */
var RC = { state:'idle', nodes:[], player:[], mics:[], click:false, countIn:0, err:'', warn:'', info:'', done:null, level:0, peak:0 };
function rcRole() { return el('r-layer').value; }
function rcCleanup() {
  clearTimeout(RC.timer); clearInterval(RC.tick);
  RC.player.forEach(function (s) { try { s.stop(); } catch (e) {} });
  RC.player = [];
  RC.nodes.forEach(function (n) { try { n.disconnect(); } catch (e) {} });
  RC.nodes = [];
  if (RC.stream) RC.stream.getTracks().forEach(function (tr) { tr.stop(); });
  RC.stream = null;
}
function rcReset() {
  rcCleanup();
  RC.state = 'idle'; RC.err = ''; RC.warn = ''; RC.info = ''; RC.done = null; RC.chunks = null; RC.partial = 0;
}
function rcCancel() { rcCleanup(); RC.state = 'idle'; RC.chunks = null; rcDraw(); showMine(); }
function rcMicOptions() {
  var cur = savedMic();
  return '<option value="">Default input</option>' + RC.mics.map(function (m, i) {
    return '<option value="' + esc(m.id) + '"' + (m.id === cur ? ' selected' : '') + '>' + esc(m.label || ('Input ' + (i + 1))) + '</option>';
  }).join('');
}
function rcMics() { return listMics().then(function (l) { RC.mics = l; var s = document.querySelector('#r-rec [data-rc="mic"]'); if (s) s.innerHTML = rcMicOptions(); rcFindBtn(); }); }
/* before the browser has been allowed the microphone it only says "default": ask once */
function rcFindBtn() { var b = document.querySelector('#r-rec [data-rc="inputs"]'); if (b) b.hidden = RC.mics.length > 0; }
function rcAmpOptions() {
  var cur = savedAmp();
  return '<option value="">Off, as it comes in</option>' + AMPS.map(function (a) { return '<option value="' + a.id + '"' + (a.id === cur ? ' selected' : '') + '>' + esc(a.label) + '</option>'; }).join('');
}
function rcDraw() {
  var box = el('r-rec'); if (!box || !MD) return;
  var err = RC.err ? '<p class="rc-err">' + esc(RC.err) + '</p>' : '';
  if (RC.state === 'asking' || RC.state === 'recording') {
    box.innerHTML = '<div class="rc-live"><div class="rc-status" id="rc-status">' + (RC.state === 'asking' ? 'Waiting for the microphone...' : '') + '</div>' +
      '<div class="rc-meter"><i id="rc-meter"></i></div>' +
      '<div class="rc-acts"><button class="btn btn-main" type="button" data-rc="finish">Stop and keep it</button>' +
      '<button class="btn btn-sm" type="button" data-rc="cancel">Stop and throw away</button></div>' +
      '<p class="rc-tiny">It stops by itself at the end of the clip. Stop earlier and you keep what you played; the rest of the take is silence.</p></div>';
    rcStatus(); return;
  }
  if (RC.state === 'done' && RC.done) {
    box.innerHTML = '<div class="rc-done"><b>Recorded ' + (RC.partial ? mmss(RC.partial) + ' of ' + mmss(RC.fixed) : mmss(RC.done.buf.duration)) + '</b>' +
      '<span class="rc-tiny">' + (RC.partial ? 'You stopped early. The rest of the take is silence, so it still lines up with the clip.' : 'Cut to start exactly at bar 1 and end with the clip.') + '</span>' +
      '<div class="rc-acts"><button class="btn btn-sm" type="button" data-rc="listen">Hear it with the lanes</button>' +
      '<button class="btn btn-sm" type="button" data-rc="again">Record again</button></div></div>' +
      (RC.info ? '<p class="rc-info">' + esc(RC.info) + '</p>' : '') + (RC.warn ? '<p class="rc-warn">' + esc(RC.warn) + '</p>' : '') + err;
    return;
  }
  var ampOn = AMP_ROLES.indexOf(rcRole()) > -1;
  if (ampOn && savedAmp()) preloadAmp(savedAmp());
  box.innerHTML = '<div class="rc-row">' +
      '<label class="rc-opt"><input type="checkbox" data-rc="click"' + (RC.click ? ' checked' : '') + '><span>Click</span></label>' +
      '<label class="rc-sel"><span>count-in</span><select data-rc="countin">' + [0, 1, 2, 4].map(function (n) {
        return '<option value="' + n + '"' + (n === RC.countIn ? ' selected' : '') + '>' + n + ' bar' + (n === 1 ? '' : 's') + '</option>'; }).join('') + '</select></label>' +
      '<label class="rc-sel"><span>input</span><select data-rc="mic">' + rcMicOptions() + '</select></label>' +
      '<button class="ghost rc-find" type="button" data-rc="inputs"' + (RC.mics.length ? ' hidden' : '') + '>Show my inputs</button>' +
      '<label class="rc-sel" id="rc-amp"' + (ampOn ? '' : ' hidden') + ' title="Recorded dry, heard through this amp. You can change it later."><span>amp</span><select data-rc="amp">' + rcAmpOptions() + '</select></label>' +
      '<label class="rc-opt" title="Hear your input in the headphones right away, through the amp if you picked one. Leave it off if your interface already lets you hear yourself."><input type="checkbox" data-rc="mon"' + (savedMon() ? ' checked' : '') + '><span>Hear yourself</span></label>' +
    '</div>' +
    '<p class="rc-tiny">Wear headphones, otherwise the lanes end up in your take. You hear the lanes above that aren’t muted, from the first beat' +
      (MD.r.bpm ? '' : '. No tempo is known for this clip, so the click runs at 120 bpm') + '. It stops by itself after ' + mmss(MD.dur) + '.</p>' +
    (rateTip(ac()) ? '<p class="rc-tiny" id="rc-rate"' + (ampOn ? '' : ' hidden') + '>' + esc(rateTip(ac())) + '</p>' : '') +
    '<button class="btn btn-main rc-go" type="button" data-rc="start"><span class="rc-dot"></span> Start recording</button>' + err;
}
function rcStatus() {
  var st = el('rc-status'), meter = el('rc-meter');
  if (!st || RC.state !== 'recording') return;
  var a = ac(), now = a.currentTime, bar = RC.bar;
  if (now < RC.songStart) {
    if (now < RC.t0) st.textContent = 'Get ready';
    else { var left = RC.countIn - Math.floor((now - RC.t0) / bar); st.textContent = 'Count-in, ' + left + ' bar' + (left > 1 ? 's' : '') + ' to go'; }
    st.className = 'rc-status counting';
  } else { st.textContent = 'Recording ' + mmss(now - RC.songStart) + ' / ' + mmss(RC.fixed); st.className = 'rc-status live'; }
  if (meter) meter.style.width = Math.min(100, RC.level * 140) + '%';
  var slot = el('md-empty'); if (slot) { slot.classList.add('live'); slot.textContent = now < RC.songStart ? 'Count-in…' : 'Recording…'; }
}
/* "Hear yourself" arms the input: you hear it right away, through the amp for this layer
   (the take itself stays dry), until you untick it or close the pop-up */
function rcArm() {
  armMonitor(ac(), recAmpFor(rcRole()), ac().destination).then(rcMics, function (err) {
    rememberMon(false);
    var c = document.querySelector('#r-rec [data-rc="mon"]'); if (c) c.checked = false;
    RC.err = micError(err); rcDraw();
  });
}
function rcRearm() { if (monitorOn()) rcArm(); }
function rcStart() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { RC.err = 'This browser does not give pages access to a microphone.'; rcDraw(); return; }
  stop(); mdIdle(); render();
  RC.err = ''; RC.warn = ''; RC.info = ''; RC.done = null; RC.state = 'asking'; rcDraw(); showMine();
  var a = ac(); a.resume(); var r = MD.r;
  var loaded = Promise.all(MD.c.map(function (p) { return load(r, p).then(function () { return amped(r, p); }); }));
  Promise.all([openMic(), loaded]).then(function (x) {
    var stream = x[0];
    RC.stream = stream; rcMics();
    return recWorklet(a).then(function () { return { stream:stream, worklet:true }; }, function () { return { stream:stream, worklet:false }; });
  }).then(function (got) {
    if (RC.state !== 'asking') { got.stream.getTracks().forEach(function (tr) { tr.stop(); }); return; }
    var first = bufFor(r, MD.c[0]), len = first ? first.duration : MD.dur;
    if (!len) throw new Error('The clip could not be loaded, so there is nothing to play along with. Reload the page and try again.');
    var bi = beatInfoFor(r.bpm, r.sig), countIn = RC.countIn;
    var t0 = a.currentTime + 0.4, songStart = t0 + countIn * bi.bar, chunks = [];
    RC.t0 = t0; RC.songStart = songStart; RC.countIn = countIn; RC.fixed = len; RC.bar = bi.bar; RC.beat = bi; RC.level = 0; RC.peak = 0; RC.inLat = inputLatency(got.stream);
    var cap = capture(a, got.stream, got.worklet, function (d, t, sr) {
      var bp = blockPeaks(d);
      RC.level = Math.max(bp.peak, RC.level * 0.85);
      if (t >= songStart && bp.peak > RC.peak) RC.peak = bp.peak;
      chunks.push({ t:t, d:d, dur:d.length / sr });
    });
    var mg = a.createGain(); mg.connect(a.destination);
    RC.nodes = cap.nodes.concat([mg]);
    if (savedMon() && !monitorOn()) rcArm();
    if (RC.click) {
      var cs = a.createBufferSource(), cb = a.createBuffer(1, Math.ceil((countIn * bi.bar + len + 0.05) * a.sampleRate), a.sampleRate);
      cb.copyToChannel(clickSamples(a.sampleRate, countIn, len, bi).subarray(0, cb.length), 0);
      cs.buffer = cb; cs.connect(mg); cs.start(t0); RC.player.push(cs);
    }
    /* the lanes above, from bar 1 (the ones you muted stay silent) */
    MD.c.forEach(function (p, i) {
      var b = bufFor(r, p); if (!b || MD.mute[i]) return;
      var s = a.createBufferSource(); s.buffer = b; s.connect(mg); s.start(songStart); RC.player.push(s);
    });
    RC.chunks = chunks; RC.state = 'recording';
    RC.tick = setInterval(rcStatus, 100);
    RC.timer = setTimeout(rcFinish, (songStart + len - a.currentTime + 0.25) * 1000);
    rcDraw();
  }).catch(function (err) {
    rcCleanup(); RC.state = 'idle';
    RC.err = err && /clip could not/.test(err.message || '') ? err.message : micError(err);
    rcDraw(); showMine();
  });
}
/* Stopping early keeps what was played: the take still runs the full length of the clip, and
   everything after the stop is silence. */
function rcFinish() {
  if (RC.state !== 'recording') return;
  var a = ac(), sr = a.sampleRate;
  var lat = (a.outputLatency || 0) + (a.baseLatency || 0) + (RC.inLat || 0);
  var played = Math.max(0, a.currentTime - RC.songStart), len = RC.fixed;
  rcCleanup();
  if (played < 0.5) {
    RC.state = 'idle'; RC.err = played === 0 ? 'Nothing was recorded yet, the count-in was still running.' : 'That was too short to keep.';
    rcDraw(); showMine(); return;
  }
  RC.partial = played < len - 0.25 ? played : 0;
  var made = assembleTake({ chunks:RC.chunks, sr:sr, t0:RC.t0, songStart:RC.songStart, lat:lat, len:len, countIn:RC.countIn, click:RC.click, beat:RC.beat });
  var buf = a.createBuffer(1, made.out.length, sr); buf.copyToChannel(made.out, 0);
  RC.warn = quietNote(RC.peak, !!recAmpFor(rcRole()), rcRole()) || (made.bleed ? bleedNote(made.bleed) : '');
  RC.done = { buf:buf, file:new File([encodeWav(buf)], 'recorded take.wav', { type:'audio/wav' }) };
  RC.chunks = null; RC.state = 'done';
  rcDraw(); showMine();
}
/* what the take on offer is: the uploaded file, or the recording, whichever tab is open */
function mine() {
  if (R.src === 'rec') return RC.done ? { file:RC.done.file, buf:RC.done.buf, amp:recAmpFor(rcRole()) } : null;
  return R.file && R.buf ? { file:R.file, buf:R.buf, amp:'' } : null;
}
function showMine() {
  var slot = el('md-slot'); if (!slot) return;
  var m = mine();
  if (!m) {
    var live = R.src === 'rec' && (RC.state === 'recording' || RC.state === 'asking');
    slot.innerHTML = '<div class="md-empty' + (live ? ' live' : '') + '" id="md-empty">' + (live ? 'Recording…' : 'Your take lands here') + '</div>'; return;
  }
  slot.innerHTML = '<canvas id="md-mine"></canvas>';
  waveShape(el('md-mine'), m.buf, getComputedStyle(document.documentElement).getPropertyValue('--sound').trim());
}
function setRSrc(src) {
  if (src === 'file' && (RC.state === 'recording' || RC.state === 'asking')) rcCancel();
  if (src === 'file') disarmMonitor();
  R.src = src;
  [].forEach.call(document.querySelectorAll('[data-rsrc]'), function (b) { b.setAttribute('aria-selected', String(b.dataset.rsrc === src)); });
  el('r-src-file').hidden = src !== 'file'; el('r-src-rec').hidden = src !== 'rec';
  if (S.playing === 'reply') { stop(); mdIdle(); render(); }
  if (src === 'rec') { rcDraw(); rcMics(); if (savedMon()) rcArm(); }
  showMine();
  el('r-err').textContent = '';
}
document.addEventListener('click', function (e) {
  var t = e.target.closest('[data-rsrc]');
  if (t) { setRSrc(t.dataset.rsrc); return; }
  var b = e.target.closest('#r-rec [data-rc]'); if (!b) return;
  var w = b.dataset.rc;
  if (w === 'start') rcStart();
  else if (w === 'finish') rcFinish();
  else if (w === 'cancel') rcCancel();
  else if (w === 'again') { rcReset(); rcDraw(); showMine(); }
  else if (w === 'listen') mdPlay();
  else if (w === 'inputs') allowInputs().then(function () { rcMics(); }, function (err) { RC.err = micError(err); rcDraw(); });
});
el('r-rec').addEventListener('change', function (e) {
  var t = e.target, w = t.dataset && t.dataset.rc;
  if (w === 'click') RC.click = t.checked;
  else if (w === 'countin') RC.countIn = +t.value;
  else if (w === 'mic') { rememberMic(t.value); rcRearm(); }
  else if (w === 'amp') { rememberAmp(t.value); if (t.value) preloadAmp(t.value); rcRearm(); }
  else if (w === 'mon') { rememberMon(t.checked); if (t.checked) rcArm(); else disarmMonitor(); }
});
el('r-layer').addEventListener('change', function () {
  mdYou();
  var l = el('rc-amp'); if (l) l.hidden = AMP_ROLES.indexOf(rcRole()) < 0;
  var rt = el('rc-rate'); if (rt) rt.hidden = AMP_ROLES.indexOf(rcRole()) < 0;
  rcRearm();
});
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
  showMine();
  if (!f) return;
  f.arrayBuffer().then(function (ab) { return ac().decodeAudioData(ab); }).then(function (b) {
    var want = MD.dur;
    if (want && Math.abs(b.duration - want) > TOL) {
      el('r-err').textContent = 'That take is ' + b.duration.toFixed(1) + ' s, it has to be ' + want.toFixed(1) + ' s (the length of what you play on). Trim it and try again.';
      return;
    }
    R.file = f; R.buf = b;
    showMine();
  }).catch(function () { el('r-err').textContent = 'That file could not be read. Try a wav or mp3.'; });
});
el('r-go').addEventListener('click', function () {
  var m = mine();
  if (!m) { el('r-err').textContent = el('r-err').textContent || (R.src === 'rec' ? 'Record your take first, or upload a file.' : 'Pick your take first, an audio file of the right length.'); return; }
  var r = riff(R.rid), pp = R.pid ? postOf(r, R.pid) : null, file = m.file, buf = m.buf, ampId = m.amp;
  var section = !pp ? null : pp.kind === 'part' ? pp.id : pp.section || null;
  var replyTo = pp && pp.kind !== 'part' ? pp.id : null;
  el('r-go').disabled = true; el('r-err').textContent = 'Uploading…';
  ensureMe('play').then(function (u) {
    var path = r.id + '/' + u.id + '/' + crypto.randomUUID() + '.' + extOf(file.name), type = typeFor(file);
    return db.uploadAudio(path, file, type).then(function () {
      var row = { session_id:r.id, author_id:u.id, author_name:db.accountName(u), role_id:el('r-layer').value, note:el('r-text').value.trim(),
        status:'waiting', storage_path:path, file_name:file.name, mime_type:type, duration_sec:buf.duration, section_id:section, reply_to:replyTo,
        on_takes:section ? null : chainOf(r, R.pid).filter(function (x) { return !x.isRiff && !x.isPart; }).map(function (x) { return x.dbId || x.id; }) };
      if (ampId) row.amp = ampId;
      /* without the amp migration the take still goes in, just without its amp (as in the project) */
      return db.insertTake(row).catch(function (e) {
        if (!row.amp || !/amp/.test(String(e && (e.message || e.details)))) throw e;
        delete row.amp;
        return db.insertTake(row);
      });
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
/* "Start a jam" is the band under the feed, and the same band in a pop-up for the buttons at
   the top. Both instrument rows show (and set) the same choice: the upload form's layer. */
(function () {
  var pop = el('start').cloneNode(true);
  pop.id = 'start-pop'; pop.classList.add('start-pop');
  pop.setAttribute('aria-labelledby', 'start-pop-h');
  pop.querySelector('h2').id = 'start-pop-h';
  pop.insertAdjacentHTML('afterbegin', '<button class="pop-x" type="button" data-close="start-scrim" aria-label="Close">&times;</button>');
  el('start-scrim').appendChild(pop);
})();
function renderInsts() {
  var html = ROLES.map(function (x) {
    return '<button class="inst" type="button" data-inst="' + x.id + '" aria-pressed="' + (el('up-layer').value === x.id) + '">' +
      '<i style="background:var(' + x.color + ')" aria-hidden="true"></i>' + esc(x.label) + '</button>';
  }).join('');
  [].forEach.call(document.querySelectorAll('[data-insts]'), function (row) { row.innerHTML = html; });
}
renderInsts();
el('up-layer').addEventListener('change', renderInsts);
document.addEventListener('click', function (e) {
  var b = e.target.closest('[data-inst]'); if (!b) return;
  var where = b.closest('#start-scrim') ? '#start-scrim' : '#start';
  el('up-layer').value = b.dataset.inst; renderInsts();
  /* re-rendering replaced the button: keep the focus on the same instrument */
  var same = document.querySelector(where + ' [data-inst="' + b.dataset.inst + '"]');
  if (same) same.focus();
  if (el('picked').hidden) toast(role(b.dataset.inst).label + ' it is. Upload your clip, or record it live.');
});
var startFrom = null;
function openStart() {
  startFrom = document.activeElement;
  openScrim('start-scrim');
  var x = document.querySelector('#start-scrim .inst[aria-pressed="true"]') || document.querySelector('#start-scrim .pop-x');
  if (x) setTimeout(function () { x.focus(); }, 30);
}
/* arriving on /#start opens the pop-up at the top of the page */
function startFromHash() {
  if (location.hash !== '#start') return;
  history.replaceState(null, '', location.pathname + location.search);
  window.scrollTo(0, 0);
  openStart();
}
window.addEventListener('hashchange', startFromHash);
function takeFile(f) {
  if (!f) return;
  el('up-err').textContent = '';
  f.arrayBuffer().then(function (ab) { return ac().decodeAudioData(ab); }).then(function (b) {
    UP = { file:f, buf:b, an:null };
    el('dropzone').hidden = true; el('picked').hidden = false;
    el('up-name').textContent = f.name + ' · ' + b.duration.toFixed(1) + ' s';
    if (!el('up-title').value) el('up-title').value = f.name.replace(/\.[^.]+$/, '');
    el('up-as').innerHTML = postingAs();
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
  var title = el('up-title').value.trim(), f = UP.file, b = UP.buf, an = UP.an;
  if (!title) { el('up-err').textContent = 'Give your jam a name.'; el('up-title').focus(); return; }
  var bpm = +el('up-bpm').value || null, sess = null;
  ensureMe('start').then(function (u) {
    el('up-go').disabled = true; el('up-err').textContent = 'Uploading…';
    return db.createSession(u.id).then(function (s) {
      sess = s;
      var path = s.id + '/' + u.id + '/' + crypto.randomUUID() + '.' + extOf(f.name), type = typeFor(f);
      return db.uploadAudio(path, f, type).then(function () {
        return db.insertTake({ session_id:s.id, author_id:u.id, author_name:db.accountName(u), role_id:'seed', note:el('up-text').value.trim(), status:'seed',
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
  var b = e.target.closest('a[href="#start"], a[href="/#start"]');
  if (b) { e.preventDefault(); openStart(); return; }
  if ((b = e.target.closest('a[href="#feed"]'))) { e.preventDefault(); el('feed').scrollIntoView({ behavior:'smooth', block:'start' }); return; }
  if ((b = e.target.closest('[data-close]'))) { closeScrims(); return; }
  if ((b = e.target.closest('[data-upopen]'))) { closeScrims(); openScrim('up-scrim'); return; }
  if (e.target.classList && e.target.classList.contains('scrim')) { closeScrims(); return; }
  if ((b = e.target.closest('[data-tview]'))) { S.tview = b.dataset.tview; rememberView(S.tview); render(); return; }
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

/* ---------- start ---------- */
render();
startFromHash();
setToast(toast);
var first = true;
/* who is signed in decides your votes, "(you)" and what you can delete: load again when it changes */
onAccount(function (u) {
  var was = me && me.id; me = u;
  ['up-as', 'r-as'].forEach(function (id) { if (el(id)) el(id).innerHTML = postingAs(); });
  if (first || (u && u.id) !== was) { first = false; reload(); } else render();
});

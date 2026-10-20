/* A player's profile, /u/<name>: the jams they started and the ones they played on.
   Readable by everyone (profiles, sessions and takes are public under RLS), so it needs
   no account. On your own profile: Settings, "Copy my link" and where your takes stand. */

import './styles.css';
import './theme.js';
import { onAccount, profileHref, say } from './auth.js';
import { configured } from './supabase.js';
import * as db from './data.js';
import { role, col } from './roles.js';
import { renderAmp } from './amp.js';
import { newContext, fadeIn, fadeOut } from './rec.js';

var P = null;          // { profile, started, played, takes, stacks, names } once loaded
var me = null, tab = 'started', failed = '', missing = '';
var I_PLAY  = '<svg width="14" height="14" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true"><path d="M2 1l6 4-6 4z"/></svg>';
var I_PAUSE = '<svg width="14" height="14" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true"><path d="M2 1h2.6v8H2zM5.4 1H8v8H5.4z"/></svg>';

function el(id) { return document.getElementById(id); }
function esc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function ago(iso) {
  var m = Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return Math.round(m) + ' minute' + (Math.round(m) > 1 ? 's' : '') + ' ago';
  var h = m / 60; if (h < 24) return Math.round(h) + ' hour' + (Math.round(h) > 1 ? 's' : '') + ' ago';
  var d = h / 24; if (d < 2) return 'yesterday';
  if (d < 7) return Math.round(d) + ' days ago';
  if (d < 14) return 'last week';
  return new Date(iso).toLocaleDateString(undefined, { day:'numeric', month:'short', year:'numeric' });
}
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
function mine() { return !!(me && P && P.profile && me.id === P.profile.id); }
/* a name that links to its profile when its author has one */
function who(name, id) {
  var n = P.names[id];
  return n ? '<a class="pf-name" href="' + profileHref(n) + '">' + esc(name || n) + '</a>' : esc(name || 'someone');
}
function seedOf(s) { return P.stacks.filter(function (t) { return t.id === s.seed_take_id; })[0] || null; }
function titleOf(s) {
  if (s.title && s.title !== 'Untitled') return s.title;
  var seed = seedOf(s);
  return seed && seed.author_name ? seed.author_name + '’s track' : 'Untitled';
}
function stackOf(s) { return P.stacks.filter(function (t) { return t.session_id === s.id && t.status === 'in'; }); }
function mixOf(s) {
  var m = P.stacks.filter(function (t) { return t.session_id === s.id && t.status === 'mix'; });
  return m.length ? m.sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); })[0] : null;
}
function label(t) { return role(t.role_id) ? role(t.role_id).label : 'Take'; }
function chip(t, text) {
  var r = role(t.role_id);
  return '<span class="pf-chip"><i style="background:' + (r ? col(r) : 'var(--wild)') + '"></i>' + text + '</span>';
}
function stateOf(t, s) {
  if (t.status === 'in') return s.status === 'released' ? 'in the song' : 'in the stack';
  if (t.status === 'waiting') return mine() ? 'waiting for ' + (seedOf(s) ? esc(seedOf(s).author_name) : 'the creator') : 'waiting';
  if (t.status === 'mix') return 'the mix';
  return 'unused';
}

/* ---------- playing: the original track with its stack, or the mix once there is one ---------- */
var AC = null, BUF = {}, SRC = [], FADE = null, playing = null;
function ac() { if (!AC) AC = newContext(); return AC; }
function decoded(t) {
  if (!BUF[t.id]) BUF[t.id] = fetch(db.publicUrl(t.storage_path))
    .then(function (x) { if (!x.ok) throw new Error(x.status); return x.arrayBuffer(); })
    .then(function (ab) { return ac().decodeAudioData(ab); });
  return BUF[t.id];
}
/* a take with an amp plays its render; until that's ready it isn't heard dry */
function playable(t) {
  return decoded(t).then(function (b) {
    if (!t.amp) return b;
    var k = t.id + '@' + t.amp;
    if (!BUF[k]) BUF[k] = renderAmp(b, t.amp).catch(function (e) { console.warn('Could not render the amp', e); return b; });
    return BUF[k];
  });
}
function stop() { if (SRC.length) fadeOut(ac(), FADE, SRC); SRC = []; FADE = null; playing = null; }
function play(sid) {
  if (playing === sid) { stop(); render(); return; }
  stop(); playing = sid; render();
  var s = P.started.concat(P.played).filter(function (x) { return x.id === sid; })[0];
  var mix = s.status === 'released' ? mixOf(s) : null;
  var list = mix ? [mix] : [seedOf(s)].concat(stackOf(s).filter(function (t) { return !t.section_id && t.role_id !== 'part'; })).filter(Boolean);
  Promise.all(list.map(function (t) { return playable(t).catch(function (e) { console.warn('Could not load audio', e); return null; }); })).then(function (bufs) {
    if (playing !== sid) return;
    var a = ac(); a.resume(); var T = a.currentTime + 0.05, len = 0, fade = FADE = fadeIn(a, T, a.destination);
    bufs.forEach(function (b) {
      if (!b) return;
      var src = a.createBufferSource(); src.buffer = b; src.connect(fade); src.start(T); SRC.push(src);
      len = Math.max(len, b.duration);
    });
    if (!SRC.length) { stop(); render(); say('That jam couldn’t be played. Check your connection and try again.'); return; }
    var last = SRC[SRC.length - 1];
    SRC.forEach(function (x) { if (x.buffer.duration === len) last = x; });
    last.onended = function () { if (playing === sid && SRC.indexOf(last) > -1) { stop(); render(); } };
  });
}

/* ---------- rendering ---------- */
function instruments() {
  var seen = {}, out = [];
  P.takes.map(function (t) { return t.role_id; }).concat(P.started.map(function (s) { return s.seed_role; })).forEach(function (id) {
    var r = id && role(id);
    if (!r || id === 'seed' || id === 'part' || id === 'mix' || seen[id]) return;
    seen[id] = true; out.push(r);
  });
  return out;
}

function hero() {
  var p = P.profile, n = p.username;
  var takes = P.takes.filter(function (t) { return t.role_id !== 'seed'; }).length;
  var since = new Date(p.created_at).toLocaleDateString(undefined, { month:'long', year:'numeric' });
  return '<section class="pf-hero" aria-labelledby="pf-name">' +
    '<div class="pf-who"><span class="pf-av" aria-hidden="true">' + esc(n.charAt(0).toUpperCase()) + '</span>' +
      '<div class="pf-id"><h1 id="pf-name">' + esc(n) + '</h1><p class="muted">On Stakkato since ' + esc(since) + '</p>' +
        (instruments().length ? '<div class="pf-chips">' + instruments().map(function (r) { return '<span class="pf-chip"><i style="background:' + col(r) + '"></i>' + esc(r.label) + '</span>'; }).join('') + '</div>' : '') +
        (mine() ? '<div class="pf-acts"><a class="btn btn-sm" href="/settings">Settings</a><button class="btn btn-sm" type="button" data-copy>Copy my link</button></div>' : '') +
      '</div></div>' +
    '<div class="pf-stats">' +
      '<div class="pf-stat"><b>' + P.started.length + '</b><span>' + (P.started.length === 1 ? 'jam' : 'jams') + ' started</span></div>' +
      '<div class="pf-stat"><b>' + P.played.length + '</b><span>' + (P.played.length === 1 ? 'jam' : 'jams') + ' played on</span></div>' +
      '<div class="pf-stat"><b>' + takes + '</b><span>' + (takes === 1 ? 'take' : 'takes') + '</span></div>' +
    '</div></section>';
}

function card(s, started) {
  var seed = seedOf(s), r = s.seed_role ? role(s.seed_role) : null, released = s.status === 'released', on = playing === s.id;
  var facts = [];
  if (!started && seed) facts.push('by ' + who(seed.author_name, s.host_id));
  else if (r) facts.push(esc(r.label));
  if (s.bpm) facts.push(s.bpm + ' BPM');
  if (s.music_key) facts.push(esc(s.music_key));
  facts.push(released ? 'released ' + esc(ago(s.released_at || s.created_at)) : esc(ago(s.created_at)));
  var body;
  if (started) {
    var stack = stackOf(s), waiting = P.stacks.filter(function (t) { return t.session_id === s.id && t.status === 'waiting'; }).length;
    body = stack.length || waiting
      ? '<div class="pf-row">' + (stack.length ? '<span class="pf-lab">' + (released ? 'In the song:' : 'In the stack:') + '</span>' + stack.map(function (t) { return chip(t, esc(label(t)) + ' · ' + who(t.author_name, t.author_id)); }).join('') : '') +
        (waiting && !released ? '<span class="pf-lab">' + (stack.length ? '+ ' : '') + plural(waiting, 'take', 'takes') + ' to review</span>' : '') + '</div>'
      : '<p class="pf-lab">Nobody has played along yet.</p>';
  } else {
    var theirs = P.takes.filter(function (t) { return t.session_id === s.id && t.role_id !== 'seed'; });
    body = '<div class="pf-row"><span class="pf-lab">' + (mine() ? 'Your takes:' : 'Takes:') + '</span>' +
      theirs.map(function (t) { return chip(t, esc(label(t)) + ' · ' + stateOf(t, s)); }).join('') + '</div>';
  }
  return '<article class="pf-jam">' +
    '<button class="play' + (on ? ' on' : '') + '" type="button" data-play="' + s.id + '" aria-label="' + (on ? 'Stop ' : 'Play ') + esc(titleOf(s)) + '">' + (on ? I_PAUSE : I_PLAY) + '</button>' +
    '<div class="pf-main"><div class="pf-title"><h3>' + esc(titleOf(s)) + '</h3><span class="song-state' + (released ? '' : ' open') + '">' + (released ? 'Released' : 'Open') + '</span></div>' +
      '<p class="pf-facts">' + facts.join(' · ') + '</p>' + body + '</div>' +
    '<a class="btn" href="/s/' + encodeURIComponent(s.slug) + '">Open the project</a>' +
  '</article>';
}

function render() {
  var box = el('profile');
  if (failed) { box.innerHTML = '<p class="song-empty">' + esc(failed) + '</p>'; return; }
  if (missing) {
    document.title = 'Stakkato: nobody plays as ' + missing;
    box.innerHTML = '<section class="pf-none"><h1>Nobody plays as ' + esc(missing) + '</h1>' +
      '<p class="muted">There’s no one on Stakkato with that name. Check the link, or find people through the jams they play on.</p>' +
      '<a class="btn btn-main" href="/">See the jams</a></section>';
    return;
  }
  if (!P) { box.innerHTML = '<p class="song-empty">Loading...</p>'; return; }
  var n = P.profile.username, list = tab === 'started' ? P.started : P.played;
  document.title = n + ' on Stakkato';
  box.innerHTML = hero() +
    '<section class="pf-jams" aria-labelledby="pf-jams-h"><div class="pf-head"><h2 id="pf-jams-h">' + (mine() ? 'Your jams' : esc(n) + '’s jams') + '</h2>' +
      '<div class="seg" role="tablist" aria-label="Which jams">' +
        '<button type="button" role="tab" data-tab="started" aria-selected="' + (tab === 'started') + '">Started · ' + P.started.length + '</button>' +
        '<button type="button" role="tab" data-tab="played" aria-selected="' + (tab === 'played') + '">Played on · ' + P.played.length + '</button></div></div>' +
      (list.length ? list.map(function (s) { return card(s, tab === 'started'); }).join('')
        : '<p class="song-empty">' + (tab === 'started'
          ? (mine() ? 'You haven’t started a jam yet. <a href="/#start">Start one</a>.' : esc(n) + ' hasn’t started a jam yet.')
          : (mine() ? 'You haven’t played on anyone’s jam yet. <a href="/">Find one to play along with</a>.' : esc(n) + ' hasn’t played on anyone’s jam yet.')) + '</p>') +
    '</section>';
}

document.addEventListener('click', function (e) {
  var t = e.target.closest('[data-tab], [data-play], [data-copy]');
  if (!t) return;
  if (t.dataset.tab) { tab = t.dataset.tab; render(); return; }
  if (t.dataset.play) { play(t.dataset.play); return; }
  if (t.hasAttribute('data-copy')) {
    var url = location.origin + profileHref(P.profile.username);
    (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
      .then(function () { say('Your link is copied: ' + url); }, function () { say('Copying didn’t work. Your link is ' + url); });
  }
});

onAccount(function (user) { me = user; if (P) render(); });

var wanted = decodeURIComponent((location.pathname.match(/^\/u\/([^/]+)\/?$/) || [])[1] || '');
if (!configured) {
  failed = 'Supabase is not configured. Copy .env.example to .env.local and fill it in.';
  render();
} else if (!/^[A-Za-z0-9._-]{3,24}$/.test(wanted)) {
  missing = wanted || 'that name';
  render();
} else {
  db.profileByName(wanted).then(function (profile) {
    if (!profile) { missing = wanted; render(); return; }
    return db.loadPlayer(profile.id).then(function (data) {
      var ids = [profile.id];
      data.started.concat(data.played).forEach(function (s) { ids.push(s.host_id); });
      data.stacks.forEach(function (t) { ids.push(t.author_id); });
      return db.profilesFor(ids).then(function (names) {
        P = Object.assign({ profile: profile, names: names }, data);
        /* nothing started but something played on: open on what there is */
        if (!P.started.length && P.played.length) tab = 'played';
        render();
      });
    });
  }).catch(function (e) {
    console.error(e);
    failed = 'Could not load this profile. Check your connection and reload the page.';
    render();
  });
}

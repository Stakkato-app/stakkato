/* The songs page: every session that has an original track, linking to /s/<slug>.
   Read-only; sessions are readable by everyone under RLS, so no sign-in is needed. */

import './styles.css';
import './theme.js';
import { configured } from './supabase.js';
import * as db from './data.js';
import { ico } from './icons.js';
import { role, col } from './roles.js';

var SONGS = null, filter = 'all', failed = '';

function el(id){ return document.getElementById(id); }
function esc(t){ return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function day(iso) {
  return new Date(iso).toLocaleDateString(undefined, { day:'numeric', month:'short', year:'numeric' });
}
function name(s) {
  var by = s.seed && s.seed.author_name;
  if (s.title && s.title !== 'Untitled') return s.title;
  return by ? by + '’s track' : 'Untitled';
}
function layers(s) {
  var n = s.layers && s.layers[0] ? s.layers[0].count : 0;
  return n ? n + ' layer' + (n > 1 ? 's' : '') + ' in' : 'no layers yet';
}

function card(s) {
  var r = s.seed_role ? role(s.seed_role) : null;
  var open = s.status === 'open';
  var facts = [];
  if (s.bpm) facts.push(s.bpm + ' BPM');
  if (s.music_key) facts.push(esc(s.music_key));
  if (s.time_sig) facts.push(esc(s.time_sig));
  return '<a class="songcard" href="/s/' + encodeURIComponent(s.slug) + '">' +
    '<div class="sc-top"><span class="sc-ico" style="background:' + (r ? col(r) : 'var(--sound)') + '" aria-hidden="true">' + ico(r ? r.icon : 'seed', '#FFFFFF') + '</span>' +
      '<div class="sc-name"><b>' + esc(name(s)) + '</b>' +
        '<small>' + (s.seed && s.seed.author_name ? 'by ' + esc(s.seed.author_name) : 'by someone') + (r ? ' · ' + esc(r.label.toLowerCase()) : '') + '</small></div></div>' +
    (facts.length ? '<div class="sc-facts">' + facts.map(function (f) { return '<span>' + f + '</span>'; }).join('') + '</div>' : '') +
    '<div class="sc-foot"><span class="song-state' + (open ? ' open' : '') + '">' + (open ? 'Open' : 'Released') + '</span>' +
      '<span class="muted">' + (open ? 'started ' + day(s.created_at) : 'released ' + day(s.released_at || s.created_at)) + '</span>' +
      '<span class="grow"></span><span class="muted">' + layers(s) + '</span></div>' +
  '</a>';
}

function render() {
  var box = el('songs');
  document.querySelectorAll('.songfilter [data-filter]').forEach(function (b) {
    b.setAttribute('aria-selected', String(b.dataset.filter === filter));
  });
  if (failed) { box.innerHTML = '<p class="song-empty">' + esc(failed) + '</p>'; el('songs-count').textContent = 'not loaded'; return; }
  if (!SONGS) { box.innerHTML = '<p class="song-empty">Loading the songs...</p>'; return; }
  var open = SONGS.filter(function (s) { return s.status === 'open'; }).length;
  el('songs-count').textContent = SONGS.length + ' song' + (SONGS.length === 1 ? '' : 's') + ', ' + open + ' open';
  var list = SONGS.filter(function (s) { return filter === 'all' || s.status === filter; });
  box.innerHTML = list.length ? list.map(card).join('') :
    '<p class="song-empty">' + (SONGS.length ? 'No songs here yet.' : 'No songs yet. <a href="/new">Drop a track</a> to start the first one.') + '</p>';
}

document.querySelectorAll('.songfilter [data-filter]').forEach(function (b) {
  b.addEventListener('click', function () { filter = b.dataset.filter; render(); });
});

if (!configured) {
  failed = 'Supabase is not configured. Copy .env.example to .env.local and fill it in.';
  render();
} else {
  render();
  db.listSongs().then(function (rows) { SONGS = rows; render(); }).catch(function (e) {
    console.error(e);
    failed = 'Could not load the songs. Check your connection and reload the page.';
    render();
  });
}

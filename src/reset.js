/* /reset: setting a new password from the link in the email. The gate (or the homepage,
   in development) has already checked the link, so the person arrives signed in with a
   recovery session, in the hash or in storage; without one there's nothing to change. */

import './styles.css';
import './theme.js';
import { configured } from './supabase.js';
import * as db from './data.js';
import './auth.js';

var box = document.getElementById('reset');

function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function noLink() {
  box.innerHTML = '<div class="acct-card"><div class="acct-head"><h3 id="acct-h">Set a new password</h3>'
    + '<p class="acct-sub">This page needs the link from the email we sent you. It works once, for an hour.</p></div>'
    + '<a class="acct-main acct-go" href="/?auth=forgot">Email me a new link</a></div>';
}

function form(user) {
  box.innerHTML = '<form class="acct-card" id="reset-form" novalidate><div class="acct-head"><h3 id="acct-h">Set a new password</h3>'
    + '<p class="acct-sub">For <b>' + esc(user.email || 'your account') + '</b>. You stay signed in on this device.</p></div>'
    + '<div class="acct-field"><label for="reset-pass">New password</label><div class="acct-pass"><input id="reset-pass" type="password" autocomplete="new-password" aria-describedby="reset-hint"><button class="acct-ghost" type="button" id="reset-show" aria-pressed="false">Show</button></div>'
    + '<p class="acct-hint" id="reset-hint">At least 8 characters.</p></div>'
    + '<p class="acct-err" id="reset-err" role="alert"></p>'
    + '<button class="acct-main acct-go" type="submit" id="reset-go">Save and sign in</button></form>';
  var input = document.getElementById('reset-pass'), hint = document.getElementById('reset-hint');
  function paint(bad) {
    var n = input.value.length;
    hint.className = 'acct-hint' + (bad && n < 8 ? ' bad' : '');
    hint.innerHTML = 'At least 8 characters.' + (n > 0 && n < 8 ? ' <b>' + (8 - n) + ' more to go.</b>' : '');
  }
  input.addEventListener('input', function () { paint(false); });
  document.getElementById('reset-show').addEventListener('click', function () {
    var shown = input.type === 'password';
    input.type = shown ? 'text' : 'password';
    this.textContent = shown ? 'Hide' : 'Show'; this.setAttribute('aria-pressed', String(shown));
  });
  document.getElementById('reset-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var err = document.getElementById('reset-err'), go = document.getElementById('reset-go');
    err.textContent = '';
    if (input.value.length < 8) { paint(true); input.focus(); return; }
    go.disabled = true;
    db.updatePassword(input.value).then(function () {
      location.replace('/?auth=password');
    }).catch(function (x) {
      var m = (x && x.message) || '';
      err.textContent = /different from the old|same/i.test(m) ? 'That’s your old password. Pick a new one.'
        : /session|jwt|expired/i.test(m) ? 'The link has run out. Ask for a new one from the sign-in pop-up.'
        : m || 'Saving didn’t work. Try again in a moment.';
      go.disabled = false;
    });
  });
  setTimeout(function () { input.focus(); }, 30);
}

if (!configured) noLink();
else db.ensureUser().then(function (u) {
  if (location.hash) history.replaceState(null, '', '/reset');
  if (u) form(u); else noLink();
}).catch(function (e) { console.error(e); noLink(); });

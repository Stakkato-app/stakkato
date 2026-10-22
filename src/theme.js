/* Light and dark mode for every page.

   The choice is remembered per browser (localStorage 'stackato:theme'); without one the
   page follows the device setting. A small inline script in each page's <head> sets
   <html data-theme> before the first paint, so the page doesn't flash; this module adds
   the toggle to every [data-theme-toggle] slot and tells the page when the theme changes
   (a 'stackato:theme' event), so canvases can redraw in the new colours. */

import './dark.css';

var KEY = 'stackato:theme';
var SUN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></svg>';
var MOON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z"/></svg>';

function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
function system() { return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
export function theme() { return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'; }

function paint() {
  var dark = theme() === 'dark';
  [].forEach.call(document.querySelectorAll('[data-theme-toggle]'), function (slot) {
    slot.innerHTML = '<button class="theme-tgl" type="button" aria-pressed="' + dark + '" aria-label="' + (dark ? 'Switch to light mode' : 'Switch to dark mode') + '" title="' + (dark ? 'Light mode' : 'Dark mode') + '">' + (dark ? SUN : MOON) + '</button>';
  });
}
function apply(t) {
  document.documentElement.dataset.theme = t;
  paint();
  window.dispatchEvent(new CustomEvent('stackato:theme', { detail: t }));
}

document.addEventListener('click', function (e) {
  if (!e.target.closest || !e.target.closest('.theme-tgl')) return;
  var t = theme() === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(KEY, t); } catch (err) {}
  apply(t);
});
/* a theme picked in another tab, or in the page around an embedded one, applies here too */
window.addEventListener('storage', function (e) { if (e.key === KEY && (e.newValue === 'dark' || e.newValue === 'light')) apply(e.newValue); });
/* follow the device while nobody picked a theme */
if (window.matchMedia) {
  var mq = matchMedia('(prefers-color-scheme: dark)');
  var follow = function () { if (!stored()) apply(system()); };
  if (mq.addEventListener) mq.addEventListener('change', follow); else if (mq.addListener) mq.addListener(follow);
}
if (!document.documentElement.dataset.theme) document.documentElement.dataset.theme = stored() || system();
paint();

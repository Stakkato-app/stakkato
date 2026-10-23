/* A take's waveform, saved on the take (takes.peaks), so a page can draw it without
   downloading the audio. Shared by every page and by scripts/backfill-peaks.mjs, so the
   browser and the backfill make the same thing.

   COLS columns over the whole take; each is the highest and the lowest sample of the first
   channel in that stretch, scaled to the take's loudest sample and kept as one byte each
   (hi, then lo as a positive number), base64. 1000 columns are 2000 bytes, 2668 characters.
   The widest waveform on the homepage is about 1370 px (the feed is 1760 px at most); drawn
   from 1000 columns it looks the same as drawn from the audio. */

export var COLS = 1000;

/* d: the first channel's samples (AudioBuffer.getChannelData(0)) */
export function encodePeaks(d, n) {
  n = n || COLS;
  var step = d.length / n, hi = new Float32Array(n), lo = new Float32Array(n), peak = 0, x, i;
  for (x = 0; x < n; x++) {
    var a = Math.floor(x * step), z = Math.min(d.length, Math.floor((x + 1) * step)), mx = 0, mn = 0;
    for (i = a; i < z; i++) { var v = d[i]; if (v > mx) mx = v; else if (v < mn) mn = v; }
    hi[x] = mx; lo[x] = mn; if (mx > peak) peak = mx; if (-mn > peak) peak = -mn;
  }
  var s = '';
  for (x = 0; x < n; x++) {
    s += String.fromCharCode(peak ? Math.min(255, Math.round(hi[x] / peak * 255)) : 0,
                             peak ? Math.min(255, Math.round(-lo[x] / peak * 255)) : 0);
  }
  return btoa(s);
}
/* from an AudioBuffer; null when there is nothing to measure */
export function peaksOfBuffer(buf) {
  try { return buf && buf.length ? encodePeaks(buf.getChannelData(0)) : null; } catch (e) { return null; }
}

/* { hi, lo, peak }: hi from 0 to 1, lo from -1 to 0 (the shape minMaxOf() in app.js makes) */
var CACHE = {};
export function decodePeaks(s) {
  if (!s) return null;
  if (CACHE[s]) return CACHE[s];
  try {
    var b = atob(s), n = b.length >> 1, hi = new Float32Array(n), lo = new Float32Array(n);
    for (var x = 0; x < n; x++) { hi[x] = b.charCodeAt(2 * x) / 255; lo[x] = -b.charCodeAt(2 * x + 1) / 255; }
    return n ? (CACHE[s] = { hi:hi, lo:lo, peak:1 }) : null;
  } catch (e) { return null; }
}

/* the highest and lowest value for each of `cols` pixel columns, from decoded peaks */
export function columns(pk, cols) {
  var n = pk.hi.length, hi = new Array(cols), lo = new Array(cols);
  for (var x = 0; x < cols; x++) {
    var a = Math.floor(x * n / cols), z = Math.max(a + 1, Math.floor((x + 1) * n / cols)), mx = 0, mn = 0;
    for (var j = a; j < z && j < n; j++) { if (pk.hi[j] > mx) mx = pk.hi[j]; if (pk.lo[j] < mn) mn = pk.lo[j]; }
    hi[x] = mx; lo[x] = mn;
  }
  return { hi:hi, lo:lo };
}

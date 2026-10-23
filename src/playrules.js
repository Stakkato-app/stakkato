/* The rules for a take's compressed copy (takes.play_path), shared by the browser
   (src/playcopy.js) and scripts/make-play-copies.mjs, so both make the same copy. */

export var STEREO_KBPS = 160, MONO_KBPS = 96;
export var EXT = 'ogg', TYPE = 'audio/ogg';
var LOSSY = /^audio\/(mpeg|mp3|mp4|x-m4a|m4a|aac|aacp|ogg|opus|webm|x-matroska)/i, LOSSY_EXT = /\.(mp3|m4a|mp4|aac|ogg|oga|opus|webm|weba)$/i;
var MAX_KBPS = 330;

/* the path next to the original's: {session}/{user}/{uuid}.ogg */
export function copyPath(path) { return path.replace(/\.[^./]+$/, '') + '.' + EXT; }

/* already small enough to play as it is */
export function alreadyCompressed(type, name, bytes, seconds) {
  if (!(LOSSY.test(type || '') || LOSSY_EXT.test(name || ''))) return false;
  return !seconds || bytes * 8 / seconds / 1000 <= MAX_KBPS;
}

/* the same in left and right (a mono take sent as stereo): encode one channel */
export function sameChannels(a, b) {
  for (var i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-4) return false;
  return true;
}

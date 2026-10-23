/* A take's compressed copy (takes.play_path): everything that plays downloads it instead of the
   original, which stays for stem downloads. Made in the browser while the take uploads, and by
   scripts/make-play-copies.mjs (ffmpeg, same settings) for takes sent before.

   Ogg Opus, 160 kbps stereo or 96 kbps mono, at 48 kHz. A take whose two channels are the same
   is encoded as mono. No copy is made when the upload is already compressed (MP3, AAC, Opus,
   Vorbis up to about 320 kbps) or when the copy wouldn't be smaller; then the take plays its
   original, as before. Encoding runs in a worker: src/opus-worker.js (WebCodecs) or
   opus-recorder's (libopus in WebAssembly, MIT); either way the page stays free.
   Anything going wrong gives null, and the take is sent with its original only. */

import fallbackUrl from 'opus-recorder/dist/encoderWorker.min.js?url';
import { ogg, readOgg, RATE, FRAME } from './ogg.js';
import { STEREO_KBPS, MONO_KBPS, TYPE, copyPath, alreadyCompressed, sameChannels } from './playrules.js';
export * from './playrules.js';

var APPLE = typeof navigator !== 'undefined' && /Apple/.test(navigator.vendor || '');

/* file: the original (a File or Blob). Resolves to a Blob (audio/ogg) or null. */
export function makePlayCopy(file, seconds) {
  if (alreadyCompressed(file.type, file.name, file.size, seconds)) return Promise.resolve(null);
  return file.arrayBuffer().then(function (ab) {
    var C = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    /* decoding at 48 kHz is the resampling, in the browser's decoder, off the main thread */
    return new C(1, 1, RATE).decodeAudioData(ab);
  }).then(function (buf) {
    var chans = [buf.getChannelData(0)];
    if (buf.numberOfChannels > 1 && !sameChannels(buf.getChannelData(0), buf.getChannelData(1))) chans.push(buf.getChannelData(1));
    var bitrate = (chans.length > 1 ? STEREO_KBPS : MONO_KBPS) * 1000;
    /* Safari's AudioEncoder (Apple's own Opus) cuts the lows like a speech encoder: on a bass DI,
       2 dB less under 60 Hz and the low end's phase moved, at a lower bitrate than asked. So Apple
       browsers (iOS ones too, all WebKit) use opus-recorder's libopus, the same encoder as ffmpeg,
       which is fast there; the others use WebCodecs, which is much faster than the library in
       Firefox. Either falls back to the other. The worker gets copies, so the fallback still has
       the samples. */
    var first = APPLE ? viaLibrary : viaWebCodecs, then = APPLE ? viaWebCodecs : viaLibrary;
    return first(chans.map(function (c) { return c.slice(0); }), bitrate).catch(function (e) {
      console.warn('Encoding the compressed copy again with the other encoder:', e);
      return then(chans, bitrate);
    });
  }).then(function (bytes) {
    if (!bytes || bytes.length >= file.size) return null;
    return new Blob([bytes], { type:TYPE });
  }).catch(function (e) {
    console.warn('No compressed copy, the take plays its original:', e);
    return null;
  });
}

export function viaWebCodecs(chans, bitrate) {
  return new Promise(function (resolve, reject) {
    var w = new Worker(new URL('./opus-worker.js', import.meta.url), { type:'module' });
    w.onmessage = function (e) { w.terminate(); if (e.data.ogg) resolve(e.data.ogg); else reject(new Error(e.data.error)); };
    w.onerror = function (e) { w.terminate(); reject(e); };
    w.postMessage({ channels:chans, bitrate:bitrate }, chans.map(function (c) { return c.buffer; }));
  });
}

/* opus-recorder (libopus in WebAssembly). Its own file is 73 ms early and 60 ms too long in every
   browser: its head says a pre-skip of 3840 samples and its last page doesn't end where the take
   does. Its real delay is 336 samples (libopus' 312 and 24 of its resampler, measured with a
   click track), so its packets are written into a new file with that and the take's length. */
var LIB_DELAY = 336;
export function viaLibrary(chans, bitrate) {
  return new Promise(function (resolve, reject) {
    var w = new Worker(fallbackUrl), pages = [], size = 0, len = chans[0].length;
    var timer = setTimeout(function () { w.terminate(); reject(new Error('the encoder took too long')); }, 120000);
    function end(err) { clearTimeout(timer); w.terminate(); if (err) reject(err); }
    w.onerror = function (e) { end(e); };
    w.onmessage = function (e) {
      var d = e.data;
      if (d.message === 'ready') {
        w.postMessage({ command:'getHeaderPages' });
        for (var at = 0; at < len; at += 4096) w.postMessage({ command:'encode', buffers:chans.map(function (c) { return c.slice(at, at + 4096); }) });
        /* silence after the take, or it drops the last part of a frame */
        w.postMessage({ command:'encode', buffers:chans.map(function () { return new Float32Array(4096); }) });
        w.postMessage({ command:'done' });
      } else if (d.message === 'page') {
        pages.push(d.page); size += d.page.length;
      } else if (d.message === 'done') {
        var out = new Uint8Array(size), o = 0;
        pages.forEach(function (p) { out.set(p, o); o += p.length; });
        end();
        try {
          var r = readOgg(out);
          if (r.packets.length * FRAME < LIB_DELAY + len) throw new Error('the encoder gave too little audio');
          resolve(ogg(r.packets, r.nch, LIB_DELAY, len));
        } catch (err) { reject(err); }
      }
    };
    w.postMessage({ command:'init', encoderSampleRate:RATE, originalSampleRate:RATE, numberOfChannels:chans.length,
      encoderApplication:2049, encoderFrameSize:20, encoderBitRate:bitrate, encoderComplexity:10, maxFramesPerPage:50, resampleQuality:3, bufferLength:4096 });
  });
}

/* Makes the copy and uploads it next to the original (path: the original's), with the same
   year-long cache. Resolves to the copy's path for takes.play_path, or null when there is no
   copy; never rejects, so the take is always sent, with its original only if need be.
   upload: data.js' uploadAudio(path, file, type). */
export function sendPlayCopy(upload, path, file, seconds) {
  return makePlayCopy(file, seconds).then(function (blob) {
    if (!blob) return null;
    var to = copyPath(path);
    return upload(to, blob, TYPE).then(function () { return to; });
  }).catch(function (e) {
    console.warn('The compressed copy could not be uploaded, the take plays its original:', e);
    return null;
  });
}

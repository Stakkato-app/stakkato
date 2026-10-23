/* Encodes a take's compressed copy (takes.play_path) off the main thread: Opus through WebCodecs'
   AudioEncoder, put in an Ogg file by hand. Started by src/playcopy.js, which falls back to the
   opus-recorder library where a browser has no AudioEncoder.

   In:  { channels: [Float32Array, ...] at 48 kHz, bitrate }
   Out: { ogg: Uint8Array } or { error }

   Ogg Opus keeps takes lined up to the sample: the head says how many samples the decoder drops
   at the start (pre-skip, the encoder's look-ahead), and the last page's granule position says
   where the audio ends, so a decoded copy is exactly as long as the original and starts on the
   same sample (checked in Chrome, Safari's WebKit and Firefox; see the PR that added this). */

import { ogg, RATE, FRAME } from './ogg.js';

self.onmessage = function (e) {
  encode(e.data.channels, e.data.bitrate).then(function (ogg) {
    self.postMessage({ ogg:ogg }, [ogg.buffer]);
  }, function (err) {
    self.postMessage({ error:String(err && err.message || err) });
  });
};

function encode(chans, bitrate) {
  if (typeof AudioEncoder === 'undefined') return Promise.reject(new Error('no AudioEncoder'));
  var nch = chans.length, len = chans[0].length;
  var cfg = { codec:'opus', sampleRate:RATE, numberOfChannels:nch, bitrate:bitrate, opus:{ frameDuration:20000, application:'audio', signal:'music', complexity:10 }, bitrateMode:'variable' };
  return AudioEncoder.isConfigSupported(cfg).then(function (s) {
    if (!s.supported) throw new Error('opus is not supported');
    return new Promise(function (resolve, reject) {
      var packets = [], head = null, failed = null;
      var enc = new AudioEncoder({
        output: function (chunk, meta) {
          if (meta && meta.decoderConfig && meta.decoderConfig.description && !head) head = new Uint8Array(toBuf(meta.decoderConfig.description));
          var b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); packets.push(b);
        },
        error: function (err) { failed = err; }
      });
      enc.configure(cfg);
      /* the encoder's own look-ahead; a browser that says it in an OpusHead is believed, otherwise
         libopus' 6.5 ms at 48 kHz (what Chrome, Firefox and Safari report) */
      var pad = 1920, total = len + pad, at = 0, STEP = RATE; /* a second at a time */
      while (at < total) {
        var n = Math.min(STEP, total - at), data = new Float32Array(n * nch);
        for (var c = 0; c < nch; c++) {
          /* planar: one channel after the other; the tail past the take is silence, so the end
             isn't cut short by the look-ahead */
          var src = chans[c].subarray(Math.min(at, len), Math.min(at + n, len));
          data.set(src, c * n);
        }
        enc.encode(new AudioData({ format:'f32-planar', sampleRate:RATE, numberOfFrames:n, numberOfChannels:nch, timestamp:Math.round(at / RATE * 1e6), data:data }));
        at += n;
      }
      enc.flush().then(function () {
        enc.close();
        if (failed) throw failed;
        var skip = preSkipOf(head);
        if (packets.length * FRAME < skip + len) throw new Error('the encoder gave too little audio');
        resolve(ogg(packets, nch, skip, len));
      }).catch(reject);
    });
  });
}

function toBuf(d) { return d instanceof ArrayBuffer ? d : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength); }
/* an OpusHead: "OpusHead", version, channels, pre-skip (u16 LE), ... */
function preSkipOf(h) {
  if (h && h.length >= 12 && String.fromCharCode.apply(null, h.subarray(0, 8)) === 'OpusHead') return h[10] | (h[11] << 8);
  return 312;
}

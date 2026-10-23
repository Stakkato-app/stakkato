/* Ogg Opus, written and read by hand: src/opus-worker.js puts WebCodecs' packets in a file, and
   src/playcopy.js re-writes opus-recorder's file with the right pre-skip and end.

   packets: Opus packets of 20 ms (FRAME samples at 48 kHz); skip: the encoder's delay in samples
   (the decoder drops that many at the start); len: the take's length in samples at 48 kHz (the
   decoder stops there, dropping the padding of the last packet). */

export var RATE = 48000, FRAME = 960;


export function ogg(packets, nch, skip, len) {
  var serial = (Math.random() * 0x7fffffff) | 0, seq = 0, pages = [];
  var oh = new Uint8Array(19), dv = new DataView(oh.buffer);
  oh.set(ascii('OpusHead')); oh[8] = 1; oh[9] = nch; dv.setUint16(10, skip, true); dv.setUint32(12, RATE, true); dv.setInt16(16, 0, true); oh[18] = 0;
  pages.push(page([oh], 0, 2));
  var vendor = ascii('stakkato'), tags = new Uint8Array(8 + 4 + vendor.length + 4), tv = new DataView(tags.buffer);
  tags.set(ascii('OpusTags')); tv.setUint32(8, vendor.length, true); tags.set(vendor, 12); tv.setUint32(12 + vendor.length, 0, true);
  pages.push(page([tags], 0, 0));
  /* granule positions count decoded samples, pre-skip included; the last page's ends the audio
     where the original ends, and the decoder drops the encoder's padding after it */
  var end = skip + len, done = 0, cur = [], segs = 0;
  for (var i = 0; i < packets.length; i++) {
    var p = packets[i], ps = Math.floor(p.length / 255) + 1;
    if (cur.length && (segs + ps > 255 || cur.length >= 50)) { pages.push(page(cur, Math.min(done, end), 0)); cur = []; segs = 0; }
    cur.push(p); segs += ps; done += FRAME;
    if (done >= end) break; /* everything after the end is padding */
  }
  pages.push(page(cur, end, 4));
  var size = 0; pages.forEach(function (x) { size += x.length; });
  var out = new Uint8Array(size), o = 0;
  pages.forEach(function (x) { out.set(x, o); o += x.length; });
  return out;

  function page(list, granule, flags) {
    var lace = [], body = 0;
    list.forEach(function (p) { var n = p.length; while (n >= 255) { lace.push(255); n -= 255; } lace.push(n); body += p.length; });
    var h = new Uint8Array(27 + lace.length + body), v = new DataView(h.buffer);
    h.set(ascii('OggS')); h[4] = 0; h[5] = flags;
    v.setUint32(6, granule % 0x100000000, true); v.setUint32(10, Math.floor(granule / 0x100000000), true);
    v.setUint32(14, serial, true); v.setUint32(18, seq++, true); v.setUint32(22, 0, true);
    h[26] = lace.length; h.set(lace, 27);
    var o = 27 + lace.length;
    list.forEach(function (p) { h.set(p, o); o += p.length; });
    v.setUint32(22, crc(h), true);
    return h;
  }
}

function ascii(s) { var a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }

var TABLE = null;
function crc(b) {
  if (!TABLE) {
    TABLE = new Uint32Array(256);
    for (var i = 0; i < 256; i++) { var r = i << 24; for (var j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1; TABLE[i] = r >>> 0; }
  }
  var c = 0;
  for (var k = 0; k < b.length; k++) c = ((c << 8) ^ TABLE[((c >>> 24) ^ b[k]) & 255]) >>> 0;
  return c;
}

/* the packets of an Ogg Opus file, its OpusHead's pre-skip and channels */
export function readOgg(b) {
  var o = 0, packets = [], cur = [], head = null;
  while (o + 27 <= b.length && b[o] === 0x4f && b[o + 1] === 0x67) {
    var ns = b[o + 26], lace = b.subarray(o + 27, o + 27 + ns), p = o + 27 + ns;
    for (var i = 0; i < ns; i++) {
      cur.push(b.subarray(p, p + lace[i])); p += lace[i];
      if (lace[i] < 255) { packets.push(join(cur)); cur = []; }
    }
    o = p;
  }
  if (!packets.length) throw new Error('not an Ogg file');
  head = packets.shift(); packets.shift(); /* OpusHead, OpusTags */
  return { packets:packets, nch:head[9], skip:head[10] | (head[11] << 8) };
}
function join(list) {
  if (list.length === 1) return list[0].slice();
  var n = 0; list.forEach(function (x) { n += x.length; });
  var out = new Uint8Array(n), o = 0;
  list.forEach(function (x) { out.set(x, o); o += x.length; });
  return out;
}

#!/usr/bin/env node
/* One-off: make the compressed copy (takes.play_path) for takes sent before the browser made it.

   Run it on your own machine, never in the app. It needs ffmpeg with libopus (brew install
   ffmpeg) and the service role key, which bypasses RLS: keep it in your shell, never in the repo
   or in a VITE_ variable.

     SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... node scripts/make-play-copies.mjs --dry-run
     SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... node scripts/make-play-copies.mjs

   The copy is what the browser makes (src/playrules.js): Ogg Opus at 48 kHz, 160 kbps stereo or
   96 kbps mono (a take whose two channels are the same is mono), next to the original as
   {session}/{user}/{uuid}.ogg with a year-long cache. ffmpeg's libopus encodes; its packets are
   written into a new file by src/ogg.js with the take's exact length, as in the browser.
   No copy for files that are already compressed or when the copy isn't smaller.

   Only takes without play_path are touched, so running it again picks up where it stopped.
   Deleted takes and takes of deleted jams are skipped. --dry-run downloads nothing: it lists
   what it would convert, with sizes from Storage, and writes nothing. --limit N stops after N. */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { ogg, readOgg, RATE } from '../src/ogg.js';
import { STEREO_KBPS, MONO_KBPS, TYPE, copyPath, alreadyCompressed, sameChannels } from '../src/playrules.js';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const li = args.indexOf('--limit');
const LIMIT = li > -1 ? +args[li + 1] : Infinity;

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your environment first.');
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'copies-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

function run(argv, input) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', argv);
    const out = [], err = [];
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => err.push(d));
    ff.on('error', reject);
    ff.on('close', (code) => code ? reject(new Error('ffmpeg: ' + Buffer.concat(err).toString().trim())) : resolve(Buffer.concat(out)));
    if (input) ff.stdin.end(input); else ff.stdin.end();
  });
}

function channels(file) {
  return new Promise((resolve, reject) => {
    const fp = spawn('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0', file]);
    const out = [];
    fp.stdout.on('data', (d) => out.push(d));
    fp.on('error', reject);
    fp.on('close', (code) => code ? reject(new Error('ffprobe could not read the file')) : resolve(+Buffer.concat(out).toString().trim() || 1));
  });
}

/* the first two channels at 48 kHz as 32-bit floats, as the browser's decodeAudioData at 48 kHz
   gives them (no mixing: ffmpeg's -ac would turn a mono file 3 dB down). From a file, not a pipe:
   only then does ffmpeg trim an mp3's encoder padding as browsers do. */
async function decode(bytes) {
  const file = path.join(TMP, 'take');
  fs.writeFileSync(file, bytes);
  const nch = await channels(file);
  const b = await run(['-v', 'error', '-i', file, '-ar', String(RATE), '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1']);
  const all = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
  const n = Math.floor(all.length / nch), l = new Float32Array(n);
  for (let i = 0; i < n; i++) l[i] = all[i * nch];
  if (nch < 2) return [l];
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) r[i] = all[i * nch + 1];
  /* a mono take sent as stereo is encoded as mono */
  return sameChannels(l, r) ? [l] : [l, r];
}

async function encode(chans) {
  const nch = chans.length, len = chans[0].length, pcm = new Float32Array(len * nch);
  for (let i = 0; i < len; i++) for (let c = 0; c < nch; c++) pcm[i * nch + c] = chans[c][i];
  const kbps = nch > 1 ? STEREO_KBPS : MONO_KBPS;
  const b = await run(['-v', 'error', '-f', 'f32le', '-ar', String(RATE), '-ac', String(nch), '-i', 'pipe:0',
    '-c:a', 'libopus', '-b:a', kbps + 'k', '-vbr', 'on', '-application', 'audio', '-frame_duration', '20', '-compression_level', '10', '-f', 'ogg', 'pipe:1'],
    Buffer.from(pcm.buffer));
  const r = readOgg(new Uint8Array(b.buffer, b.byteOffset, b.length));
  return ogg(r.packets, r.nch, r.skip, len);
}

async function all(q) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q().range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

/* sizes from Storage's listing of each folder, so the dry run downloads nothing */
const SIZES = new Map();
async function sizeOf(p) {
  const dir = p.slice(0, p.lastIndexOf('/'));
  if (!SIZES.has(dir)) {
    const m = new Map();
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await db.storage.from('takes').list(dir, { limit: 1000, offset });
      if (error) throw error;
      data.forEach((o) => m.set(dir + '/' + o.name, o.metadata && o.metadata.size || 0));
      if (data.length < 1000) break;
    }
    SIZES.set(dir, m);
  }
  return SIZES.get(dir).get(p) || 0;
}

async function todo() {
  const live = new Set((await all(() => db.from('sessions').select('id').is('deleted_at', null).order('id'))).map((s) => s.id));
  const rows = await all(() => db.from('takes').select('id, session_id, storage_path, file_name, mime_type, duration_sec, status')
    .is('play_path', null).neq('status', 'deleted').order('created_at'));
  const out = [];
  for (const t of rows) {
    if (!live.has(t.session_id) || !t.storage_path) continue;
    t.size = await sizeOf(t.storage_path);
    if (!t.size) { console.warn('skipped ' + t.id + ': no file at ' + t.storage_path); continue; }
    if (alreadyCompressed(t.mime_type, t.file_name, t.size, t.duration_sec)) continue;
    out.push(t);
  }
  return out;
}

const rows = (await todo()).slice(0, LIMIT);
const total = rows.reduce((s, t) => s + t.size, 0);
console.log(rows.length + ' take' + (rows.length === 1 ? '' : 's') + ' to convert, ' + (total / 1e6).toFixed(1) + ' MB of originals' + (DRY ? ' (dry run: nothing is downloaded or written)' : ''));
if (DRY) {
  rows.forEach((t) => console.log('would convert ' + t.id + ' ' + t.storage_path + ' (' + (t.size / 1e6).toFixed(1) + ' MB, ' + (t.duration_sec || 0).toFixed(1) + ' s, ' + t.status + ')'));
  process.exit(0);
}
let done = 0, none = 0, failed = 0, before = 0, after = 0;
for (const t of rows) {
  try {
    const { data, error } = await db.storage.from('takes').download(t.storage_path);
    if (error) throw error;
    const ab = Buffer.from(await data.arrayBuffer());
    const copy = await encode(await decode(ab));
    if (copy.length >= ab.length) { none++; console.log('no copy for ' + t.id + ': it would not be smaller'); continue; }
    const to = copyPath(t.storage_path);
    /* upsert: a copy left by a run that stopped before writing play_path is replaced */
    const up = await db.storage.from('takes').upload(to, copy, { contentType: TYPE, upsert: true, cacheControl: '31536000' });
    if (up.error) throw up.error;
    /* .is('play_path', null): a take that got its copy meanwhile keeps it */
    const { error: e } = await db.from('takes').update({ play_path: to }).eq('id', t.id).is('play_path', null);
    if (e) throw e;
    done++; before += ab.length; after += copy.length;
    console.log('wrote ' + to + ' (' + (ab.length / 1e6).toFixed(1) + ' MB → ' + (copy.length / 1e6).toFixed(2) + ' MB)');
  } catch (e) {
    failed++;
    console.warn('skipped ' + t.id + ' ' + t.storage_path + ': ' + (e.message || e));
  }
}
console.log('Converted ' + done + ' (' + (before / 1e6).toFixed(1) + ' MB → ' + (after / 1e6).toFixed(1) + ' MB), no copy for ' + none + ', skipped ' + failed + '.');

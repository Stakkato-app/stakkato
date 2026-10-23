#!/usr/bin/env node
/* One-off: fill takes.peaks for takes sent before the browser saved them.

   Run it on your own machine, never in the app. It needs ffmpeg (brew install ffmpeg) and
   the service role key, which bypasses RLS: keep it in your shell, never in the repo or in
   a VITE_ variable.

     SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... node scripts/backfill-peaks.mjs --dry-run
     SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... node scripts/backfill-peaks.mjs

   Only takes whose peaks are still empty are touched, so running it again picks up where it
   stopped. Deleted takes and takes of deleted jams are skipped. --dry-run downloads and
   measures but writes nothing. --limit N stops after N takes. */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { encodePeaks } from '../src/peaks.js';

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

/* the first channel as 32-bit floats, as decodeAudioData's channel 0. From a file, not a pipe:
   only then does ffmpeg read an mp3's gapless header and trim the encoder padding as browsers do. */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'peaks-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
function decode(bytes) {
  const file = path.join(TMP, 'take');
  fs.writeFileSync(file, bytes);
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-v', 'error', '-i', file, '-af', 'pan=mono|c0=c0', '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1']);
    const out = [], err = [];
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => err.push(d));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code) return reject(new Error('ffmpeg: ' + Buffer.concat(err).toString().trim()));
      const b = Buffer.concat(out);
      resolve(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4)));
    });
  });
}

async function todo() {
  const live = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('sessions').select('id').is('deleted_at', null).range(from, from + 999);
    if (error) throw error;
    data.forEach((s) => live.add(s.id));
    if (data.length < 1000) break;
  }
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('takes').select('id, session_id, storage_path, status')
      .is('peaks', null).neq('status', 'deleted').order('created_at').range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows.filter((t) => live.has(t.session_id) && t.storage_path);
}

const rows = (await todo()).slice(0, LIMIT);
console.log(rows.length + ' take' + (rows.length === 1 ? '' : 's') + ' without peaks' + (DRY ? ' (dry run: nothing is written)' : ''));
let done = 0, failed = 0, bytes = 0;
for (const t of rows) {
  try {
    const { data, error } = await db.storage.from('takes').download(t.storage_path);
    if (error) throw error;
    const ab = Buffer.from(await data.arrayBuffer());
    bytes += ab.length;
    const peaks = encodePeaks(await decode(ab));
    if (!DRY) {
      /* .is('peaks', null): a take that got its peaks meanwhile keeps them */
      const { error: e } = await db.from('takes').update({ peaks }).eq('id', t.id).is('peaks', null);
      if (e) throw e;
    }
    done++;
    console.log((DRY ? 'would write ' : 'wrote ') + t.id + ' (' + (ab.length / 1e6).toFixed(1) + ' MB, ' + peaks.length + ' chars)');
  } catch (e) {
    failed++;
    console.warn('skipped ' + t.id + ' ' + t.storage_path + ': ' + (e.message || e));
  }
}
console.log((DRY ? 'Would fill ' : 'Filled ') + done + ', skipped ' + failed + ', downloaded ' + (bytes / 1e6).toFixed(1) + ' MB.');

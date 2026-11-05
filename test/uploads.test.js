import assert from 'node:assert/strict';
import { mkdtempSync, openAsBlob, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { clearAbandonedUploads } from '../src/uploads.js';
import { HOUR, sampleVideo, startHarness } from './helpers.js';

const CHUNK = 1024 * 1024;

let h;
before(async () => { h = await startHarness(); });
after(async () => { await h.close(); });

const videosDir = () => path.join(h.config.dataDir, 'videos');
const leftovers = () => readdirSync(videosDir()).filter((name) => name.endsWith('.upload'));
const start = (size, fileName = 'clip.mp4') => h.api('/api/uploads', { method: 'POST', body: { fileName, size } });
const complete = (id) => h.api(`/api/uploads/${id}/complete`, { method: 'POST' });

test('the default piece size stays under the 100 MB Cloudflare allows on its Free plan', () => {
  assert.ok(loadConfig({}).upload.chunkBytes < 100_000_000);
});

test('a file sent in several pieces arrives byte for byte', async () => {
  const source = sampleVideo();
  const original = readFileSync(source);
  assert.ok(original.length > CHUNK * 2, 'the sample must span several pieces');

  const { status, data } = await h.upload(source);
  assert.equal(status, 201);
  assert.equal(data.checks.instagram.ok, true);

  const served = Buffer.from(await (await h.fetch(data.video.fileUrl)).arrayBuffer());
  assert.ok(served.equals(original));
  assert.deepEqual(leftovers(), []);
});

test('a piece resent after a lost response does not corrupt the file', async () => {
  const source = sampleVideo();
  const blob = await openAsBlob(source);
  const { data: session } = await start(blob.size);

  const first = blob.slice(0, CHUNK);
  assert.equal((await h.sendChunk(session.id, 0, first)).data.received, CHUNK);
  assert.equal((await h.sendChunk(session.id, 0, first)).data.received, CHUNK, 'resending does not advance');

  const second = blob.slice(CHUNK, CHUNK * 2);
  await h.sendChunk(session.id, CHUNK, second);
  const resent = await h.sendChunk(session.id, CHUNK, second);
  assert.equal(resent.data.received, CHUNK * 2);

  for (let offset = CHUNK * 2; offset < blob.size; offset += CHUNK) {
    await h.sendChunk(session.id, offset, blob.slice(offset, offset + CHUNK));
  }
  const done = await complete(session.id);
  assert.equal(done.status, 201);
  const served = Buffer.from(await (await h.fetch(done.data.video.fileUrl)).arrayBuffer());
  assert.ok(served.equals(readFileSync(source)));
});

test('a piece sent ahead of what is saved is refused, and says where to resume', async () => {
  const { data: session } = await start(CHUNK * 2);
  const res = await h.sendChunk(session.id, CHUNK, Buffer.alloc(10));
  assert.equal(res.status, 409);
  assert.equal(res.data.received, 0);
  await h.api(`/api/uploads/${session.id}`, { method: 'DELETE' });
});

test('a piece over the allowed size is refused', async () => {
  const { data: session } = await start(CHUNK * 4);
  const res = await h.sendChunk(session.id, 0, Buffer.alloc(CHUNK + 1));
  assert.equal(res.status, 413);
  await h.api(`/api/uploads/${session.id}`, { method: 'DELETE' });
});

test('more data than the declared size is refused', async () => {
  const { data: session } = await start(10);
  const res = await h.sendChunk(session.id, 0, Buffer.alloc(20));
  assert.equal(res.status, 413);
  await h.api(`/api/uploads/${session.id}`, { method: 'DELETE' });
});

test('finishing early is refused, and the upload can still continue', async () => {
  const source = sampleVideo();
  const blob = await openAsBlob(source);
  const { data: session } = await start(blob.size);
  await h.sendChunk(session.id, 0, blob.slice(0, CHUNK));

  const early = await complete(session.id);
  assert.equal(early.status, 409);
  assert.equal(early.data.received, CHUNK);

  for (let offset = CHUNK; offset < blob.size; offset += CHUNK) {
    await h.sendChunk(session.id, offset, blob.slice(offset, offset + CHUNK));
  }
  assert.equal((await complete(session.id)).status, 201);
});

test('canceling removes the partial file', async () => {
  const { data: session } = await start(CHUNK * 2);
  await h.sendChunk(session.id, 0, Buffer.alloc(CHUNK));
  assert.equal(leftovers().length, 1);

  assert.equal((await h.api(`/api/uploads/${session.id}`, { method: 'DELETE' })).status, 204);
  assert.deepEqual(leftovers(), []);

  const gone = await h.sendChunk(session.id, CHUNK, Buffer.alloc(10));
  assert.equal(gone.status, 404);
  assert.match(gone.data.error, /no longer available/);
});

test('an upload abandoned for over an hour is cleaned up when the next one starts', async () => {
  const { data: stale } = await start(CHUNK);
  h.clock.at += 2 * HOUR;
  const { data: fresh } = await start(CHUNK);

  assert.equal((await h.sendChunk(stale.id, 0, Buffer.alloc(10))).status, 404);
  assert.equal(leftovers().length, 1, 'only the fresh upload remains');
  await h.api(`/api/uploads/${fresh.id}`, { method: 'DELETE' });
});

test('invalid uploads are refused before anything is saved', async () => {
  assert.equal((await start(0)).status, 400);
  assert.match((await start(0)).data.error, /empty/);
  assert.equal((await start(-5)).status, 400);
  assert.equal((await start('big')).status, 400);
  assert.equal((await start(h.config.maxUploadBytes + 1)).status, 413);
  assert.equal((await start(10, 'tool.exe')).status, 415);
  assert.deepEqual(leftovers(), []);
});

test('leftover partial files are cleared on startup, and finished videos are kept', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-uploads-'));
  try {
    writeFileSync(path.join(dir, 'abc.mp4.upload'), 'partial');
    writeFileSync(path.join(dir, 'def.mp4'), 'finished');
    clearAbandonedUploads(dir);
    assert.deepEqual(readdirSync(dir), ['def.mp4']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

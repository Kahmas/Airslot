import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { createStore } from '../src/store.js';
import { createVault } from '../src/vault.js';
import { HOUR, MINUTE, sampleVideo, startHarness } from './helpers.js';

const DAY = 24 * HOUR;

let h;
let other;
before(async () => {
  h = await startHarness();
  other = await h.addUser('other-person');
});
after(async () => { await h.close(); });

const videosDir = () => path.join(h.config.dataDir, 'videos');

async function schedulePost(platform = 'instagram') {
  const { data } = await h.upload(sampleVideo());
  const created = await h.api('/api/posts', {
    method: 'POST',
    body: { videoId: data.video.id, caption: 'milik pemilik', publishAt: h.clock.at + 6 * HOUR, targets: [{ accountId: h.accounts[platform] }] },
  });
  assert.equal(created.status, 201);
  const post = h.store.listPosts(h.ownerId).find((item) => item.id === created.data.id);
  return { video: data.video, postId: post.id, targetId: post.targets[0].id };
}

test('nobody sees another person\'s accounts or posts', async () => {
  await schedulePost();
  const state = await h.api('/api/state', { as: other.cookie });
  assert.deepEqual(state.data.accounts, []);
  const posts = await h.api('/api/posts', { as: other.cookie });
  assert.deepEqual(posts.data.posts, []);
  assert.ok((await h.api('/api/posts')).data.posts.length > 0, 'the owner still sees their own');
});

test('nobody can open another person\'s video or thumbnail', async () => {
  const { video } = await schedulePost();
  assert.equal((await h.fetch(video.fileUrl)).status, 200);
  assert.equal((await h.fetch(video.fileUrl, { as: other.cookie })).status, 404);
  assert.equal((await h.fetch(video.thumbUrl, { as: other.cookie })).status, 404);
});

test('video files stay out of shared caches, and browsers check with the server each time', async () => {
  const { video } = await schedulePost();
  for (const url of [video.fileUrl, video.thumbUrl]) {
    const res = await h.fetch(url);
    assert.match(res.headers.get('cache-control'), /private/, url);
    assert.match(res.headers.get('cache-control'), /no-cache/, url);
    await res.arrayBuffer();
  }
  assert.match((await h.fetch('/api/state')).headers.get('cache-control'), /no-store/);
});

test('a cached video still has to pass the login check', async () => {
  const { video } = await schedulePost();
  const first = await h.fetch(video.thumbUrl);
  const etag = first.headers.get('etag');
  await first.arrayBuffer();
  assert.ok(etag, 'the browser gets a tag to check with');

  // fetch turns a conditional request into a forced reload, which browsers don't do when they revalidate.
  const revalidate = (headers) => new Promise((resolve, reject) => {
    http.get({ port: h.config.port, path: video.thumbUrl, headers: { 'If-None-Match': etag, ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
  assert.equal(await revalidate({ Cookie: h.ownerCookie }), 304, 'the owner keeps the fast path');
  assert.equal(await revalidate({ Cookie: other.cookie }), 404);
  assert.equal(await revalidate({}), 401);
});

test('nobody can post another person\'s video, or post to another person\'s account', async () => {
  const { data: mine } = await h.upload(sampleVideo());
  const { data: theirs } = await h.upload(sampleVideo(), 'theirs.mp4', other.cookie);

  const stolenVideo = await h.api('/api/posts', {
    as: other.cookie,
    method: 'POST',
    body: { videoId: mine.video.id, caption: '', publishAt: h.clock.at + HOUR, targets: [{ accountId: h.accounts.instagram }] },
  });
  assert.equal(stolenVideo.status, 422);
  assert.match(stolenVideo.data.error, /has not been uploaded/);

  const stolenAccount = await h.api('/api/posts', {
    as: other.cookie,
    method: 'POST',
    body: { videoId: theirs.video.id, caption: '', publishAt: h.clock.at + HOUR, targets: [{ accountId: h.accounts.instagram }] },
  });
  assert.equal(stolenAccount.status, 422);
  assert.match(stolenAccount.data.error, /no longer connected/);
});

test('nobody can remove, retry, or cancel another person\'s post', async () => {
  const { postId, targetId } = await schedulePost();
  assert.equal((await h.api(`/api/posts/${postId}`, { as: other.cookie, method: 'DELETE' })).status, 404);
  assert.equal((await h.api(`/api/targets/${targetId}/cancel`, { as: other.cookie, method: 'POST' })).status, 404);
  assert.equal((await h.api(`/api/targets/${targetId}/retry`, { as: other.cookie, method: 'POST' })).status, 404);
  assert.equal(h.target(targetId).status, 'waiting');
  assert.ok(h.store.getPostFor(h.ownerId, postId));
});

test('nobody can disconnect another person\'s account', async () => {
  assert.equal((await h.api(`/api/accounts/${h.accounts.facebook}`, { as: other.cookie, method: 'DELETE' })).status, 404);
  assert.ok(h.store.getAccount(h.accounts.facebook));
});

test('nobody can touch another person\'s upload in progress', async () => {
  const { data: session } = await h.api('/api/uploads', { method: 'POST', body: { fileName: 'mine.mp4', size: 100 } });
  assert.equal((await h.sendChunk(session.id, 0, Buffer.alloc(10), other.cookie)).status, 404);
  assert.equal((await h.api(`/api/uploads/${session.id}/complete`, { as: other.cookie, method: 'POST' })).status, 404);

  assert.equal((await h.api(`/api/uploads/${session.id}`, { as: other.cookie, method: 'DELETE' })).status, 204, 'answers like an unknown upload');
  assert.equal((await h.sendChunk(session.id, 0, Buffer.alloc(10))).status, 200, 'and the upload is still there');
  await h.api(`/api/uploads/${session.id}`, { method: 'DELETE' });
});

async function connectGoogle(cookie) {
  const start = await h.fetch('/auth/google/start', { as: cookie, redirect: 'manual' });
  return new URL(start.headers.get('location')).searchParams.get('state');
}

test('an account connects to the person who started the sign-in', async () => {
  const person = await h.addUser('connects-google');
  const state = await connectGoogle(person.cookie);
  await h.fetch(`/auth/google/callback?code=abc&state=${state}`, { as: person.cookie, redirect: 'manual' });
  const { data } = await h.api('/api/state', { as: person.cookie });
  assert.match(data.flash.text, /Connected YouTube/);
  assert.equal(data.accounts.length, 1);
  assert.equal(h.store.listAccounts(h.ownerId).filter((account) => account.platform === 'youtube').length, 1, 'the owner keeps their own row');
  assert.equal((await h.api('/api/state', { as: other.cookie })).data.flash, null, 'the notice only goes to that person');
});

test('someone else\'s sign-in link can\'t attach an account to the wrong person', async () => {
  const victim = await h.addUser('victim');
  const attacker = await h.addUser('attacker');
  const attackerState = await connectGoogle(attacker.cookie);

  await h.fetch(`/auth/google/callback?code=attacker-code&state=${attackerState}`, { as: victim.cookie, redirect: 'manual' });

  const { data } = await h.api('/api/state', { as: victim.cookie });
  assert.match(data.flash.text, /expired/);
  assert.deepEqual(data.accounts, []);
  assert.deepEqual(h.store.listAccounts(attacker.id), []);
});

test('the same Page can be connected by two people, each with their own row', async () => {
  const a = await h.addUser('team-a');
  const b = await h.addUser('team-b');
  for (const person of [a, b]) {
    const start = await h.fetch('/auth/meta/start', { as: person.cookie, redirect: 'manual' });
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    await h.fetch(`/auth/meta/callback?code=abc&state=${state}`, { as: person.cookie, redirect: 'manual' });
  }
  const accountsOf = async (person) => (await h.api('/api/state', { as: person.cookie })).data.accounts;
  const [first, second] = [await accountsOf(a), await accountsOf(b)];
  assert.equal(first.length, 2);
  assert.equal(second.length, 2);
  assert.ok(first.every((account) => !second.some((item) => item.id === account.id)));
});

test('storage limits refuse a video that would not fit, and say what to do', async () => {
  const small = await startHarness({ configure: (config) => { config.storage.perUserBytes = 3 * 1024 * 1024; } });
  try {
    const person = await small.addUser('limited');
    const start = (size) => small.api('/api/uploads', { as: person.cookie, method: 'POST', body: { fileName: 'a.mp4', size } });

    const tooBig = await start(4 * 1024 * 1024);
    assert.equal(tooBig.status, 413);
    assert.match(tooBig.data.error, /storage left/);
    assert.match(tooBig.data.error, /Remove finished posts/);

    const first = await start(2 * 1024 * 1024);
    assert.equal(first.status, 201);
    const second = await start(2 * 1024 * 1024);
    assert.equal(second.status, 413, 'an upload in progress counts');
    assert.equal((await small.api(`/api/uploads/${first.data.id}`, { as: person.cookie, method: 'DELETE' })).status, 204);
    const third = await start(2 * 1024 * 1024);
    assert.equal(third.status, 201, 'canceling frees the space');
    await small.api(`/api/uploads/${third.data.id}`, { as: person.cookie, method: 'DELETE' });

    assert.equal((await small.api('/api/uploads', { method: 'POST', body: { fileName: 'a.mp4', size: 4 * 1024 * 1024 } })).status, 201, 'admin accounts have no limit');
  } finally {
    await small.close();
  }
});

test('finished videos count toward the limit, and removing the post frees the space', async () => {
  const person = await h.addUser('storage-count');
  const { data } = await h.upload(sampleVideo(), 'count.mp4', person.cookie);
  const state = await h.api('/api/state', { as: person.cookie });
  assert.equal(state.data.storage.usedBytes, data.video.size);
  assert.equal(state.data.storage.limitBytes, h.config.storage.perUserBytes);
  assert.equal((await h.api('/api/state')).data.storage.limitBytes, null, 'admin accounts show no limit');
});

test('a video that never became a post is cleaned up a day later, and only then', async () => {
  const person = await h.addUser('leaves-drafts');
  const { data } = await h.upload(sampleVideo(), 'unused.mp4', person.cookie);
  const file = path.join(videosDir(), `${data.video.id}.mp4`);
  assert.ok(existsSync(file));

  const newer = async () => {
    const started = await h.api('/api/uploads', { as: person.cookie, method: 'POST', body: { fileName: 'next.mp4', size: 10 } });
    await h.api(`/api/uploads/${started.data.id}`, { as: person.cookie, method: 'DELETE' });
  };

  await newer();
  assert.ok(existsSync(file), 'still within the day');

  h.clock.at += DAY + HOUR;
  await newer();
  assert.ok(!existsSync(file));
  assert.equal((await h.api('/api/state', { as: person.cookie })).data.storage.usedBytes, 0);
});

test('a video used by a post is never cleaned up as unused', async () => {
  const person = await h.addUser('keeps-posts');
  const start = await h.fetch('/auth/meta/start', { as: person.cookie, redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  await h.fetch(`/auth/meta/callback?code=abc&state=${state}`, { as: person.cookie, redirect: 'manual' });
  const { data: stateData } = await h.api('/api/state', { as: person.cookie });
  const account = stateData.accounts.find((item) => item.platform === 'facebook');

  const { data } = await h.upload(sampleVideo(), 'used.mp4', person.cookie);
  const created = await h.api('/api/posts', {
    as: person.cookie,
    method: 'POST',
    body: { videoId: data.video.id, caption: '', publishAt: h.clock.at + 5 * DAY, targets: [{ accountId: account.id }] },
  });
  assert.equal(created.status, 201);

  h.clock.at += 2 * DAY;
  const started = await h.api('/api/uploads', { as: person.cookie, method: 'POST', body: { fileName: 'next.mp4', size: 10 } });
  await h.api(`/api/uploads/${started.data.id}`, { as: person.cookie, method: 'DELETE' });
  assert.ok(existsSync(path.join(videosDir(), `${data.video.id}.mp4`)));
});

test('disconnecting an account removes its finished posts and their videos', async () => {
  const person = await h.addUser('disconnects');
  const start = await h.fetch('/auth/meta/start', { as: person.cookie, redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  await h.fetch(`/auth/meta/callback?code=abc&state=${state}`, { as: person.cookie, redirect: 'manual' });
  const { data: { accounts } } = await h.api('/api/state', { as: person.cookie });
  const account = accounts.find((item) => item.platform === 'instagram');

  const { data } = await h.upload(sampleVideo(), 'gone.mp4', person.cookie);
  const created = await h.api('/api/posts', {
    as: person.cookie,
    method: 'POST',
    body: { videoId: data.video.id, caption: '', publishAt: h.clock.at + 3 * HOUR, targets: [{ accountId: account.id }] },
  });
  const targetId = h.store.listPosts(person.id).find((post) => post.id === created.data.id).targets[0].id;
  await h.api(`/api/targets/${targetId}/cancel`, { as: person.cookie, method: 'POST' });

  assert.equal((await h.api(`/api/accounts/${account.id}`, { as: person.cookie, method: 'DELETE' })).status, 204);
  assert.equal(h.store.getPostFor(person.id, created.data.id), null);
  assert.ok(!readdirSync(videosDir()).some((name) => name.startsWith(data.video.id)));
  assert.equal((await h.api('/api/state', { as: person.cookie })).data.storage.usedBytes, 0);
});

test('a turned-off person\'s queue pauses and resumes', async () => {
  const fresh = await startHarness();
  try {
    const person = await fresh.addUser('paused');
    const start = await fresh.fetch('/auth/meta/start', { as: person.cookie, redirect: 'manual' });
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    await fresh.fetch(`/auth/meta/callback?code=abc&state=${state}`, { as: person.cookie, redirect: 'manual' });
    const { data: { accounts } } = await fresh.api('/api/state', { as: person.cookie });
    const account = accounts.find((item) => item.platform === 'instagram');
    const { data } = await fresh.upload(sampleVideo(), 'p.mp4', person.cookie);
    const publishAt = fresh.clock.at + 6 * HOUR;
    const created = await fresh.api('/api/posts', {
      as: person.cookie,
      method: 'POST',
      body: { videoId: data.video.id, caption: '', publishAt, targets: [{ accountId: account.id }] },
    });
    const targetId = fresh.store.listPosts(person.id).find((post) => post.id === created.data.id).targets[0].id;
    await fresh.settle();
    assert.equal(fresh.target(targetId).status, 'waiting');

    await fresh.api(`/api/admin/users/${person.id}/disable`, { method: 'POST' });
    fresh.clock.at = publishAt - 5 * 60_000;
    await fresh.settle();
    assert.equal(fresh.target(targetId).status, 'waiting', 'nothing goes out while turned off');
    assert.equal(fresh.mock.state.containers.size, 0);

    await fresh.api(`/api/admin/users/${person.id}/enable`, { method: 'POST' });
    await fresh.settle();
    assert.notEqual(fresh.target(targetId).status, 'waiting');
    assert.equal(fresh.mock.state.containers.size, 1);
  } finally {
    await fresh.close();
  }
});

test('the shared YouTube allowance stops new uploads for everyone', async () => {
  const fresh = await startHarness();
  try {
    const person = await fresh.addUser('youtube-person');
    const start = await fresh.fetch('/auth/google/start', { as: person.cookie, redirect: 'manual' });
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    await fresh.fetch(`/auth/google/callback?code=abc&state=${state}`, { as: person.cookie, redirect: 'manual' });
    const { data: { accounts } } = await fresh.api('/api/state', { as: person.cookie });

    const { data: mine } = await fresh.upload(sampleVideo());
    const { data: theirs } = await fresh.upload(sampleVideo(), 'y.mp4', person.cookie);
    const owner = { videoId: mine.video.id, caption: 'c', publishAt: fresh.clock.at + 2 * HOUR, targets: [{ accountId: fresh.accounts.youtube, title: 't' }] };
    // Spread over the days around publish time, so only the shared allowance can stop them.
    for (let i = 0; i < 100; i += 1) {
      const body = { ...owner, publishAt: fresh.clock.at + (2 + i * 25) * HOUR };
      assert.equal((await fresh.api('/api/posts', { method: 'POST', body })).status, 201, `upload ${i}`);
    }

    const blocked = await fresh.api('/api/posts', {
      as: person.cookie,
      method: 'POST',
      body: { videoId: theirs.video.id, caption: 'c', publishAt: fresh.clock.at + 2 * HOUR, targets: [{ accountId: accounts[0].id, title: 't' }] },
    });
    assert.equal(blocked.status, 422);
    assert.match(blocked.data.error, /allowance/);

    fresh.clock.at += DAY + HOUR;
    const nextDay = await fresh.api('/api/posts', {
      as: person.cookie,
      method: 'POST',
      body: { videoId: theirs.video.id, caption: 'c', publishAt: fresh.clock.at + 2 * HOUR, targets: [{ accountId: accounts[0].id, title: 't' }] },
    });
    assert.equal(nextDay.status, 201);
  } finally {
    await fresh.close();
  }
});

/* ---------- Storage limits set by an admin ---------- */

test('an admin can set one person\'s storage limit, and the upload check follows it', async () => {
  const fresh = await startHarness();
  try {
    const person = await fresh.addUser('custom-limit');
    const other2 = await fresh.addUser('default-limit');
    const MB = 1024 * 1024;
    const start = (who, size) => fresh.api('/api/uploads', { as: who.cookie, method: 'POST', body: { fileName: 'a.mp4', size } });
    const setLimit = (limitBytes) => fresh.api(`/api/admin/users/${person.id}/storage`, { method: 'POST', body: { limitBytes } });

    assert.equal((await setLimit(2 * MB)).status, 204);
    assert.equal((await fresh.api('/api/state', { as: person.cookie })).data.storage.limitBytes, 2 * MB);
    assert.equal((await start(person, 3 * MB)).status, 413);
    assert.equal((await start(other2, 3 * MB)).status, 201, 'other people keep the default');

    const { data } = await fresh.api('/api/admin/overview');
    const row = data.users.find((user) => user.id === person.id);
    assert.equal(row.limitBytes, 2 * MB);
    assert.equal(row.customLimit, true);
    assert.equal(data.defaultLimitBytes, fresh.config.storage.perUserBytes);

    assert.equal((await setLimit(null)).status, 204);
    assert.equal((await fresh.api('/api/state', { as: person.cookie })).data.storage.limitBytes, fresh.config.storage.perUserBytes);
    assert.equal((await start(person, 3 * MB)).status, 201, 'back on the default');
  } finally {
    await fresh.close();
  }
});

test('a limit below what someone uses keeps their videos and stops new uploads', async () => {
  const fresh = await startHarness();
  try {
    const person = await fresh.addUser('over-limit');
    const { data } = await fresh.upload(sampleVideo(), 'kept.mp4', person.cookie);
    await fresh.api(`/api/admin/users/${person.id}/storage`, { method: 'POST', body: { limitBytes: 10 } });

    assert.equal((await fresh.fetch(data.video.fileUrl, { as: person.cookie })).status, 200);
    const refused = await fresh.api('/api/uploads', { as: person.cookie, method: 'POST', body: { fileName: 'a.mp4', size: 100 } });
    assert.equal(refused.status, 413);
    assert.match(refused.data.error, /0\.0 GB of storage left/);
  } finally {
    await fresh.close();
  }
});

test('storage limits are checked, and only an admin can set them', async () => {
  const person = await h.addUser('limit-rules');
  const set = (limitBytes, as = h.ownerCookie, id = person.id) => h.api(`/api/admin/users/${id}/storage`, { as, method: 'POST', body: { limitBytes } });
  for (const bad of [-1, 1.5, 'lots', {}]) assert.equal((await set(bad)).status, 422, String(bad));
  assert.equal((await set(100, person.cookie)).status, 403);
  assert.equal((await set(100, h.ownerCookie, h.ownerId)).status, 409, 'admin accounts have no limit to set');
  assert.equal((await set(100, h.ownerCookie, 'nobody')).status, 404);
});

test('a database from before storage limits gains the setting when opened', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-limit-'));
  const dbPath = path.join(dir, 'airslot.db');
  const vault = createVault(Buffer.alloc(32, 7));
  try {
    const first = createStore(dbPath, vault, () => 5000);
    const id = first.createFirstAdmin({ username: 'boss', passwordHash: 'x' });
    first.close();
    const raw = new DatabaseSync(dbPath);
    raw.exec('ALTER TABLE users DROP COLUMN storage_limit_bytes');
    raw.close();

    const reopened = createStore(dbPath, vault, () => 5000);
    assert.equal(reopened.getUser(id).username, 'boss');
    reopened.setStorageLimit(id, 123);
    assert.equal(reopened.getUser(id).storage_limit_bytes, 123);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- Finished posts leave this server after a week ---------- */

test('a published post leaves this server after 7 days and is not touched on the platform', async () => {
  const fresh = await startHarness();
  try {
    const air = fresh.clock.at + HOUR;
    const id = await fresh.schedule({ platform: 'instagram', at: air });
    const { video_id: videoId } = fresh.store.listPosts(fresh.ownerId)[0];
    const file = path.join(fresh.config.dataDir, 'videos', `${videoId}.mp4`);
    await fresh.advance(HOUR + 5 * MINUTE);
    assert.equal(fresh.target(id).status, 'published');
    const publishedOnPlatform = fresh.mock.state.published.length;
    assert.equal(publishedOnPlatform, 1);

    fresh.clock.at = air + 6 * DAY;
    await fresh.settle();
    assert.equal(fresh.store.listPosts(fresh.ownerId).length, 1, 'still here at 6 days');
    assert.ok(existsSync(file));

    fresh.clock.at = air + 7 * DAY + HOUR;
    await fresh.settle();
    assert.deepEqual(fresh.store.listPosts(fresh.ownerId), []);
    assert.ok(!existsSync(file), 'the video file is gone');
    assert.ok(!existsSync(path.join(fresh.config.dataDir, 'videos', `${videoId}.jpg`)), 'the thumbnail is gone');
    assert.equal((await fresh.api('/api/state')).data.storage.usedBytes, 0, 'the space is free again');

    assert.equal(fresh.mock.state.published.length, publishedOnPlatform, 'the live post is still there');
    assert.deepEqual(fresh.mock.state.deleted, [], 'nothing was deleted on any platform');
  } finally {
    await fresh.close();
  }
});

test('a post with anything still active is never removed, however old', async () => {
  const fresh = await startHarness();
  try {
    const air = fresh.clock.at + HOUR;
    const id = await fresh.schedule({ platform: 'youtube', at: air });
    await fresh.settle();
    assert.equal(fresh.target(id).status, 'handed_off');
    fresh.store.patchTarget(id, { next_run_at: null });

    fresh.clock.at = air + 30 * DAY;
    await fresh.settle();
    assert.equal(fresh.store.listPosts(fresh.ownerId).length, 1);
  } finally {
    await fresh.close();
  }
});

test('a post scheduled far ahead is not removed before its time', async () => {
  const fresh = await startHarness();
  try {
    const id = await fresh.schedule({ platform: 'facebook', at: fresh.clock.at + 20 * DAY });
    await fresh.settle();
    await fresh.api(`/api/targets/${id}/cancel`, { method: 'POST' });

    fresh.clock.at += 8 * DAY;
    await fresh.settle();
    assert.equal(fresh.store.listPosts(fresh.ownerId).length, 1, 'counted from the publish time, not from when it was made');
  } finally {
    await fresh.close();
  }
});

test('a failed post is removed too', async () => {
  const fresh = await startHarness();
  try {
    const air = fresh.clock.at + 30 * MINUTE;
    const id = await fresh.schedule({ platform: 'instagram', at: air });
    fresh.store.patchTarget(id, { status: 'failed', next_run_at: null, error: 'x' });

    fresh.clock.at = air + 8 * DAY;
    await fresh.settle();
    assert.deepEqual(fresh.store.listPosts(fresh.ownerId), []);
  } finally {
    await fresh.close();
  }
});

test('a video shared by two posts stays until the second one goes', async () => {
  const fresh = await startHarness();
  try {
    const { data } = await fresh.upload(sampleVideo());
    const at = fresh.clock.at + HOUR;
    const post = (publishAt) => fresh.api('/api/posts', { method: 'POST', body: { videoId: data.video.id, caption: 'c', publishAt, targets: [{ accountId: fresh.accounts.instagram }] } });
    const early = await post(at);
    const late = await post(at + 3 * DAY);
    for (const item of fresh.store.listPosts(fresh.ownerId)) {
      fresh.store.patchTarget(item.targets[0].id, { status: 'canceled', next_run_at: null });
    }
    const file = path.join(fresh.config.dataDir, 'videos', `${data.video.id}.mp4`);

    fresh.clock.at = at + 8 * DAY;
    await fresh.settle();
    assert.equal(fresh.store.getPostFor(fresh.ownerId, early.data.id), null);
    assert.ok(fresh.store.getPostFor(fresh.ownerId, late.data.id));
    assert.ok(existsSync(file));

    fresh.clock.at = at + 11 * DAY;
    await fresh.settle();
    assert.ok(!existsSync(file));
  } finally {
    await fresh.close();
  }
});

/* ---------- Upgrading a database from before accounts had owners ---------- */

const OLD_SCHEMA = `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY, platform TEXT NOT NULL, remote_id TEXT NOT NULL, name TEXT NOT NULL, token TEXT NOT NULL,
    refresh_token TEXT, token_expires_at INTEGER, needs_reconnect INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
    UNIQUE (platform, remote_id)
  );
  CREATE TABLE videos (
    id TEXT PRIMARY KEY, file_name TEXT NOT NULL, original_name TEXT NOT NULL, size INTEGER NOT NULL,
    info TEXT NOT NULL, has_thumb INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );
  CREATE TABLE posts (
    id TEXT PRIMARY KEY, video_id TEXT NOT NULL REFERENCES videos (id), caption TEXT NOT NULL,
    publish_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE targets (
    id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts (id), platform TEXT NOT NULL, caption TEXT NOT NULL, title TEXT,
    made_for_kids INTEGER NOT NULL DEFAULT 0, publish_at INTEGER NOT NULL, status TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT '{}', remote_id TEXT, remote_url TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    next_run_at INTEGER, updated_at INTEGER NOT NULL
  );
`;

test('an existing database upgrades in place, and the first admin takes everything in it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-migrate-'));
  const dbPath = path.join(dir, 'airslot.db');
  const vault = createVault(Buffer.alloc(32, 7));
  try {
    const old = new DatabaseSync(dbPath);
    old.exec(OLD_SCHEMA);
    old.prepare("INSERT INTO accounts (id, platform, remote_id, name, token, created_at) VALUES ('acc-1', 'instagram', 'ig-1', '@catatan', ?, 1)").run(vault.seal('live-token'));
    old.prepare("INSERT INTO videos (id, file_name, original_name, size, info, created_at) VALUES ('vid-1', 'vid-1.mp4', 'clip.mp4', 500, '{\"durationSec\":4}', 1)").run();
    old.prepare("INSERT INTO posts (id, video_id, caption, publish_at, created_at) VALUES ('post-1', 'vid-1', 'halo', 1000, 1)").run();
    old.prepare("INSERT INTO targets (id, post_id, account_id, platform, caption, publish_at, status, next_run_at, updated_at) VALUES ('tgt-1', 'post-1', 'acc-1', 'instagram', 'halo', 1000, 'waiting', 900, 1)").run();
    old.close();

    const store = createStore(dbPath, vault, () => 5000);
    assert.ok(existsSync(`${dbPath}.before-users`), 'a copy is kept from before the upgrade');
    assert.equal(store.dueTargets(5000, 10).length, 1, 'a queued post keeps running through the upgrade');
    assert.equal(store.getAccount('acc-1').token, 'live-token');

    const adminId = store.createFirstAdmin({ username: 'boss', passwordHash: 'x' });
    assert.equal(store.listAccounts(adminId).length, 1);
    assert.equal(store.listPosts(adminId).length, 1);
    assert.equal(store.listPosts(adminId)[0].targets[0].account_name, '@catatan');
    assert.equal(store.usedBytes(adminId), 500);
    assert.equal(store.getVideoFor(adminId, 'vid-1').original_name, 'clip.mp4');
    assert.equal(store.getTargetFor(adminId, 'tgt-1').status, 'waiting');

    const secondId = store.createUser({ username: 'second', passwordHash: 'x' });
    assert.deepEqual(store.listAccounts(secondId), [], 'only the first admin takes it');
    store.close();

    const reopened = createStore(dbPath, vault, () => 5000);
    assert.equal(reopened.listAccounts(adminId).length, 1, 'opening it again changes nothing');
    assert.equal(reopened.dueTargets(5000, 10).length, 1);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

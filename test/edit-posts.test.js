import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOUR, MINUTE, startHarness } from './helpers.js';

async function withHarness(fn) {
  const h = await startHarness();
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

const postOf = (h, targetId) => h.target(targetId).post_id;
const targetsOf = (h, postId) => h.store.postTargetsFull(postId);
const byPlatform = (h, postId, platform) => targetsOf(h, postId).find((target) => target.platform === platform);
const reelDescriptions = (h) => [...h.mock.state.reels.values()].filter((reel) => reel.state === 'scheduled').map((reel) => reel.description);

test('accounts can be added to a post already on the schedule, and go out at its time', () => withHarness(async (h) => {
  const air = h.clock.at + 3 * HOUR;
  const postId = postOf(h, await h.schedule({ platform: 'instagram', at: air, caption: 'Caption awal' }));

  const added = await h.api(`/api/posts/${postId}/targets`, {
    method: 'POST',
    body: { targets: [{ accountId: h.accounts.facebook }, { accountId: h.accounts.youtube, title: 'Judul tambahan' }] },
  });
  assert.equal(added.status, 201);
  await h.settle();

  const facebook = byPlatform(h, postId, 'facebook');
  assert.equal(facebook.publish_at, air);
  assert.equal(facebook.caption, 'Caption awal');
  assert.equal(facebook.status, 'handed_off');
  const [video] = [...h.mock.state.videos.values()];
  assert.equal(video.title, 'Judul tambahan');
  assert.equal(video.publishAt, air);

  const { data } = await h.api('/api/posts');
  assert.equal(data.posts[0].targets.length, 3);
  assert.equal(data.posts[0].editable, true);
  assert.equal(data.posts[0].video.checks.facebook.ok, true, 'the schedule knows which accounts the video fits');
}));

test('an account already in the post is refused, and a canceled one can come back', () => withHarness(async (h) => {
  const targetId = await h.schedule({ platform: 'instagram', at: h.clock.at + 3 * HOUR });
  const postId = postOf(h, targetId);
  const again = await h.api(`/api/posts/${postId}/targets`, { method: 'POST', body: { targets: [{ accountId: h.accounts.instagram }] } });
  assert.equal(again.status, 409);
  assert.match(again.data.error, /already in this post/);

  await h.api(`/api/targets/${targetId}/cancel`, { method: 'POST' });
  const back = await h.api(`/api/posts/${postId}/targets`, { method: 'POST', body: { targets: [{ accountId: h.accounts.instagram }] } });
  assert.equal(back.status, 201);
  assert.deepEqual(targetsOf(h, postId).map((target) => target.status).sort(), ['canceled', 'waiting']);
}));

test('adding a YouTube channel needs a title, like a new post', () => withHarness(async (h) => {
  const postId = postOf(h, await h.schedule({ platform: 'instagram', at: h.clock.at + 3 * HOUR, caption: '' }));
  const res = await h.api(`/api/posts/${postId}/targets`, { method: 'POST', body: { targets: [{ accountId: h.accounts.youtube, title: '  ' }] } });
  assert.equal(res.status, 422);
  assert.match(res.data.error, /title is required/);
}));

test('a post can no longer change once its time has passed or part of it is live', () => withHarness(async (h) => {
  const air = h.clock.at + 5 * MINUTE;
  const postId = postOf(h, await h.schedule({ platform: 'instagram', at: air }));
  await h.api(`/api/posts/${postId}/targets`, { method: 'POST', body: { targets: [{ accountId: h.accounts.facebook }] } });
  await h.advance(10 * MINUTE);
  assert.equal(byPlatform(h, postId, 'instagram').status, 'published');

  const edit = await h.api(`/api/posts/${postId}`, { method: 'PATCH', body: { caption: 'Terlambat' } });
  assert.equal(edit.status, 409);
  assert.match(edit.data.error, /already live/);
  const add = await h.api(`/api/posts/${postId}/targets`, { method: 'POST', body: { targets: [{ accountId: h.accounts.youtube, title: 'x' }] } });
  assert.equal(add.status, 409);
  assert.equal((await h.api('/api/posts')).data.posts[0].editable, false);
}));

test('someone else cannot change or add to a post', () => withHarness(async (h) => {
  const postId = postOf(h, await h.schedule({ platform: 'instagram', at: h.clock.at + 3 * HOUR }));
  const other = await h.addUser('other-editor');
  assert.equal((await h.api(`/api/posts/${postId}`, { as: other.cookie, method: 'PATCH', body: { caption: 'x' } })).status, 404);
  assert.equal((await h.api(`/api/posts/${postId}/targets`, { as: other.cookie, method: 'POST', body: { targets: [{ accountId: h.accounts.instagram }] } })).status, 404);
}));

test('a new time must still be ahead', () => withHarness(async (h) => {
  const postId = postOf(h, await h.schedule({ platform: 'instagram', at: h.clock.at + 3 * HOUR }));
  const res = await h.api(`/api/posts/${postId}`, { method: 'PATCH', body: { publishAt: h.clock.at + 10_000 } });
  assert.equal(res.status, 422);
}));

test('a reel already scheduled on Facebook is replaced with the new caption and time', () => withHarness(async (h) => {
  const postId = postOf(h, await h.schedule({ platform: 'facebook', at: h.clock.at + 3 * HOUR, caption: 'Lama' }));
  await h.settle();
  const old = byPlatform(h, postId, 'facebook');
  assert.equal(old.status, 'handed_off');

  const later = h.clock.at + 5 * HOUR;
  const res = await h.api(`/api/posts/${postId}`, { method: 'PATCH', body: { caption: 'Baru', publishAt: later } });
  assert.equal(res.status, 200);
  assert.ok(h.mock.state.deleted.includes(old.stage.videoId), 'the old scheduled reel is deleted');
  await h.settle();

  const now = byPlatform(h, postId, 'facebook');
  assert.equal(now.status, 'handed_off');
  assert.equal(now.publish_at, later);
  assert.deepEqual(reelDescriptions(h), ['Baru']);
  const reel = h.mock.state.reels.get(now.stage.videoId);
  assert.equal(reel.scheduledFor, Math.floor(later / 1000) * 1000);
  assert.equal(h.store.getPostFor(h.ownerId, postId).caption, 'Baru');
}));

test('a YouTube video already uploaded is changed in place, without a second upload', () => withHarness(async (h) => {
  const postId = postOf(h, await h.schedule({ platform: 'youtube', at: h.clock.at + 3 * HOUR, caption: 'Deskripsi lama', title: 'Judul lama' }));
  await h.settle();
  assert.equal(byPlatform(h, postId, 'youtube').status, 'handed_off');

  const later = h.clock.at + 6 * HOUR;
  const res = await h.api(`/api/posts/${postId}`, { method: 'PATCH', body: { caption: 'Deskripsi baru', title: 'Judul baru', publishAt: later } });
  assert.equal(res.status, 200);
  assert.equal(h.mock.state.videos.size, 1);
  assert.equal(h.mock.state.youtubeUpdates, 1);
  const [video] = [...h.mock.state.videos.values()];
  assert.deepEqual({ title: video.title, description: video.description, publishAt: video.publishAt, privacy: video.privacy },
    { title: 'Judul baru', description: 'Deskripsi baru', publishAt: later, privacy: 'private' });

  await h.advance(later - h.clock.at + 2 * MINUTE, 5 * MINUTE);
  assert.equal(byPlatform(h, postId, 'youtube').status, 'published');
}));

test('an Instagram post already prepared starts over with the new caption', () => withHarness(async (h) => {
  const air = h.clock.at + 10 * MINUTE;
  const postId = postOf(h, await h.schedule({ platform: 'instagram', at: air, caption: 'Lama' }));
  await h.advance(3 * MINUTE);
  assert.equal(byPlatform(h, postId, 'instagram').status, 'ready');

  assert.equal((await h.api(`/api/posts/${postId}`, { method: 'PATCH', body: { caption: 'Baru' } })).status, 200);
  assert.equal(byPlatform(h, postId, 'instagram').status, 'waiting');
  await h.advance(air - h.clock.at + MINUTE);
  assert.equal(byPlatform(h, postId, 'instagram').status, 'published');
  assert.deepEqual(h.mock.state.published.map((post) => post.caption), ['Baru']);
}));

test('an account with its own caption keeps it when the main caption changes', () => withHarness(async (h) => {
  const uploaded = (await h.upload((await import('./helpers.js')).sampleVideo())).data.video;
  const created = await h.api('/api/posts', {
    method: 'POST',
    body: {
      videoId: uploaded.id,
      caption: 'Utama',
      publishAt: h.clock.at + 3 * HOUR,
      targets: [{ accountId: h.accounts.instagram }, { accountId: h.accounts.facebook, caption: 'Khusus Facebook' }],
    },
  });
  const postId = created.data.id;
  assert.equal((await h.api(`/api/posts/${postId}`, { method: 'PATCH', body: { caption: 'Utama baru' } })).status, 200);
  assert.equal(byPlatform(h, postId, 'instagram').caption, 'Utama baru');
  assert.equal(byPlatform(h, postId, 'facebook').caption, 'Khusus Facebook');
}));

test('a TikTok draft already in the inbox gets the new caption for copying', () => withHarness(async (h) => {
  h.accounts.tiktok = h.store.upsertAccount({
    userId: h.ownerId, platform: 'tiktok', remote_id: 'tt-user-1', name: 'Akun TikTok',
    token: 'tt-access-token', refresh_token: 'tt-refresh-1', token_expires_at: h.clock.at + 100 * HOUR,
  });
  const ttId = await h.schedule({ platform: 'tiktok', at: h.clock.at + 2 * MINUTE, caption: 'Lama' });
  const postId = postOf(h, ttId);
  await h.api(`/api/posts/${postId}/targets`, { method: 'POST', body: { targets: [{ accountId: h.accounts.youtube, title: 'Judul' }] } });
  await h.settle();
  // Moves the whole post later, so it is still open to changes after the draft went out.
  assert.equal((await h.api(`/api/posts/${postId}`, { method: 'PATCH', body: { publishAt: h.clock.at + 3 * HOUR } })).status, 200);
  await h.settle();
  h.store.patchTarget(ttId, { publish_at: h.clock.at + MINUTE, next_run_at: h.clock.at });
  await h.advance(3 * MINUTE, 30_000);
  assert.equal(h.target(ttId).status, 'handed_off');

  assert.equal((await h.api(`/api/posts/${postId}`, { method: 'PATCH', body: { caption: 'Baru' } })).status, 200);
  const view = (await h.api('/api/posts')).data.posts[0].targets.find((target) => target.platform === 'tiktok');
  assert.equal(view.caption, 'Baru');
  assert.equal(view.status, 'handed_off');
}));

test('when one platform refuses the change, the others keep it and saving again finishes the job', () => withHarness(async (h) => {
  const postId = postOf(h, await h.schedule({ platform: 'youtube', at: h.clock.at + 3 * HOUR, caption: 'Lama', title: 'Judul' }));
  await h.api(`/api/posts/${postId}/targets`, { method: 'POST', body: { targets: [{ accountId: h.accounts.instagram }] } });
  await h.settle();
  h.mock.failNext('PUT /youtube/v3/videos', 403, { error: { code: 403, message: 'Forbidden for now', errors: [{ reason: 'forbidden' }] } });

  const first = await h.api(`/api/posts/${postId}`, { method: 'PATCH', body: { caption: 'Baru' } });
  assert.equal(first.status, 502);
  assert.match(first.data.error, /YouTube Kanal Uji kept the old version: Forbidden for now/);
  assert.equal(byPlatform(h, postId, 'instagram').caption, 'Baru');
  assert.equal(byPlatform(h, postId, 'youtube').caption, 'Lama');
  assert.equal(h.store.getPostFor(h.ownerId, postId).caption, 'Lama', 'the post keeps its old caption until everything changed');
  assert.ok(byPlatform(h, postId, 'youtube').next_run_at <= h.clock.at, 'the scheduler is free to carry on');
  await h.settle();

  const second = await h.api(`/api/posts/${postId}`, { method: 'PATCH', body: { caption: 'Baru' } });
  assert.equal(second.status, 200);
  assert.equal(byPlatform(h, postId, 'youtube').caption, 'Baru');
  assert.equal([...h.mock.state.videos.values()][0].description, 'Baru');
  assert.equal(h.store.getPostFor(h.ownerId, postId).caption, 'Baru');
}));

test('moving a post does not count it against its own daily limit', () => withHarness(async (h) => {
  const postId = postOf(h, await h.schedule({ platform: 'instagram', at: h.clock.at + 3 * HOUR }));
  const res = await h.api(`/api/posts/${postId}`, { method: 'PATCH', body: { publishAt: h.clock.at + 4 * HOUR } });
  assert.equal(res.status, 200);
  assert.equal(h.store.countNear(h.accounts.instagram, h.clock.at + 4 * HOUR, 24 * HOUR, postId), 0);
}));

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { HOUR, MINUTE, sampleVideo, startHarness } from './helpers.js';

const DAY = 24 * HOUR;

async function withHarness(fn, options) {
  const h = await startHarness(options);
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

test('Instagram waits, prepares 15 minutes ahead, and publishes exactly at air time', () => withHarness(async (h) => {
  const air = h.clock.at + 2 * HOUR;
  const id = await h.schedule({ platform: 'instagram', at: air, caption: 'Promo Selasa' });

  await h.settle();
  assert.equal(h.target(id).status, 'waiting');
  assert.equal(h.target(id).next_run_at, air - 15 * MINUTE);
  assert.equal(h.mock.state.containers.size, 0, 'nothing is sent early');

  await h.advance(air - 16 * MINUTE - h.clock.at);
  assert.equal(h.mock.state.containers.size, 0);

  await h.advance(4 * MINUTE);
  assert.equal(h.target(id).status, 'ready');
  assert.equal(h.mock.state.published.length, 0, 'prepared but not yet public');

  await h.advance(air - h.clock.at);
  const done = h.target(id);
  assert.equal(done.status, 'published');
  assert.equal(h.mock.state.published.length, 1);
  assert.equal(h.mock.state.published[0].at, air);
  assert.equal(h.mock.state.published[0].caption, 'Promo Selasa');
  assert.match(done.remote_url, /instagram\.com\/reel\//);

  await h.advance(HOUR);
  assert.equal(h.mock.state.published.length, 1, 'never posts twice');
}));

test('Instagram scheduled sooner than the lead time still goes out on time', () => withHarness(async (h) => {
  const air = h.clock.at + 5 * MINUTE;
  const id = await h.schedule({ platform: 'instagram', at: air });
  await h.settle();
  assert.equal(h.target(id).status, 'processing');
  await h.advance(5 * MINUTE);
  assert.equal(h.target(id).status, 'published');
  assert.equal(h.mock.state.published[0].at, air);
}));

test('Instagram retries a server error before publishing', () => withHarness(async (h) => {
  const air = h.clock.at + 30 * MINUTE;
  const id = await h.schedule({ platform: 'instagram', at: air });
  await h.advance(29 * MINUTE);
  assert.equal(h.target(id).status, 'ready');

  h.mock.failNext('media_publish', 500, { error: { message: 'Service unavailable', code: 2 } });
  await h.advance(MINUTE);
  const retrying = h.target(id);
  assert.equal(retrying.status, 'ready');
  assert.equal(retrying.attempts, 1);
  assert.match(retrying.error, /Service unavailable/);
  assert.equal(h.mock.state.published.length, 0);

  await h.advance(MINUTE);
  assert.equal(h.target(id).status, 'published');
  assert.equal(h.target(id).error, null);
  assert.equal(h.mock.state.published.length, 1);
}));

test('Instagram never publishes twice when the publish response is lost', () => withHarness(async (h) => {
  const air = h.clock.at + 30 * MINUTE;
  const id = await h.schedule({ platform: 'instagram', at: air });
  await h.advance(29 * MINUTE);

  h.mock.failNext('media_publish', 500, { error: { message: 'Timeout', code: 2 } }, { lostResponse: true });
  await h.advance(MINUTE);
  assert.equal(h.target(id).status, 'ready', 'the app believes the call failed');
  assert.equal(h.mock.state.published.length, 1, 'but it actually went live');

  await h.advance(MINUTE);
  assert.equal(h.target(id).status, 'published');
  assert.equal(h.mock.state.published.length, 1);
  assert.equal(h.mock.state.requests.filter((r) => r.includes('media_publish')).length, 1);
}));

test('Instagram restarts from upload when the container expired', () => withHarness(async (h) => {
  const air = h.clock.at + 30 * MINUTE;
  const id = await h.schedule({ platform: 'instagram', at: air });
  await h.advance(29 * MINUTE);
  const first = h.target(id).stage.containerId;
  h.mock.state.containers.get(first).status = 'EXPIRED';
  await h.advance(MINUTE);
  await h.advance(5 * MINUTE);
  assert.equal(h.target(id).status, 'published');
  assert.notEqual(h.target(id).stage.containerId, first);
}));

test('Facebook is handed off right away with its native schedule, then confirmed', () => withHarness(async (h) => {
  const air = h.clock.at + 3 * HOUR;
  const id = await h.schedule({ platform: 'facebook', at: air, caption: 'Reel FB' });
  await h.settle();

  const target = h.target(id);
  assert.equal(target.status, 'handed_off');
  const reel = h.mock.state.reels.get(target.stage.videoId);
  assert.equal(reel.videoState, 'SCHEDULED');
  assert.equal(reel.scheduledFor, Math.floor(air / 1000) * 1000);
  assert.equal(reel.description, 'Reel FB');

  await h.advance(air - h.clock.at, 5 * MINUTE);
  assert.equal(h.target(id).status, 'handed_off');
  await h.advance(3 * MINUTE);
  const done = h.target(id);
  assert.equal(done.status, 'published');
  assert.match(done.remote_url, /facebook\.com\/reel\//);
}));

test('Facebook too close to air time for its scheduler is held and published directly', () => withHarness(async (h) => {
  const air = h.clock.at + 5 * MINUTE;
  const id = await h.schedule({ platform: 'facebook', at: air });
  await h.settle();
  assert.equal(h.target(id).status, 'ready');
  const reel = h.mock.state.reels.get(h.target(id).stage.videoId);
  assert.equal(reel.state, 'new', 'not finished yet');

  await h.advance(5 * MINUTE);
  assert.equal(reel.videoState, 'PUBLISHED');
  assert.equal(reel.scheduledFor, air);
  await h.advance(10 * MINUTE);
  assert.equal(h.target(id).status, 'published');
}));

test('Facebook beyond its 29-day window waits before uploading', () => withHarness(async (h) => {
  const air = h.clock.at + 40 * DAY;
  const id = await h.schedule({ platform: 'facebook', at: air });
  await h.settle();
  assert.equal(h.target(id).status, 'waiting');
  assert.equal(h.mock.state.reels.size, 0);
  h.clock.at = air - 28 * DAY;
  await h.settle();
  const target = h.target(id);
  assert.equal(target.status, 'handed_off');
  assert.equal(h.mock.state.reels.get(target.stage.videoId).videoState, 'SCHEDULED');
}));

test('Facebook does not finish twice when the finish response is lost', () => withHarness(async (h) => {
  const air = h.clock.at + 3 * HOUR;
  h.mock.failNext('video_reels', 500, { error: { message: 'Timeout', code: 2 } }, { bodyIncludes: 'upload_phase=finish', lostResponse: true });
  const id = await h.schedule({ platform: 'facebook', at: air });
  await h.settle();
  assert.equal(h.target(id).status, 'ready');
  assert.equal(h.target(id).attempts, 1);

  await h.advance(MINUTE);
  const target = h.target(id);
  assert.equal(target.status, 'handed_off');
  assert.equal(h.mock.state.reels.get(target.stage.videoId).finishCalls, 1);
}));

test('Facebook retries when the start call fails', () => withHarness(async (h) => {
  const id = await h.schedule({ platform: 'facebook', at: h.clock.at + 3 * HOUR });
  h.mock.failNext('video_reels', 500, { error: { message: 'boom', code: 2 } });
  await h.settle();
  await h.advance(MINUTE);
  assert.equal(h.target(id).status, 'handed_off');
  assert.equal(h.target(id).attempts, 0);
}));

test('YouTube uploads immediately with publishAt and becomes published after air time', () => withHarness(async (h) => {
  const air = h.clock.at + 2 * HOUR;
  const id = await h.schedule({ platform: 'youtube', at: air, title: 'Short Selasa', caption: 'Deskripsi' });
  await h.settle();

  const target = h.target(id);
  assert.equal(target.status, 'handed_off');
  const video = h.mock.state.videos.get(target.remote_id);
  assert.equal(video.title, 'Short Selasa');
  assert.equal(video.description, 'Deskripsi');
  assert.equal(video.publishAt, air);
  assert.equal(video.madeForKids, false);
  assert.match(target.remote_url, /^https:\/\/youtu\.be\//);

  await h.advance(air - h.clock.at, 5 * MINUTE);
  await h.advance(2 * MINUTE);
  assert.equal(h.target(id).status, 'published');
}));

test('YouTube locked as private is reported instead of silently marked live', () => withHarness(async (h) => {
  h.mock.state.lockYouTubePrivate = true;
  const air = h.clock.at + 30 * MINUTE;
  const id = await h.schedule({ platform: 'youtube', at: air });
  await h.settle();
  await h.advance(70 * MINUTE, 5 * MINUTE);
  const target = h.target(id);
  assert.equal(target.status, 'failed');
  assert.match(target.error, /private/);
}));

test('YouTube resumes an interrupted upload without creating a second video', () => withHarness(async (h) => {
  const air = h.clock.at + 2 * HOUR;
  const id = await h.schedule({ platform: 'youtube', at: air });
  // Network dies on the first status query after the session opened.
  h.mock.failNext('PUT /upload/session', 503, { error: { code: 503, message: 'Backend error', errors: [{ reason: 'backendError' }] } });
  await h.settle();
  assert.equal(h.target(id).status, 'uploading');
  assert.equal(h.target(id).attempts, 1);
  await h.advance(MINUTE);
  assert.equal(h.target(id).status, 'handed_off');
  assert.equal(h.mock.state.videos.size, 1);
}));

test('YouTube refreshes an expired access token and stores it', () => withHarness(async (h) => {
  h.store.saveAccessToken(h.accounts.youtube, 'stale', h.clock.at - MINUTE);
  const id = await h.schedule({ platform: 'youtube', at: h.clock.at + HOUR });
  await h.settle();
  assert.equal(h.target(id).status, 'handed_off');
  assert.equal(h.store.getAccount(h.accounts.youtube).token, 'yt-access-token');
}));

test('a revoked token fails the target and flags the account for reconnect', () => withHarness(async (h) => {
  const id = await h.schedule({ platform: 'instagram', at: h.clock.at + 5 * MINUTE });
  h.mock.state.tokens.delete('ig-page-token');
  await h.settle();
  const target = h.target(id);
  assert.equal(target.status, 'failed');
  assert.match(target.error, /Reconnect/);
  assert.equal(h.store.getAccount(h.accounts.instagram).needs_reconnect, 1);

  const blocked = await h.api(`/api/targets/${id}/retry`, { method: 'POST' });
  assert.equal(blocked.status, 409);

  h.mock.state.tokens.add('ig-page-token');
  h.store.upsertAccount({ userId: h.ownerId, platform: 'instagram', remote_id: 'ig-1', name: '@akun_uji', token: 'ig-page-token' });
  assert.equal((await h.api(`/api/targets/${id}/retry`, { method: 'POST' })).status, 200);
  await h.advance(10 * MINUTE);
  assert.equal(h.target(id).status, 'published');
}));

test('repeated server errors give up after the retry limit', () => withHarness(async (h) => {
  const id = await h.schedule({ platform: 'youtube', at: h.clock.at + 6 * HOUR });
  for (let i = 0; i < 5; i += 1) h.mock.failNext('POST /upload/youtube', 500, { error: { code: 500, message: 'down' } });
  await h.settle();
  await h.advance(60 * MINUTE);
  const target = h.target(id);
  assert.equal(target.status, 'failed');
  assert.match(target.error, /down/);

  assert.equal((await h.api(`/api/targets/${id}/retry`, { method: 'POST' })).status, 200);
  await h.settle();
  assert.equal(h.target(id).status, 'handed_off');
}));

test('a post missed while the app was off is flagged, then can be sent on request', () => withHarness(async (h) => {
  const air = h.clock.at + 30 * MINUTE;
  const id = await h.schedule({ platform: 'instagram', at: air });
  h.clock.at = air + 3 * HOUR; // The machine was off across air time.
  await h.settle();
  const missed = h.target(id);
  assert.equal(missed.status, 'missed');
  assert.equal(h.mock.state.published.length, 0, 'never goes out unexpectedly late');

  const retry = await h.api(`/api/targets/${id}/retry`, { method: 'POST' });
  assert.equal(retry.status, 200);
  assert.equal(h.target(id).publish_at, h.clock.at);
  await h.advance(3 * MINUTE);
  assert.equal(h.target(id).status, 'published');
}));

test('a short outage across air time still publishes late rather than dropping the post', () => withHarness(async (h) => {
  const air = h.clock.at + 30 * MINUTE;
  const id = await h.schedule({ platform: 'instagram', at: air });
  h.clock.at = air + 30 * MINUTE;
  await h.advance(3 * MINUTE);
  assert.equal(h.target(id).status, 'published');
}));

test('canceling a handed-off Facebook reel deletes it on the platform', () => withHarness(async (h) => {
  const id = await h.schedule({ platform: 'facebook', at: h.clock.at + 3 * HOUR });
  await h.settle();
  const { videoId } = h.target(id).stage;
  const res = await h.api(`/api/targets/${id}/cancel`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(h.target(id).status, 'canceled');
  assert.deepEqual(h.mock.state.deleted, [videoId]);
  await h.advance(4 * HOUR, 30 * MINUTE);
  assert.equal(h.target(id).status, 'canceled');
}));

test('canceling a handed-off YouTube video deletes it on the platform', () => withHarness(async (h) => {
  const id = await h.schedule({ platform: 'youtube', at: h.clock.at + 3 * HOUR });
  await h.settle();
  const { remote_id: remoteId } = h.target(id);
  assert.equal((await h.api(`/api/targets/${id}/cancel`, { method: 'POST' })).status, 200);
  assert.deepEqual(h.mock.state.deleted, [remoteId]);
}));

test('canceling a waiting Instagram post sends nothing to the platform', () => withHarness(async (h) => {
  const id = await h.schedule({ platform: 'instagram', at: h.clock.at + 3 * HOUR });
  await h.settle();
  assert.equal((await h.api(`/api/targets/${id}/cancel`, { method: 'POST' })).status, 200);
  await h.advance(4 * HOUR, 30 * MINUTE);
  assert.equal(h.mock.state.containers.size, 0);
  assert.equal(h.mock.state.published.length, 0);
}));

test('one click fans out to every platform and each runs independently', () => withHarness(async (h) => {
  const { data } = await h.upload(sampleVideo());
  const air = h.clock.at + HOUR;
  const res = await h.api('/api/posts', {
    method: 'POST',
    body: {
      videoId: data.video.id,
      caption: 'Sama semua',
      publishAt: air,
      targets: [
        { accountId: h.accounts.instagram, caption: 'Khusus IG #reels' },
        { accountId: h.accounts.facebook },
        { accountId: h.accounts.youtube, title: 'Judul YT' },
      ],
    },
  });
  assert.equal(res.status, 201);
  await h.settle();
  const statuses = () => Object.fromEntries((h.store.listPosts(h.ownerId)[0].targets).map((t) => [t.platform, t.status]));
  assert.deepEqual(statuses(), { facebook: 'handed_off', instagram: 'waiting', youtube: 'handed_off' });

  await h.advance(air - h.clock.at, 5 * MINUTE);
  await h.advance(5 * MINUTE);
  assert.deepEqual(statuses(), { facebook: 'published', instagram: 'published', youtube: 'published' });
  assert.equal(h.mock.state.published[0].caption, 'Khusus IG #reels');
}));

const UPLOAD_HICCUP = { debug_info: { retriable: false, type: 'ProcessingFailedError', message: 'Request processing failed' } };

test('an Instagram upload hiccup is retried without anyone pressing Retry, and goes out on time', () => withHarness(async (h) => {
  const air = h.clock.at + HOUR;
  const id = await h.schedule({ platform: 'instagram', at: air });
  h.mock.failNext('POST /ig-api-upload', 400, UPLOAD_HICCUP);

  h.clock.at = air - 15 * MINUTE;
  await h.settle();
  const waiting = h.target(id);
  assert.equal(waiting.status, 'uploading', 'it stays in progress, not Failed');
  assert.equal(waiting.attempts, 1);
  assert.match(waiting.error, /Request processing failed/);

  await h.advance(MINUTE);
  assert.notEqual(h.target(id).status, 'failed');
  assert.equal(h.target(id).error, null, 'the note clears once it works');

  await h.advance(15 * MINUTE);
  assert.equal(h.target(id).status, 'published');
  assert.equal(h.mock.state.published.length, 1);
  assert.equal(h.mock.state.published[0].at, air, 'still on time');
}));

test('an upload that keeps failing ends in Failed with the reason, after the retries', () => withHarness(async (h) => {
  const air = h.clock.at + 2 * HOUR;
  const id = await h.schedule({ platform: 'instagram', at: air });
  for (let i = 0; i < 5; i += 1) h.mock.failNext('POST /ig-api-upload', 400, UPLOAD_HICCUP);

  h.clock.at = air - 15 * MINUTE;
  await h.advance(60 * MINUTE);
  const target = h.target(id);
  assert.equal(target.status, 'failed');
  assert.match(target.error, /Request processing failed/);
  assert.equal(h.mock.state.published.length, 0);

  assert.equal((await h.api(`/api/targets/${id}/retry`, { method: 'POST' })).status, 200);
  await h.advance(5 * MINUTE);
  assert.equal(h.target(id).status, 'published', 'Retry still works by hand');
}));

test('a short Meta outage is waited out, and the cover stays with the post', () => withHarness(async (h) => {
  const { data } = await h.upload(sampleVideo());
  await h.api(`/api/videos/${data.video.id}/cover`, { method: 'POST', body: { atMs: 1500 } });
  const air = h.clock.at + HOUR;
  const outage = { error: { message: 'Cannot call API for app 1 on behalf of user 2', type: 'OAuthException', code: 200 } };
  const id = await h.schedule({ platform: 'instagram', at: air, video: data.video });
  h.mock.failNext('POST /graph/v26.0/ig-1/media', 400, outage);
  h.mock.failNext('POST /graph/v26.0/ig-1/media', 400, outage);

  h.clock.at = air - 15 * MINUTE;
  await h.settle();
  assert.equal(h.target(id).status, 'waiting');

  await h.advance(20 * MINUTE);
  assert.equal(h.target(id).status, 'published');
  const [container] = [...h.mock.state.containers.values()];
  assert.equal(container.thumbOffset, '1500', 'the cover was not dropped because of the outage');
  assert.equal(h.target(id).stage.coverNote, undefined);
}));

test('an upload error Meta marks retriable is retried, and a real one still fails at once', () => withHarness(async (h) => {
  const first = await h.schedule({ platform: 'instagram', at: h.clock.at + HOUR });
  h.clock.at += 45 * MINUTE;
  h.mock.failNext('POST /ig-api-upload', 400, { debug_info: { retriable: true, type: 'PartialRequestError', message: 'Partial request' } });
  await h.settle();
  assert.equal(h.target(first).status, 'uploading');
  assert.equal(h.target(first).attempts, 1);

  const second = await h.schedule({ platform: 'facebook', at: h.clock.at + HOUR });
  h.mock.failNext('POST /video-upload', 400, { debug_info: { retriable: false, type: 'BadRequest', message: 'Invalid video file' } });
  await h.settle();
  assert.equal(h.target(second).status, 'failed');
  assert.match(h.target(second).error, /Invalid video file/);
}));

test('publish now sends the video to every platform without waiting', () => withHarness(async (h) => {
  const { data } = await h.upload(sampleVideo());
  const start = h.clock.at;
  const res = await h.api('/api/posts', {
    method: 'POST',
    body: {
      videoId: data.video.id,
      caption: 'Langsung tayang',
      publishNow: true,
      targets: [
        { accountId: h.accounts.instagram },
        { accountId: h.accounts.facebook },
        { accountId: h.accounts.youtube, title: 'Judul sekarang' },
      ],
    },
  });
  assert.equal(res.status, 201);

  const [post] = h.store.listPosts(h.ownerId);
  assert.equal(post.publish_at, start);

  await h.advance(5 * MINUTE);
  const statuses = Object.fromEntries(h.store.listPosts(h.ownerId)[0].targets.map((t) => [t.platform, t.status]));
  assert.deepEqual(statuses, { facebook: 'published', instagram: 'published', youtube: 'published' });

  assert.equal(h.mock.state.published.length, 1, 'Instagram published without waiting for a lead time');
  const [reel] = [...h.mock.state.reels.values()];
  assert.equal(reel.videoState, 'PUBLISHED', 'Facebook published right away, not scheduled');
  const [video] = [...h.mock.state.videos.values()];
  assert.equal(video.privacy, 'public', 'YouTube went public right away');
  assert.equal(video.publishAt, null);
}));

test('publish now ignores any publish time sent with it, and only true counts', () => withHarness(async (h) => {
  const { data } = await h.upload(sampleVideo());
  const body = { videoId: data.video.id, caption: '', targets: [{ accountId: h.accounts.instagram }] };

  const early = await h.api('/api/posts', { method: 'POST', body: { ...body, publishNow: true, publishAt: h.clock.at + 100 * HOUR } });
  assert.equal(early.status, 201);
  assert.equal(h.store.getPostFor(h.ownerId, early.data.id).publish_at, h.clock.at);

  for (const publishNow of ['true', 1]) {
    const res = await h.api('/api/posts', { method: 'POST', body: { ...body, publishNow } });
    assert.equal(res.status, 422, String(publishNow));
    assert.match(res.data.error, /publish time is required/);
  }
  const soon = await h.api('/api/posts', { method: 'POST', body: { ...body, publishAt: h.clock.at + 1000 } });
  assert.equal(soon.status, 422, 'a time still needs to be a minute ahead');
}));

test('a scheduled YouTube video stays private until its time', () => withHarness(async (h) => {
  const air = h.clock.at + HOUR;
  await h.schedule({ platform: 'youtube', at: air });
  await h.settle();
  const [video] = [...h.mock.state.videos.values()];
  assert.equal(video.privacy, 'private');
  assert.equal(video.publishAt, air);
}));

test('publish now still honors the chosen cover', () => withHarness(async (h) => {
  const { data } = await h.upload(sampleVideo());
  await h.api(`/api/videos/${data.video.id}/cover`, { method: 'POST', body: { atMs: 1500 } });
  await h.api('/api/posts', {
    method: 'POST',
    body: { videoId: data.video.id, caption: '', publishNow: true, targets: [{ accountId: h.accounts.instagram }] },
  });
  await h.advance(3 * MINUTE);
  const [container] = [...h.mock.state.containers.values()];
  assert.equal(container.thumbOffset, '1500');
  assert.equal(h.mock.state.published.length, 1);
}));

let suiteHarness;
before(async () => { suiteHarness = await startHarness(); });
after(async () => { await suiteHarness.close(); });

test('platform limits stop a schedule before it can fail later', async () => {
  const h = suiteHarness;
  const { data } = await h.upload(sampleVideo());
  const air = h.clock.at + HOUR;
  const body = { videoId: data.video.id, caption: '', publishAt: air, targets: [{ accountId: h.accounts.facebook }] };
  for (let i = 0; i < 30; i += 1) {
    assert.equal((await h.api('/api/posts', { method: 'POST', body })).status, 201);
  }
  const blocked = await h.api('/api/posts', { method: 'POST', body });
  assert.equal(blocked.status, 422);
  assert.match(blocked.data.error, /limit of 30 posts/);
});

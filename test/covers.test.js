import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { HOUR, MINUTE, sampleVideo, startHarness } from './helpers.js';

const DAY = 24 * HOUR;

const imageDir = mkdtempSync(path.join(tmpdir(), 'cm-images-'));
process.on('exit', () => rmSync(imageDir, { recursive: true, force: true }));

function sampleImage(name, size = '1080x1920') {
  const file = path.join(imageDir, name);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=1`, '-frames:v', '1', file]);
  return readFileSync(file);
}

let h;
let jpeg;
let png;
before(async () => {
  h = await startHarness();
  jpeg = sampleImage('cover.jpg');
  png = sampleImage('cover.png');
});
after(async () => { await h.close(); });

const newVideo = async (harness = h) => (await harness.upload(sampleVideo())).data.video;
const coverPath = (harness, videoId) => path.join(harness.config.dataDir, 'videos', `${videoId}.cover.jpg`);

const pickFrame = (id, atMs, options = {}, harness = h) => harness.api(`/api/videos/${id}/cover`, { method: 'POST', body: { atMs }, ...options });

async function uploadImage(id, bytes, type = 'image/jpeg', { as, harness = h } = {}) {
  const res = await harness.fetch(`/api/videos/${id}/cover`, { ...(as !== undefined ? { as } : {}), method: 'PUT', headers: { 'Content-Type': type }, body: bytes });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

test('a frame from the video becomes the cover, is counted, and shows on the schedule', async () => {
  const fresh = await startHarness();
  try {
    const video = await newVideo(fresh);
    const before = (await fresh.api('/api/state')).data.storage.usedBytes;

    const { status, data } = await pickFrame(video.id, 1500, {}, fresh);
    assert.equal(status, 200);
    assert.equal(data.cover.offsetMs, 1500);
    assert.ok(data.cover.size > 0);

    const served = await fresh.fetch(data.cover.url);
    assert.equal(served.status, 200);
    assert.match(served.headers.get('content-type'), /jpeg/);
    const bytes = Buffer.from(await served.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);

    assert.equal((await fresh.api('/api/state')).data.storage.usedBytes, before + data.cover.size);

    const thumb = Buffer.from(await (await fresh.fetch(video.thumbUrl)).arrayBuffer());
    assert.ok(thumb.equals(bytes), 'the thumbnail is now the cover');
  } finally {
    await fresh.close();
  }
});

test('a position past the end of the video uses the last frame', async () => {
  const video = await newVideo();
  const { status, data } = await pickFrame(video.id, 10 * 60_000);
  assert.equal(status, 200);
  assert.ok(data.cover.offsetMs < 4000);
});

test('bad positions are refused', async () => {
  const video = await newVideo();
  for (const atMs of [-1, 'soon', null]) {
    assert.equal((await pickFrame(video.id, atMs)).status, 422, String(atMs));
  }
});

test('a JPG or PNG becomes a JPEG cover, whichever was sent', async () => {
  for (const [bytes, type] of [[jpeg, 'image/jpeg'], [png, 'image/png']]) {
    const video = await newVideo();
    const { status, data } = await uploadImage(video.id, bytes, type);
    assert.equal(status, 200, type);
    assert.equal(data.cover.offsetMs, null);
    const stored = readFileSync(coverPath(h, video.id));
    assert.deepEqual([...stored.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    assert.ok(stored.length <= 2 * 1024 * 1024, 'small enough for every platform');
  }
});

test('anything that is not a real image of a usable size is refused', async () => {
  const video = await newVideo();
  const cases = [
    [Buffer.from('not an image at all'), 'image/jpeg', 415],
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png', 415],
    [jpeg, 'image/gif', 415],
    [Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(200)]), 'image/jpeg', 422],
    [sampleImage('tiny.jpg', '100x100'), 'image/jpeg', 422],
    [Buffer.concat([jpeg, Buffer.alloc(8 * 1024 * 1024)]), 'image/jpeg', 413],
  ];
  for (const [bytes, type, expected] of cases) {
    const res = await uploadImage(video.id, bytes, type);
    assert.equal(res.status, expected, `${type} ${bytes.length}`);
    assert.ok(res.data.error);
  }
  assert.ok(!existsSync(coverPath(h, video.id)));
  assert.equal(h.store.getVideoFor(h.ownerId, video.id).has_cover, 0);
});

test('choosing automatic again removes the cover and frees the space', async () => {
  const video = await newVideo();
  await pickFrame(video.id, 1000);
  assert.ok(existsSync(coverPath(h, video.id)));

  assert.equal((await h.api(`/api/videos/${video.id}/cover`, { method: 'DELETE' })).status, 204);
  assert.ok(!existsSync(coverPath(h, video.id)));
  const row = h.store.getVideoFor(h.ownerId, video.id);
  assert.equal(row.has_cover, 0);
  assert.equal(row.cover_size, 0);
  assert.equal((await h.fetch(`/api/videos/${video.id}/cover`)).status, 404);
  assert.equal((await h.fetch(video.thumbUrl)).status, 200, 'back to the automatic thumbnail');
});

test('nobody else can read or change a cover', async () => {
  const other = await h.addUser('cover-other');
  const video = await newVideo();
  const { data } = await pickFrame(video.id, 1000);

  assert.equal((await h.fetch(data.cover.url, { as: other.cookie })).status, 404);
  assert.equal((await pickFrame(video.id, 1500, { as: other.cookie })).status, 404);
  assert.equal((await uploadImage(video.id, jpeg, 'image/jpeg', { as: other.cookie })).status, 404);
  assert.equal((await h.api(`/api/videos/${video.id}/cover`, { as: other.cookie, method: 'DELETE' })).status, 404);

  assert.equal((await h.fetch(data.cover.url, { as: null })).status, 401);
  assert.equal((await pickFrame(video.id, 1500, { as: null })).status, 401);
  assert.equal(h.store.getVideoFor(h.ownerId, video.id).cover_offset_ms, 1000);
});

test('a cover cannot change once the video is scheduled', async () => {
  const fresh = await startHarness();
  try {
    const video = await newVideo(fresh);
    await pickFrame(video.id, 1000, {}, fresh);
    await fresh.schedule({ platform: 'instagram', at: fresh.clock.at + 6 * HOUR, video });

    assert.equal((await pickFrame(video.id, 2000, {}, fresh)).status, 409);
    assert.equal((await uploadImage(video.id, jpeg, 'image/jpeg', { harness: fresh })).status, 409);
    assert.equal((await fresh.api(`/api/videos/${video.id}/cover`, { method: 'DELETE' })).status, 409);
  } finally {
    await fresh.close();
  }
});

test('a cover that would go over the storage limit is refused', async () => {
  const fresh = await startHarness();
  try {
    const person = await fresh.addUser('cover-limit');
    const { data } = await fresh.upload(sampleVideo(), 'v.mp4', person.cookie);
    await fresh.api(`/api/admin/users/${person.id}/storage`, { method: 'POST', body: { limitBytes: data.video.size + 10 } });

    const res = await pickFrame(data.video.id, 1000, { as: person.cookie }, fresh);
    assert.equal(res.status, 413);
    assert.match(res.data.error, /storage limit/);
    assert.ok(!existsSync(coverPath(fresh, data.video.id)));
  } finally {
    await fresh.close();
  }
});

test('Instagram gets a chosen frame as its position in the video', async () => {
  const fresh = await startHarness();
  try {
    const video = await newVideo(fresh);
    await pickFrame(video.id, 2500, {}, fresh);
    const air = fresh.clock.at + HOUR;
    const id = await fresh.schedule({ platform: 'instagram', at: air, video });

    await fresh.advance(HOUR + 5 * MINUTE);
    assert.equal(fresh.target(id).status, 'published');
    const [container] = [...fresh.mock.state.containers.values()];
    assert.equal(container.thumbOffset, '2500');
    assert.equal(container.coverUrl, null);
    assert.equal(fresh.target(id).stage.coverNote, undefined);
  } finally {
    await fresh.close();
  }
});

test('Instagram gets an uploaded image through a link that opens without login, only while needed', async () => {
  const fresh = await startHarness();
  try {
    const video = await newVideo(fresh);
    await uploadImage(video.id, jpeg, 'image/jpeg', { harness: fresh });
    const air = fresh.clock.at + HOUR;
    const id = await fresh.schedule({ platform: 'instagram', at: air, video });

    fresh.clock.at = air - 10 * MINUTE;
    await fresh.settle();
    const [container] = [...fresh.mock.state.containers.values()];
    assert.equal(container.thumbOffset, null);
    const link = new URL(container.coverUrl);
    assert.match(link.pathname, /^\/covers\/[\w-]{32}\.jpg$/);
    assert.ok(!link.pathname.includes(video.id), 'the link does not reveal the video');

    const open = await fetch(container.coverUrl);
    assert.equal(open.status, 200);
    assert.match(open.headers.get('content-type'), /jpeg/);
    assert.equal(open.headers.get('cache-control'), 'no-store');
    assert.deepEqual([...Buffer.from(await open.arrayBuffer()).subarray(0, 3)], [0xff, 0xd8, 0xff]);

    await fresh.advance(15 * MINUTE);
    assert.equal(fresh.target(id).status, 'published');
    assert.equal((await fetch(container.coverUrl)).status, 404, 'closed once Instagram no longer needs it');
  } finally {
    await fresh.close();
  }
});

test('cover links cannot be guessed or used to reach anything else', async () => {
  const fresh = await startHarness();
  try {
    const video = await newVideo(fresh);
    await uploadImage(video.id, jpeg, 'image/jpeg', { harness: fresh });
    const { cover_token: token } = fresh.store.getVideoFor(fresh.ownerId, video.id);
    assert.ok(token);
    const base = fresh.config.baseUrl;
    assert.equal((await fetch(`${base}/covers/${token}.jpg`)).status, 404, 'not open before it is scheduled');
    for (const route of [`/covers/${video.id}.jpg`, '/covers/secret.key', '/covers/..%2Fsecret.key', '/covers/x']) {
      assert.equal((await fetch(`${base}${route}`)).status, 404, route);
    }
  } finally {
    await fresh.close();
  }
});

for (const [name, fail] of [
  ['when it refuses the request', (mock) => mock.failNext('POST /graph/v26.0/ig-1/media', 400, { error: { message: 'Invalid cover image', code: 100 } }, { bodyIncludes: 'thumb_offset' })],
  ['when it fails the processing', (mock) => { mock.state.rejectCovers = true; }],
]) {
  test(`Instagram still publishes, without the cover, ${name}`, async () => {
    const fresh = await startHarness();
    try {
      fail(fresh.mock);
      const video = await newVideo(fresh);
      await pickFrame(video.id, 2000, {}, fresh);
      const air = fresh.clock.at + HOUR;
      const id = await fresh.schedule({ platform: 'instagram', at: air, video });

      await fresh.advance(HOUR + 5 * MINUTE);
      assert.equal(fresh.target(id).status, 'published');
      assert.equal(fresh.mock.state.published.length, 1);
      assert.match(fresh.target(id).stage.coverNote, /didn't accept the cover/);

      const { data } = await fresh.api('/api/posts');
      assert.match(data.posts[0].targets[0].coverNote, /didn't accept the cover/);
    } finally {
      await fresh.close();
    }
  });
}

test('an error that has nothing to do with the cover does not blame it, and a retry sends the cover again', async () => {
  const fresh = await startHarness();
  try {
    const video = await newVideo(fresh);
    await pickFrame(video.id, 2000, {}, fresh);
    const air = fresh.clock.at + HOUR;
    const id = await fresh.schedule({ platform: 'instagram', at: air, video });

    const appError = { error: { message: 'Application does not have permission', type: 'OAuthException', code: 200, fbtrace_id: 'trace-1' } };
    fresh.mock.failNext('POST /graph/v26.0/ig-1/media', 400, appError);
    fresh.mock.failNext('POST /graph/v26.0/ig-1/media', 400, appError);
    fresh.clock.at = air - 10 * MINUTE;
    await fresh.settle();

    const failed = fresh.target(id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /does not have permission/);
    assert.equal(failed.stage.coverNote, undefined, 'the cover is not named as the cause');
    assert.equal(failed.stage.skipCover, undefined);

    assert.equal((await fresh.api(`/api/targets/${id}/retry`, { method: 'POST' })).status, 200);
    await fresh.settle();
    const [container] = [...fresh.mock.state.containers.values()];
    assert.equal(container.thumbOffset, '2000', 'the retry sends the cover');
  } finally {
    await fresh.close();
  }
});

test('Meta\'s error codes reach the server log, without any token', async () => {
  const lines = [];
  const { classify } = await import('../src/platforms/http.js');
  const err = classify({
    status: 400,
    data: { error: { message: 'Cannot call API', type: 'OAuthException', code: 200, error_subcode: 33, fbtrace_id: 'abc' } },
    text: '',
  });
  lines.push(err.detail);
  assert.deepEqual(lines, ['code 200, subcode 33, OAuthException, trace abc']);
  assert.equal(err.message, 'Cannot call API');
});

test('a video Instagram truly rejects still fails after the retry without a cover', async () => {
  const fresh = await startHarness();
  try {
    const video = await newVideo(fresh);
    await pickFrame(video.id, 2000, {}, fresh);
    const air = fresh.clock.at + HOUR;
    const id = await fresh.schedule({ platform: 'instagram', at: air, video });
    fresh.mock.state.rejectCovers = true;

    fresh.clock.at = air - 10 * MINUTE;
    await fresh.settle();
    await fresh.advance(MINUTE);
    assert.equal(fresh.target(id).stage.skipCover, true);
    for (const container of fresh.mock.state.containers.values()) {
      if (container.status === 'IN_PROGRESS') container.status = 'ERROR';
    }
    await fresh.advance(2 * MINUTE);
    assert.equal(fresh.target(id).status, 'failed');
    assert.match(fresh.target(id).error, /rejected the video/);
  } finally {
    await fresh.close();
  }
});

test('Facebook gets the cover as the preferred thumbnail, once', async () => {
  const fresh = await startHarness();
  try {
    const video = await newVideo(fresh);
    await uploadImage(video.id, jpeg, 'image/jpeg', { harness: fresh });
    const air = fresh.clock.at + HOUR;
    const id = await fresh.schedule({ platform: 'facebook', at: air, video });

    await fresh.advance(6 * MINUTE);
    const { videoId } = fresh.target(id).stage;
    assert.deepEqual(fresh.mock.state.thumbnails, [{ platform: 'facebook', videoId, preferred: true, jpeg: true }]);

    await fresh.advance(HOUR + 5 * MINUTE);
    assert.equal(fresh.target(id).status, 'published');
    assert.equal(fresh.mock.state.thumbnails.length, 1);
    assert.equal(fresh.target(id).stage.coverNote, undefined);
  } finally {
    await fresh.close();
  }
});

test('a Facebook permission error leaves a note, and the post still goes out', async () => {
  const fresh = await startHarness();
  try {
    const video = await newVideo(fresh);
    await pickFrame(video.id, 1000, {}, fresh);
    const air = fresh.clock.at + HOUR;
    fresh.mock.failNext('/thumbnails', 403, { error: { message: '(#200) Permissions error', code: 200 } });
    const id = await fresh.schedule({ platform: 'facebook', at: air, video });

    await fresh.advance(HOUR + 5 * MINUTE);
    assert.equal(fresh.target(id).status, 'published');
    assert.match(fresh.target(id).stage.coverNote, /Facebook didn't accept the cover.*Permissions error/);
    assert.equal(fresh.store.getAccount(fresh.accounts.facebook).needs_reconnect, 0, 'the account stays connected');
  } finally {
    await fresh.close();
  }
});

test('a temporary Facebook error is retried, then gives up with a note', async () => {
  const fresh = await startHarness();
  try {
    const video = await newVideo(fresh);
    await pickFrame(video.id, 1000, {}, fresh);
    const air = fresh.clock.at + 2 * HOUR;
    fresh.mock.failNext('/thumbnails', 500, { error: { message: 'Temporary', code: 2 } });
    const id = await fresh.schedule({ platform: 'facebook', at: air, video });
    await fresh.advance(8 * MINUTE);
    assert.equal(fresh.mock.state.thumbnails.length, 1, 'worked on the second try');
    assert.equal(fresh.target(id).stage.coverNote, undefined);

    const second = await startHarness();
    try {
      const other = await newVideo(second);
      await pickFrame(other.id, 1000, {}, second);
      for (let i = 0; i < 3; i += 1) second.mock.failNext('/thumbnails', 500, { error: { message: 'Temporary', code: 2 } });
      const otherId = await second.schedule({ platform: 'facebook', at: second.clock.at + 2 * HOUR, video: other });
      await second.advance(10 * MINUTE);
      assert.match(second.target(otherId).stage.coverNote, /Temporary/);
      assert.notEqual(second.target(otherId).status, 'failed');
    } finally {
      await second.close();
    }
  } finally {
    await fresh.close();
  }
});

test('YouTube gets the cover through its thumbnail upload', async () => {
  const fresh = await startHarness();
  try {
    const video = await newVideo(fresh);
    await pickFrame(video.id, 1000, {}, fresh);
    const air = fresh.clock.at + HOUR;
    const id = await fresh.schedule({ platform: 'youtube', at: air, video });

    await fresh.advance(10 * MINUTE);
    const { remote_id: remoteId } = fresh.target(id);
    assert.deepEqual(fresh.mock.state.thumbnails, [{ platform: 'youtube', videoId: remoteId, jpeg: true }]);

    await fresh.advance(HOUR);
    assert.equal(fresh.target(id).status, 'published');
    assert.equal(fresh.mock.state.thumbnails.length, 1);
  } finally {
    await fresh.close();
  }
});

test('YouTube refusing a custom thumbnail leaves a note, and the post still goes out', async () => {
  const fresh = await startHarness();
  try {
    const video = await newVideo(fresh);
    await pickFrame(video.id, 1000, {}, fresh);
    const air = fresh.clock.at + HOUR;
    fresh.mock.failNext('POST /upload/youtube/v3/thumbnails/set', 403, {
      error: { code: 403, message: 'The authenticated user does not have permissions to upload custom thumbnails.', errors: [{ reason: 'forbidden' }] },
    });
    const id = await fresh.schedule({ platform: 'youtube', at: air, video });

    await fresh.advance(HOUR + 10 * MINUTE);
    assert.equal(fresh.target(id).status, 'published');
    assert.match(fresh.target(id).stage.coverNote, /YouTube didn't accept the cover/);
  } finally {
    await fresh.close();
  }
});

test('a post with no cover sends nothing extra to any platform', async () => {
  const fresh = await startHarness();
  try {
    const ids = [
      await fresh.schedule({ platform: 'instagram', at: fresh.clock.at + HOUR }),
      await fresh.schedule({ platform: 'facebook', at: fresh.clock.at + HOUR }),
      await fresh.schedule({ platform: 'youtube', at: fresh.clock.at + HOUR }),
    ];
    await fresh.advance(HOUR + 10 * MINUTE);
    for (const id of ids) assert.equal(fresh.target(id).status, 'published');
    assert.deepEqual(fresh.mock.state.thumbnails, []);
    const [container] = [...fresh.mock.state.containers.values()];
    assert.equal(container.coverUrl, null);
    assert.equal(container.thumbOffset, null);
  } finally {
    await fresh.close();
  }
});

test('the cover file goes with its video in every clean-up', async () => {
  const fresh = await startHarness();
  try {
    // Removed by hand.
    const removed = await newVideo(fresh);
    await pickFrame(removed.id, 1000, {}, fresh);
    const targetId = await fresh.schedule({ platform: 'instagram', at: fresh.clock.at + 6 * HOUR, video: removed });
    await fresh.api(`/api/targets/${targetId}/cancel`, { method: 'POST' });
    const { id: postId } = fresh.store.listPosts(fresh.ownerId).find((post) => post.video_id === removed.id);
    assert.equal((await fresh.api(`/api/posts/${postId}`, { method: 'DELETE' })).status, 204);
    assert.ok(!existsSync(coverPath(fresh, removed.id)));

    // Never scheduled.
    const unused = await newVideo(fresh);
    await pickFrame(unused.id, 1000, {}, fresh);
    fresh.clock.at += DAY + HOUR;
    const started = await fresh.api('/api/uploads', { method: 'POST', body: { fileName: 'n.mp4', size: 10 } });
    await fresh.api(`/api/uploads/${started.data.id}`, { method: 'DELETE' });
    assert.ok(!existsSync(coverPath(fresh, unused.id)));

    // Removed automatically after a week.
    const old = await newVideo(fresh);
    await pickFrame(old.id, 1000, {}, fresh);
    const oldTarget = await fresh.schedule({ platform: 'instagram', at: fresh.clock.at + 6 * HOUR, video: old });
    await fresh.api(`/api/targets/${oldTarget}/cancel`, { method: 'POST' });
    fresh.clock.at += 8 * DAY;
    await fresh.settle();
    assert.ok(!existsSync(coverPath(fresh, old.id)));
    assert.equal((await fresh.api('/api/state')).data.storage.usedBytes, 0);
  } finally {
    await fresh.close();
  }
});

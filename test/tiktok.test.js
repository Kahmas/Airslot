import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { test } from 'node:test';
import { HOUR, MINUTE, sampleVideo, startHarness } from './helpers.js';

const DAY = 24 * HOUR;
const POLL = 30_000;

async function withHarness(fn) {
  const h = await startHarness();
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

function addTikTok(h, { expiresAt = h.clock.at + 2 * HOUR, refreshToken = 'tt-refresh-1' } = {}) {
  h.accounts.tiktok = h.store.upsertAccount({
    userId: h.ownerId,
    platform: 'tiktok',
    remote_id: 'tt-user-1',
    name: 'Akun TikTok',
    token: 'tt-access-token',
    refresh_token: refreshToken,
    token_expires_at: expiresAt,
  });
  return h.accounts.tiktok;
}

const shares = (h) => [...h.mock.state.tiktok.shares.values()];

async function connectTikTok(h) {
  const start = await h.fetch('/auth/tiktok/start', { redirect: 'manual' });
  const dialog = new URL(start.headers.get('location'));
  await h.fetch(`/auth/tiktok/callback?code=abc&state=${dialog.searchParams.get('state')}`, { redirect: 'manual' });
  return { dialog, flash: (await h.api('/api/state')).data.flash };
}

test('TikTok connects through its sign-in and keeps the refresh token it was given', () => withHarness(async (h) => {
  const { dialog, flash } = await connectTikTok(h);
  assert.equal(dialog.searchParams.get('client_key'), 'test-key');
  assert.deepEqual(dialog.searchParams.get('scope').split(','), ['user.info.basic', 'video.upload']);
  assert.equal(dialog.searchParams.get('redirect_uri'), `${h.config.baseUrl}/auth/tiktok/callback`);
  assert.equal(dialog.searchParams.get('response_type'), 'code');
  assert.match(flash.text, /Connected TikTok account Akun TikTok/);

  const account = h.store.listAccounts(h.ownerId).find((row) => row.platform === 'tiktok');
  assert.equal(account.name, 'Akun TikTok');
  assert.equal(h.store.getAccount(account.id).refresh_token, h.mock.state.tiktok.refreshToken);
}));

test('a TikTok sign-in without permission to send videos connects nothing', () => withHarness(async (h) => {
  h.mock.state.tiktok.scope = 'user.info.basic';
  const { flash } = await connectTikTok(h);
  assert.equal(flash.level, 'error');
  assert.match(flash.text, /permission to send videos/);
  assert.equal(h.store.listAccounts(h.ownerId).some((row) => row.platform === 'tiktok'), false);
}));

test('TikTok can be connected from another browser profile', () => withHarness(async (h) => {
  const created = await h.api('/api/connect-links', { method: 'POST', body: { provider: 'tiktok' } });
  assert.equal(created.status, 201);
  const page = await fetch(created.data.url);
  assert.match(await page.text(), /adds the TikTok account/);
}));

test('a TikTok draft goes out at its time from a link that closes once TikTok has it', () => withHarness(async (h) => {
  addTikTok(h);
  const air = h.clock.at + HOUR;
  const id = await h.schedule({ platform: 'tiktok', at: air, caption: 'Caption TikTok #uji' });
  await h.settle();
  assert.equal(h.target(id).status, 'waiting');
  assert.equal(shares(h).length, 0, 'nothing reaches the inbox before its time');

  await h.advance(air - h.clock.at);
  assert.equal(h.target(id).status, 'processing');
  const [share] = shares(h);
  assert.equal(share.bytes, statSync(sampleVideo()).size, 'TikTok fetched the whole file');
  assert.match(share.videoUrl, /\/media\/[A-Za-z0-9_-]{32}\.mp4$/);
  assert.equal((await fetch(share.videoUrl)).status, 200, 'the link works while the send is under way');

  await h.advance(2 * MINUTE, POLL);
  assert.equal(h.target(id).status, 'handed_off');
  assert.equal((await fetch(share.videoUrl)).status, 404, 'the link closes once the draft is in the inbox');

  const { data } = await h.api('/api/posts');
  const view = data.posts[0].targets[0];
  assert.equal(view.caption, 'Caption TikTok #uji', 'the schedule can offer the caption for copying');

  share.status = 'PUBLISH_COMPLETE';
  await h.advance(10 * MINUTE);
  assert.equal(h.target(id).status, 'published');
}));

test('a draft nobody posts gives up after 3 days, and Retry sends a new one', () => withHarness(async (h) => {
  addTikTok(h);
  const id = await h.schedule({ platform: 'tiktok', at: h.clock.at + 5 * MINUTE });
  await h.advance(10 * MINUTE, POLL);
  assert.equal(h.target(id).status, 'handed_off');

  await h.advance(3 * DAY + 20 * MINUTE, HOUR);
  const target = h.target(id);
  assert.equal(target.status, 'failed');
  assert.match(target.error, /within 3 days/);

  assert.equal((await h.api(`/api/targets/${id}/retry`, { method: 'POST' })).status, 200);
  await h.advance(2 * MINUTE, POLL);
  assert.equal(shares(h).length, 2);
  assert.equal(h.target(id).status, 'handed_off');
}));

test('a full TikTok inbox fails the post with what to do', () => withHarness(async (h) => {
  addTikTok(h);
  h.mock.state.tiktok.tooManyPending = true;
  const id = await h.schedule({ platform: 'tiktok', at: h.clock.at + 2 * MINUTE });
  await h.advance(3 * MINUTE);
  const target = h.target(id);
  assert.equal(target.status, 'failed');
  assert.match(target.error, /at most 5 drafts/);
}));

test('a video TikTok could not fetch is sent again without anyone pressing Retry', () => withHarness(async (h) => {
  addTikTok(h);
  const id = await h.schedule({ platform: 'tiktok', at: h.clock.at + 2 * MINUTE });
  await h.advance(2 * MINUTE);
  const [first] = shares(h);
  first.status = 'FAILED';
  first.failReason = 'video_pull_failed';

  await h.advance(3 * MINUTE, POLL);
  assert.equal(shares(h).length, 2);
  assert.equal(h.target(id).status, 'handed_off');
}));

test('a video TikTok refuses ends in Failed with the reason', () => withHarness(async (h) => {
  addTikTok(h);
  const id = await h.schedule({ platform: 'tiktok', at: h.clock.at + 2 * MINUTE });
  await h.advance(2 * MINUTE);
  const [share] = shares(h);
  share.status = 'FAILED';
  share.failReason = 'frame_rate_check_failed';
  await h.advance(MINUTE, POLL);
  const target = h.target(id);
  assert.equal(target.status, 'failed');
  assert.match(target.error, /frame rate/);
}));

test('two TikTok posts due together share one token refresh instead of locking the account out', () => withHarness(async (h) => {
  const accountId = addTikTok(h, { expiresAt: h.clock.at - MINUTE });
  const air = h.clock.at + 10 * MINUTE;
  const first = await h.schedule({ platform: 'tiktok', at: air });
  const second = await h.schedule({ platform: 'tiktok', at: air });
  await h.advance(12 * MINUTE, POLL);

  assert.equal(h.mock.state.tiktok.refreshCalls, 1);
  assert.equal(h.target(first).status, 'handed_off');
  assert.equal(h.target(second).status, 'handed_off');
  const account = h.store.getAccount(accountId);
  assert.equal(account.needs_reconnect, 0);
  assert.equal(account.refresh_token, h.mock.state.tiktok.refreshToken, 'the new refresh token is the one kept');
}));

test('a TikTok refresh token that no longer works asks for a reconnect', () => withHarness(async (h) => {
  const accountId = addTikTok(h, { expiresAt: h.clock.at - MINUTE, refreshToken: 'tt-refresh-old' });
  const id = await h.schedule({ platform: 'tiktok', at: h.clock.at + 2 * MINUTE });
  await h.advance(3 * MINUTE);
  assert.equal(h.target(id).status, 'failed');
  assert.match(h.target(id).error, /Reconnect/);
  assert.equal(h.store.getAccount(accountId).needs_reconnect, 1);
}));

test('a TikTok media link opens for nothing else', () => withHarness(async (h) => {
  for (const file of ['A'.repeat(32) + '.mp4', 'short.mp4', '../videos/x.mp4']) {
    assert.equal((await fetch(`${h.config.baseUrl}/media/${file}`)).status, 404, file);
  }
}));

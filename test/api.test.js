import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { HOUR, sampleVideo, startHarness } from './helpers.js';

let h;
before(async () => { h = await startHarness(); });
after(async () => { await h.close(); });

const validBody = (videoId, overrides = {}) => ({
  videoId,
  caption: 'halo',
  publishAt: h.clock.at + HOUR,
  targets: [{ accountId: h.accounts.instagram }],
  ...overrides,
});

test('upload returns spec checks per platform', async () => {
  const { status, data } = await h.upload(sampleVideo());
  assert.equal(status, 201);
  assert.equal(data.video.info.width, 1080);
  assert.equal(data.checks.instagram.ok, true);
  assert.equal(data.checks.facebook.ok, true);
  assert.ok(data.video.thumbUrl);
});

test('upload moves the moov atom to the front automatically', async () => {
  const { data } = await h.upload(sampleVideo({ faststart: false }));
  assert.equal(data.video.info.moovFirst, true);
  assert.deepEqual(data.checks.instagram.issues, []);
});

test('uploaded video and thumbnail are served, with range support', async () => {
  const { data } = await h.upload(sampleVideo());
  const ranged = await h.fetch(data.video.fileUrl, { headers: { Range: 'bytes=0-99' } });
  assert.equal(ranged.status, 206);
  assert.equal((await ranged.arrayBuffer()).byteLength, 100);
  const thumb = await h.fetch(data.video.thumbUrl);
  assert.equal(thumb.status, 200);
  assert.match(thumb.headers.get('content-type'), /jpeg/);
});

test('a file that is not a video is rejected and removed', async () => {
  const fake = path.join(tmpdir(), `bukan-video-${Date.now()}.mp4`);
  writeFileSync(fake, 'ini bukan video');
  const { status, data } = await h.upload(fake, 'palsu.mp4');
  assert.equal(status, 422);
  assert.match(data.error, /can't be read/);
});

test('an unsupported extension is rejected before saving', async () => {
  const { status, data } = await h.upload(sampleVideo(), 'dokumen.exe');
  assert.equal(status, 415);
  assert.match(data.error, /MP4 or MOV/);
});

test('scheduling rejects missing or invalid input with a clear message', async () => {
  const { data } = await h.upload(sampleVideo());
  const id = data.video.id;
  const cases = [
    [validBody('missing'), /has not been uploaded/],
    [validBody(id, { publishAt: h.clock.at - 1 }), /at least 1 minute/],
    [validBody(id, { publishAt: 'tomorrow' }), /publish time is required/],
    [validBody(id, { targets: [] }), /at least one account/],
    [validBody(id, { targets: [{ accountId: 'gone' }] }), /no longer connected/],
    [validBody(id, { targets: [{ accountId: h.accounts.youtube }] }), /YouTube title is required/],
    [validBody(id, { targets: [{ accountId: h.accounts.instagram, caption: 'x'.repeat(2201) }] }), /2,200/],
  ];
  for (const [body, pattern] of cases) {
    const res = await h.api('/api/posts', { method: 'POST', body });
    assert.equal(res.status, 422, pattern.source);
    assert.match(res.data.error, pattern);
  }
});

test('a video that breaks a platform rule cannot be scheduled there', async () => {
  const { data } = await h.upload(sampleVideo({ width: 1280, height: 720 }));
  assert.equal(data.checks.facebook.ok, false);
  const res = await h.api('/api/posts', {
    method: 'POST',
    body: validBody(data.video.id, { targets: [{ accountId: h.accounts.facebook }] }),
  });
  assert.equal(res.status, 422);
  assert.match(res.data.error, /9:16/);
  const allowed = await h.api('/api/posts', { method: 'POST', body: validBody(data.video.id) });
  assert.equal(allowed.status, 201, 'Instagram only warns on the same file');
});

test('requests from another site are refused', async () => {
  const res = await h.api('/api/posts', {
    method: 'POST',
    headers: { Origin: 'https://situs-lain.example' },
    body: {},
  });
  assert.equal(res.status, 403);

  // fetch cannot forge a Host header, and that forgery is what DNS rebinding looks like.
  const status = await new Promise((resolve, reject) => {
    http.get({ port: h.config.port, path: '/api/state', headers: { Host: 'situs-lain.example' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 403);
});

test('tokens are sealed in the database and never returned by the API', async () => {
  const { data } = await h.api('/api/state');
  const text = JSON.stringify(data);
  assert.ok(!text.includes('ig-page-token'));
  assert.ok(!('token' in data.accounts[0]));

  const db = new DatabaseSync(path.join(h.config.dataDir, 'airslot.db'), { readOnly: true });
  const stored = db.prepare('SELECT token FROM accounts').all().map((row) => row.token).join();
  db.close();
  assert.ok(!stored.includes('page-token'));
  assert.ok(readFileSync(path.join(h.config.dataDir, 'secret.key')).length === 32);
});

test('an account with active schedules cannot be disconnected', async () => {
  const { data } = await h.upload(sampleVideo());
  await h.api('/api/posts', { method: 'POST', body: validBody(data.video.id) });
  const res = await h.api(`/api/accounts/${h.accounts.instagram}`, { method: 'DELETE' });
  assert.equal(res.status, 409);
  assert.match(res.data.error, /active post/);
});

test('a finished post can be removed and its file is cleaned up', async () => {
  const { data } = await h.upload(sampleVideo());
  const created = await h.api('/api/posts', {
    method: 'POST',
    body: validBody(data.video.id, { targets: [{ accountId: h.accounts.instagram, caption: 'hapus saya' }] }),
  });
  const postId = created.data.id;
  const targetId = h.store.listPosts(h.ownerId).find((p) => p.id === postId).targets[0].id;

  assert.equal((await h.api(`/api/posts/${postId}`, { method: 'DELETE' })).status, 409);
  await h.api(`/api/targets/${targetId}/cancel`, { method: 'POST' });
  assert.equal((await h.api(`/api/posts/${postId}`, { method: 'DELETE' })).status, 204);
  assert.equal(h.store.getPostFor(h.ownerId, postId), null);
  const gone = await h.fetch(data.video.fileUrl);
  assert.equal(gone.status, 404);
});

test('Meta login stores the Page and its linked Instagram account', async () => {
  const start = await h.fetch(`/auth/meta/start`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const dialog = new URL(start.headers.get('location'));
  assert.equal(dialog.searchParams.get('client_id'), 'test-app');
  assert.equal(dialog.searchParams.get('redirect_uri'), `${h.config.baseUrl}/auth/meta/callback`);

  const state = dialog.searchParams.get('state');
  const callback = await h.fetch(`/auth/meta/callback?code=abc&state=${state}`, { redirect: 'manual' });
  assert.equal(callback.status, 302);

  const { data } = await h.api('/api/state');
  assert.match(data.flash.text, /1 Facebook Page, 1 Instagram account/);
  assert.ok(data.accounts.some((a) => a.platform === 'instagram' && a.name === '@akun_uji'));
  assert.ok(data.accounts.some((a) => a.platform === 'facebook' && a.name === 'Page Uji'));

  const again = await h.api('/api/state');
  assert.equal(again.data.flash, null, 'the notice shows once');
});

async function signInWithMeta() {
  const start = await h.fetch(`/auth/meta/start`, { redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  await h.fetch(`/auth/meta/callback?code=abc&state=${state}`, { redirect: 'manual' });
  return (await h.api('/api/state')).data;
}

test('a Page reached through a business portfolio is found from the grant', async (t) => {
  t.mock.method(console, 'error', () => {});
  h.mock.state.emptyMeAccounts = true;
  h.mock.state.grantedScopes = [
    { scope: 'pages_show_list', target_ids: ['biz-page'] },
    { scope: 'pages_manage_posts', target_ids: ['biz-page'] },
    { scope: 'instagram_content_publish', target_ids: ['biz-ig'] },
  ];
  h.mock.state.businessPages = {
    'biz-page': {
      id: 'biz-page',
      name: 'Business Page',
      access_token: 'biz-page-token',
      instagram_business_account: { id: 'biz-ig', username: 'biz_account' },
    },
  };
  try {
    const data = await signInWithMeta();
    assert.match(data.flash.text, /1 Facebook Page, 1 Instagram account/);
    assert.ok(data.accounts.some((a) => a.platform === 'facebook' && a.name === 'Business Page'));
    assert.ok(data.accounts.some((a) => a.platform === 'instagram' && a.name === '@biz_account'));
    const logged = console.error.mock.calls.map((call) => call.arguments.join(' ')).join('\n');
    assert.match(logged, /Pages recovered: 1/);
    assert.ok(!logged.includes('biz-page-token') && !logged.includes('long-lived-user'), 'tokens stay out of the log');
  } finally {
    h.mock.state.emptyMeAccounts = false;
    h.mock.state.grantedScopes = [];
    h.mock.state.businessPages = {};
  }
});

test('a grant with no reachable Page explains itself instead of connecting nothing silently', async (t) => {
  t.mock.method(console, 'error', () => {});
  h.mock.state.emptyMeAccounts = true;
  h.mock.state.grantedScopes = [{ scope: 'pages_show_list', target_ids: ['no-token-page'] }];
  h.mock.state.businessPages = { 'no-token-page': { id: 'no-token-page', name: 'Locked Page' } };
  try {
    const data = await signInWithMeta();
    assert.match(data.flash.text, /returned no Facebook Page/);
    assert.ok(!data.accounts.some((a) => a.name === 'Locked Page'));
  } finally {
    h.mock.state.emptyMeAccounts = false;
    h.mock.state.grantedScopes = [];
    h.mock.state.businessPages = {};
  }
});

test('OAuth state is single-use and forged state is refused', async () => {
  const forged = await h.fetch(`/auth/meta/callback?code=abc&state=palsu`, { redirect: 'manual' });
  assert.equal(forged.status, 302);
  assert.match((await h.api('/api/state')).data.flash.text, /expired/);

  const start = await h.fetch(`/auth/google/start`, { redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  await h.fetch(`/auth/google/callback?code=abc&state=${state}`, { redirect: 'manual' });
  await h.api('/api/state');
  await h.fetch(`/auth/google/callback?code=abc&state=${state}`, { redirect: 'manual' });
  assert.match((await h.api('/api/state')).data.flash.text, /expired/);
});

test('Google login stores the channel with a refresh token', async () => {
  const start = await h.fetch(`/auth/google/start`, { redirect: 'manual' });
  const auth = new URL(start.headers.get('location'));
  assert.equal(auth.searchParams.get('access_type'), 'offline');
  assert.match(auth.searchParams.get('scope'), /youtube\.force-ssl/);
  await h.fetch(`/auth/google/callback?code=abc&state=${auth.searchParams.get('state')}`, { redirect: 'manual' });
  const { data } = await h.api('/api/state');
  assert.match(data.flash.text, /Kanal Uji/);
  assert.equal(h.store.getAccount(h.accounts.youtube).refresh_token, 'yt-refresh-token');
});

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { HOUR, startHarness } from './helpers.js';

let h;
before(async () => { h = await startHarness(); });
after(async () => { await h.close(); });

const stranger = { as: null };

async function makeLink(person, provider = 'meta') {
  const res = await h.api('/api/connect-links', { as: person.cookie, method: 'POST', body: { provider } });
  assert.equal(res.status, 201);
  return new URL(res.data.url).pathname;
}

// Presses Continue as a browser with whatever session is given, and returns the state sent to the platform.
async function pressContinue(path, options = stranger) {
  const res = await h.fetch(path, { ...options, method: 'POST', redirect: 'manual' });
  return { res, state: res.status === 303 ? new URL(res.headers.get('location')).searchParams.get('state') : null };
}

const finishSignIn = (provider, state, options = stranger) => h.fetch(`/auth/${provider}/callback?code=abc&state=${state}`, { ...options, redirect: 'manual' });

test('making a link needs a login and a real platform', async () => {
  const person = await h.addUser('link-rules');
  assert.equal((await h.api('/api/connect-links', { ...stranger, method: 'POST', body: { provider: 'meta' } })).status, 401);
  for (const provider of ['twitter', 'constructor', '__proto__', null]) {
    assert.equal((await h.api('/api/connect-links', { as: person.cookie, method: 'POST', body: { provider } })).status, 422, String(provider));
  }
});

test('making a link says so plainly when the platform is not set up', async () => {
  const fresh = await startHarness({ configure: (config) => { config.meta.appId = null; } });
  try {
    const res = await fresh.api('/api/connect-links', { method: 'POST', body: { provider: 'meta' } });
    assert.equal(res.status, 422);
    assert.match(res.data.error, /isn't set up/);
  } finally {
    await fresh.close();
  }
});

test('a browser with no Airslot login can connect an account to the person who made the link', async () => {
  const person = await h.addUser('other-profile');
  const path = await makeLink(person);

  const page = await h.fetch(path, stranger);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const html = await page.text();
  assert.match(html, /other-profile/, 'it names the Airslot login that gets the account');
  assert.match(html, /Only continue if you made this link yourself/);

  const { res, state } = await pressContinue(path);
  assert.equal(res.status, 303);
  assert.ok(state);

  const done = await finishSignIn('meta', state);
  assert.equal(done.status, 200);
  const result = await done.text();
  assert.match(result, /Connected 1 Facebook Page, 1 Instagram account/);
  assert.match(result, /close this window/);

  const { data } = await h.api('/api/state', { as: person.cookie });
  assert.equal(data.accounts.length, 2);
  assert.match(data.flash.text, /Connected 1 Facebook Page/, 'the first window hears about it too');
});

test('a YouTube link offers a choice of Google account and connects the channel', async () => {
  const person = await h.addUser('other-profile-yt');
  const path = await makeLink(person, 'google');
  const { res, state } = await pressContinue(path);
  const dialog = new URL(res.headers.get('location'));
  assert.match(dialog.searchParams.get('prompt'), /select_account/);
  assert.equal(dialog.searchParams.get('access_type'), 'offline');

  await (await finishSignIn('google', state)).text();
  const { data } = await h.api('/api/state', { as: person.cookie });
  assert.deepEqual(data.accounts.map((account) => account.name), ['Kanal Uji']);
});

test('the account goes to the link\'s owner, even if another person is logged in on that browser', async () => {
  const owner = await h.addUser('link-owner');
  const other = await h.addUser('logged-in-here');
  const path = await makeLink(owner);

  const page = await h.fetch(path, { as: other.cookie });
  assert.match(await page.text(), /link-owner/);
  const { state } = await pressContinue(path, { as: other.cookie });
  await (await finishSignIn('meta', state, { as: other.cookie })).text();

  assert.equal(h.store.countAccounts(owner.id), 2);
  assert.equal(h.store.countAccounts(other.id), 0);
});

test('opening a link does not use it up, but pressing Continue does', async () => {
  const person = await h.addUser('one-use');
  const path = await makeLink(person);
  for (let i = 0; i < 3; i += 1) assert.equal((await h.fetch(path, stranger)).status, 200, 'link checkers can open it');

  assert.equal((await pressContinue(path)).res.status, 303);
  const again = await pressContinue(path);
  assert.equal(again.res.status, 410);
  assert.match(await again.res.text(), /no longer works/);
  assert.equal((await h.fetch(path, stranger)).status, 410);
});

test('a link stops working after 15 minutes', async () => {
  const fresh = await startHarness();
  try {
    const person = await fresh.addUser('expires');
    const { data } = await fresh.api('/api/connect-links', { as: person.cookie, method: 'POST', body: { provider: 'meta' } });
    const path = new URL(data.url).pathname;
    assert.equal(data.expiresAt, fresh.clock.at + 15 * 60_000);

    fresh.clock.at += 14 * 60_000;
    assert.equal((await fresh.fetch(path, stranger)).status, 200);
    fresh.clock.at += 2 * 60_000;
    assert.equal((await fresh.fetch(path, stranger)).status, 410);
    assert.equal((await fresh.fetch(path, { ...stranger, method: 'POST', redirect: 'manual' })).status, 410);
    fresh.clock.at += HOUR;
  } finally {
    await fresh.close();
  }
});

test('a new link replaces the person\'s earlier one for that platform, and leaves the other platform alone', async () => {
  const person = await h.addUser('replaced');
  const first = await makeLink(person, 'meta');
  const youtube = await makeLink(person, 'google');
  const second = await makeLink(person, 'meta');

  assert.equal((await h.fetch(first, stranger)).status, 410);
  assert.equal((await h.fetch(second, stranger)).status, 200);
  assert.equal((await h.fetch(youtube, stranger)).status, 200);
});

test('made-up links are refused', async () => {
  for (const route of ['/connect/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '/connect/constructor', '/connect/__proto__']) {
    assert.equal((await h.fetch(route, stranger)).status, 410, route);
  }
});

test('a link can\'t be pressed from another site', async () => {
  const person = await h.addUser('cross-site');
  const path = await makeLink(person);
  const res = await h.fetch(path, { ...stranger, method: 'POST', redirect: 'manual', headers: { Origin: 'https://other.example.com' } });
  assert.equal(res.status, 403);
  assert.equal((await pressContinue(path)).res.status, 303, 'and it was not used up');
});

test('the account limit still applies through a link', async () => {
  const person = await h.addUser('limited-link');
  await h.api(`/api/admin/users/${person.id}/account-limit`, { method: 'POST', body: { limit: 1 } });
  const { state } = await pressContinue(await makeLink(person));
  const html = await (await finishSignIn('meta', state)).text();
  assert.match(html, /left out @akun_uji/);
  assert.equal(h.store.countAccounts(person.id), 1);
});

test('a person turned off after making a link can\'t receive an account through it', async () => {
  const person = await h.addUser('turned-off-link');
  const path = await makeLink(person);
  const { state } = await pressContinue(path);
  await h.api(`/api/admin/users/${person.id}/disable`, { method: 'POST' });

  const done = await finishSignIn('meta', state);
  assert.equal(done.status, 410);
  await done.text();
  assert.equal(h.store.countAccounts(person.id), 0);

  const person2 = await h.addUser('turned-off-link-2');
  const path2 = await makeLink(person2);
  await h.api(`/api/admin/users/${person2.id}/disable`, { method: 'POST' });
  assert.equal((await h.fetch(path2, stranger)).status, 410);
});

test('a sign-in started normally still needs its own login to finish', async () => {
  const person = await h.addUser('normal-sign-in');
  const start = await h.fetch('/auth/meta/start', { as: person.cookie, redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');

  const res = await finishSignIn('meta', state);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/#/login');
  await res.arrayBuffer();
  assert.equal(h.store.countAccounts(person.id), 0);
});

test('a state from a link only works for its own platform and only once', async () => {
  const person = await h.addUser('state-rules');
  const { state } = await pressContinue(await makeLink(person));

  const wrong = await finishSignIn('google', state);
  assert.equal(wrong.headers.get('location'), '/#/login');
  await wrong.arrayBuffer();
  const replay = await finishSignIn('meta', state);
  assert.equal(replay.headers.get('location'), '/#/login');
  await replay.arrayBuffer();
  assert.equal(h.store.countAccounts(person.id), 0);
});

test('names from a platform can\'t inject markup into the result page', async () => {
  const person = await h.addUser('escapes');
  h.mock.state.youtubeChannel = { id: 'evil', snippet: { title: '<script>alert(1)</script>' } };
  try {
    const { state } = await pressContinue(await makeLink(person, 'google'));
    const html = await (await finishSignIn('google', state)).text();
    assert.ok(!html.includes('<script>alert'));
    assert.match(html, /&lt;script&gt;/);
  } finally {
    delete h.mock.state.youtubeChannel;
  }
});

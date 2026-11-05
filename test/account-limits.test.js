import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { createStore } from '../src/store.js';
import { createVault } from '../src/vault.js';
import { startHarness } from './helpers.js';

let h;
before(async () => { h = await startHarness(); });
after(async () => { await h.close(); });

const state = async (person) => (await h.api('/api/state', person ? { as: person.cookie } : {})).data;
const setLimit = (person, limit) => h.api(`/api/admin/users/${person.id}/account-limit`, { method: 'POST', body: { limit } });

async function connect(person, provider) {
  const start = await h.fetch(`/auth/${provider}/start`, { as: person.cookie, redirect: 'manual' });
  const stateParam = new URL(start.headers.get('location')).searchParams.get('state');
  await h.fetch(`/auth/${provider}/callback?code=abc&state=${stateParam}`, { as: person.cookie, redirect: 'manual' });
  return state(person);
}

// Makes the next Meta sign-in see these Pages, as if another Facebook login were used.
function withMetaPages(pages) {
  h.mock.state.emptyMeAccounts = true;
  h.mock.state.grantedScopes = [{ scope: 'pages_show_list', target_ids: pages.map((page) => page.id) }];
  h.mock.state.businessPages = Object.fromEntries(pages.map((page) => [page.id, page]));
}

function resetMeta() {
  h.mock.state.emptyMeAccounts = false;
  h.mock.state.grantedScopes = [];
  h.mock.state.businessPages = {};
}

const page = (id, ig) => ({
  id,
  name: `Page ${id}`,
  access_token: `${id}-token`,
  ...(ig ? { instagram_business_account: { id: `${id}-ig`, username: ig } } : {}),
});

test('the default is 3 accounts, and it can be changed for the server', () => {
  assert.equal(loadConfig({}).accounts.perUser, 3);
  assert.equal(loadConfig({ USER_ACCOUNT_LIMIT: '5' }).accounts.perUser, 5);
});

test('a person sees their limit, and an admin has none', async () => {
  const person = await h.addUser('sees-limit');
  assert.equal((await state(person)).accountLimit, 3);
  assert.equal((await state()).accountLimit, null);
});

test('one login can hold accounts from two Facebook logins and two Google accounts', async (t) => {
  t.mock.method(console, 'error', () => {});
  const person = await h.addUser('two-emails');
  await setLimit(person, 10);
  try {
    withMetaPages([page('first', 'first_ig')]);
    await connect(person, 'meta');
    withMetaPages([page('second', 'second_ig')]);
    await connect(person, 'meta');
  } finally {
    resetMeta();
  }

  h.mock.state.youtubeChannel = { id: 'channel-a', snippet: { title: 'Channel A' } };
  await connect(person, 'google');
  h.mock.state.youtubeChannel = { id: 'channel-b', snippet: { title: 'Channel B' } };
  const { accounts } = await connect(person, 'google');
  delete h.mock.state.youtubeChannel;

  const names = accounts.map((account) => account.name).sort();
  assert.deepEqual(names, ['@first_ig', '@second_ig', 'Channel A', 'Channel B', 'Page first', 'Page second']);
});

test('Google always offers a choice of account', async () => {
  const person = await h.addUser('google-choice');
  const start = await h.fetch('/auth/google/start', { as: person.cookie, redirect: 'manual' });
  const prompt = new URL(start.headers.get('location')).searchParams.get('prompt');
  assert.ok(prompt.split(' ').includes('select_account'));
  assert.ok(prompt.split(' ').includes('consent'), 'consent is what gets a refresh token');
});

test('a Meta sign-in over the limit connects what fits and says what it left out', async (t) => {
  t.mock.method(console, 'error', () => {});
  const person = await h.addUser('over-limit');
  await setLimit(person, 2);
  try {
    withMetaPages([page('one', 'one_ig'), page('two', 'two_ig')]);
    const { accounts, flash } = await connect(person, 'meta');
    assert.equal(accounts.length, 2);
    assert.match(flash.text, /Connected 1 Facebook Page, 1 Instagram account\./);
    assert.match(flash.text, /limit of 2 accounts left out Page two, @two_ig/);
    assert.match(flash.text, /ask your admin/);
  } finally {
    resetMeta();
  }
});

test('with no room at all, nothing is connected and the message says why', async () => {
  const person = await h.addUser('no-room');
  await setLimit(person, 0);
  const { accounts, flash } = await connect(person, 'meta');
  assert.deepEqual(accounts, []);
  assert.match(flash.text, /Nothing new was connected/);
  assert.match(flash.text, /limit of 0 accounts left out Page Uji, @akun_uji/);

  const youtube = await connect(person, 'google');
  assert.deepEqual(youtube.accounts, []);
  assert.match(youtube.flash.text, /Nothing new was connected/);
  assert.equal(h.store.countAccounts(person.id), 0);
});

test('connecting an account again refreshes it, even at the limit', async () => {
  const person = await h.addUser('reconnects');
  await setLimit(person, 2);
  const first = await connect(person, 'meta');
  assert.equal(first.accounts.length, 2);

  const account = first.accounts[0];
  h.store.markNeedsReconnect(account.id);
  assert.equal((await state(person)).accounts.find((item) => item.id === account.id).needsReconnect, true);

  const again = await connect(person, 'meta');
  assert.equal(again.accounts.length, 2);
  assert.match(again.flash.text, /Connected 1 Facebook Page, 1 Instagram account\.$/);
  assert.equal(again.accounts.find((item) => item.id === account.id).needsReconnect, false);
});

test('a lower limit keeps what is connected and stops new accounts, and a higher one lets them in', async () => {
  const person = await h.addUser('limit-changes');
  await connect(person, 'meta');
  await setLimit(person, 1);
  assert.equal((await state(person)).accounts.length, 2, 'nothing is disconnected');

  const refused = await connect(person, 'google');
  assert.equal(refused.accounts.length, 2);
  assert.match(refused.flash.text, /limit of 1 account left out Kanal Uji/);

  await setLimit(person, 3);
  const allowed = await connect(person, 'google');
  assert.equal(allowed.accounts.length, 3);
});

test('disconnecting an account makes room for another', async () => {
  const person = await h.addUser('makes-room');
  await setLimit(person, 1);
  const { accounts } = await connect(person, 'google');
  assert.equal(accounts.length, 1);
  assert.match((await connect(person, 'meta')).flash.text, /Nothing new was connected/);

  assert.equal((await h.api(`/api/accounts/${accounts[0].id}`, { as: person.cookie, method: 'DELETE' })).status, 204);
  assert.equal((await connect(person, 'meta')).accounts.length, 1);
});

test('one person reaching their limit does not touch anyone else', async () => {
  const full = await h.addUser('full-person');
  const other = await h.addUser('other-person');
  await setLimit(full, 0);
  await connect(full, 'google');
  assert.equal((await connect(other, 'google')).accounts.length, 1);
});

test('an admin has no account limit', async (t) => {
  t.mock.method(console, 'error', () => {});
  const before = h.store.countAccounts(h.ownerId);
  try {
    withMetaPages(['p1', 'p2', 'p3', 'p4'].map((id) => page(id, `${id}_ig`)));
    const owner = { cookie: h.ownerCookie };
    const { flash } = await connect(owner, 'meta');
    assert.ok(!flash.text.includes('left out'));
  } finally {
    resetMeta();
  }
  assert.equal(h.store.countAccounts(h.ownerId), before + 8);
});

test('the admin page shows each limit, and empty returns to the default', async () => {
  const person = await h.addUser('admin-view');
  const row = async () => (await h.api('/api/admin/overview')).data.users.find((user) => user.id === person.id);

  assert.equal((await row()).accountLimit, 3);
  assert.equal((await row()).customAccountLimit, false);
  assert.equal((await h.api('/api/admin/overview')).data.defaultAccountLimit, 3);
  assert.equal((await h.api('/api/admin/overview')).data.users.find((user) => user.id === h.ownerId).accountLimit, null);

  assert.equal((await setLimit(person, 7)).status, 204);
  assert.equal((await row()).accountLimit, 7);
  assert.equal((await row()).customAccountLimit, true);
  assert.equal((await state(person)).accountLimit, 7);

  assert.equal((await setLimit(person, null)).status, 204);
  assert.equal((await row()).accountLimit, 3);
  assert.equal((await row()).customAccountLimit, false);
});

test('account limits are checked, and only an admin can set them', async () => {
  const person = await h.addUser('limit-rules-2');
  for (const bad of [-1, 1.5, '3', {}]) assert.equal((await setLimit(person, bad)).status, 422, String(bad));
  const route = `/api/admin/users/${person.id}/account-limit`;
  assert.equal((await h.api(route, { as: person.cookie, method: 'POST', body: { limit: 99 } })).status, 403);
  assert.equal((await h.api(route, { as: null, method: 'POST', body: { limit: 99 } })).status, 401);
  assert.equal((await h.api(`/api/admin/users/${h.ownerId}/account-limit`, { method: 'POST', body: { limit: 1 } })).status, 409);
  assert.equal((await h.api('/api/admin/users/nobody/account-limit', { method: 'POST', body: { limit: 1 } })).status, 404);
  assert.equal(h.store.getUser(person.id).account_limit, null);
});

test('a database from before account limits gains the setting when opened', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-account-limit-'));
  const dbPath = path.join(dir, 'airslot.db');
  const vault = createVault(Buffer.alloc(32, 7));
  try {
    const first = createStore(dbPath, vault, () => 5000);
    const id = first.createFirstAdmin({ username: 'boss', passwordHash: 'x' });
    first.close();
    const raw = new DatabaseSync(dbPath);
    raw.exec('ALTER TABLE users DROP COLUMN account_limit');
    raw.close();

    const reopened = createStore(dbPath, vault, () => 5000);
    assert.equal(reopened.getUser(id).account_limit, null);
    reopened.setAccountLimit(id, 4);
    assert.equal(reopened.getUser(id).account_limit, 4);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

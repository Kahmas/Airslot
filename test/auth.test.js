import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { hashPassword, verifyPassword } from '../src/auth.js';
import { HOUR, startHarness, TEST_PASSWORD } from './helpers.js';

const DAY = 24 * HOUR;

let h;
before(async () => { h = await startHarness(); });
after(async () => { await h.close(); });

const stranger = { as: null };
const post = (route, body, options = stranger) => h.api(route, { ...options, method: 'POST', body });
const cookieFrom = (res) => res.headers.getSetCookie().find((line) => line.startsWith('airslot_session='))?.split(';')[0];
const newInvite = async () => (await post('/api/admin/invites', {}, { as: h.ownerCookie })).data.code;

// Each test acts from its own address, so the attempt limits of one test don't reach the next.
let nextIp = 1;
const fromNewIp = () => {
  nextIp += 1;
  return { 'CF-Connecting-IP': `203.0.113.${nextIp}` };
};

test('passwords are stored as salted hashes and checked correctly', async () => {
  const first = await hashPassword('the same password');
  const second = await hashPassword('the same password');
  assert.notEqual(first, second, 'each hash has its own salt');
  assert.ok(!first.includes('the same password'));
  assert.equal(await verifyPassword('the same password', first), true);
  assert.equal(await verifyPassword('a different password', first), false);
});

test('signing up needs a valid invite code, and each code works once', async () => {
  const headers = fromNewIp();
  const signup = (username, code) => h.api('/api/auth/signup', { ...stranger, method: 'POST', headers, body: { username, password: 'a-long-password', code } });

  assert.equal((await signup('nocode')).status, 403);
  assert.equal((await signup('badcode', 'AAAA-BBBB-CCCC')).status, 403);

  const code = await newInvite();
  const joined = await signup('rina', code);
  assert.equal(joined.status, 201);
  assert.equal(joined.data.user.username, 'rina');
  assert.equal(joined.data.user.isAdmin, false);
  assert.ok(cookieFrom(joined), 'signing up also logs in');

  const again = await signup('rina2', code);
  assert.equal(again.status, 403);
  assert.match(again.data.error, /already used/);
  assert.equal(h.store.getUserByUsername('rina2'), null);
});

test('a lowercase invite code with stray spaces still works', async () => {
  const code = await newInvite();
  const res = await h.api('/api/auth/signup', {
    ...stranger,
    method: 'POST',
    headers: fromNewIp(),
    body: { username: 'typed-by-hand', password: 'a-long-password', code: `  ${code.toLowerCase()} ` },
  });
  assert.equal(res.status, 201);
});

test('a failed sign-up does not use up the invite code', async () => {
  const code = await newInvite();
  const headers = fromNewIp();
  const taken = await h.api('/api/auth/signup', { ...stranger, method: 'POST', headers, body: { username: 'owner', password: 'a-long-password', code } });
  assert.equal(taken.status, 409);
  assert.match(taken.data.error, /taken/);

  const short = await h.api('/api/auth/signup', { ...stranger, method: 'POST', headers, body: { username: 'someone', password: 'short', code } });
  assert.equal(short.status, 422);
  assert.match(short.data.error, /at least 10/);

  const fine = await h.api('/api/auth/signup', { ...stranger, method: 'POST', headers, body: { username: 'someone', password: 'a-long-password', code } });
  assert.equal(fine.status, 201);
});

test('usernames are checked, and capitals do not make a second account', async () => {
  const headers = fromNewIp();
  for (const username of ['ab', 'has space', '<script>', 'x'.repeat(33), 42, null]) {
    const res = await h.api('/api/auth/signup', { ...stranger, method: 'POST', headers, body: { username, password: 'a-long-password', code: 'unused' } });
    assert.equal(res.status, 422, String(username));
  }
  const code = await newInvite();
  const res = await h.api('/api/auth/signup', { ...stranger, method: 'POST', headers, body: { username: 'OWNER', password: 'a-long-password', code } });
  assert.equal(res.status, 409);
});

test('someone without an invite cannot find out which usernames exist', async () => {
  const headers = fromNewIp();
  const known = await h.api('/api/auth/signup', { ...stranger, method: 'POST', headers, body: { username: 'owner', password: 'a-long-password', code: 'WRONG' } });
  const unknown = await h.api('/api/auth/signup', { ...stranger, method: 'POST', headers, body: { username: 'nobody-here', password: 'a-long-password', code: 'WRONG' } });
  assert.equal(known.status, unknown.status);
  assert.equal(known.data.error, unknown.data.error);
});

test('logging in gives a working session, and logging out ends it', async () => {
  const headers = fromNewIp();
  const login = await h.api('/api/auth/login', { ...stranger, method: 'POST', headers, body: { username: 'owner', password: TEST_PASSWORD } });
  assert.equal(login.status, 200);
  const cookie = cookieFrom(login);
  assert.match(login.headers.getSetCookie()[0], /HttpOnly; SameSite=Lax/);

  assert.equal((await h.api('/api/state', { as: cookie })).status, 200);
  assert.equal((await h.api('/api/session', { as: cookie })).data.user.username, 'owner');

  assert.equal((await h.api('/api/auth/logout', { as: cookie, method: 'POST' })).status, 204);
  assert.equal((await h.api('/api/state', { as: cookie })).status, 401);
});

test('a username logs in whatever its capitals', async () => {
  const res = await h.api('/api/auth/login', { ...stranger, method: 'POST', headers: fromNewIp(), body: { username: 'OWNER', password: TEST_PASSWORD } });
  assert.equal(res.status, 200);
});

test('a wrong password and an unknown username get the same answer', async () => {
  const headers = fromNewIp();
  const wrong = await h.api('/api/auth/login', { ...stranger, method: 'POST', headers, body: { username: 'owner', password: 'not-the-password' } });
  const unknown = await h.api('/api/auth/login', { ...stranger, method: 'POST', headers, body: { username: 'ghost', password: 'not-the-password' } });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrong.data.error, unknown.data.error);
});

test('malformed logins are refused without crashing', async () => {
  const headers = fromNewIp();
  for (const body of [{}, { username: 1, password: 2 }, { username: 'owner' }, { username: 'owner', password: 'x'.repeat(5000) }]) {
    const res = await h.api('/api/auth/login', { ...stranger, method: 'POST', headers, body });
    assert.equal(res.status, 401);
  }
});

test('repeated wrong passwords are stopped, and other people can still log in', async () => {
  const headers = fromNewIp();
  const attempt = (username, password) => h.api('/api/auth/login', { ...stranger, method: 'POST', headers, body: { username, password } });

  for (let i = 0; i < h.config.limits.loginFailuresPerName; i += 1) {
    assert.equal((await attempt('owner', 'wrong-password')).status, 401);
  }
  const blocked = await attempt('owner', TEST_PASSWORD);
  assert.equal(blocked.status, 429, 'even the right password has to wait');
  assert.match(blocked.data.error, /Too many attempts/);

  const elsewhere = await h.api('/api/auth/login', { ...stranger, method: 'POST', headers: fromNewIp(), body: { username: 'owner', password: TEST_PASSWORD } });
  assert.equal(elsewhere.status, 200, 'a guesser elsewhere cannot lock the real person out');

  h.clock.at += 16 * 60_000;
  assert.equal((await attempt('owner', TEST_PASSWORD)).status, 200, 'the wait ends');
});

test('one address guessing many usernames is stopped too', async () => {
  const headers = fromNewIp();
  for (let i = 0; i < h.config.limits.loginFailuresPerIp; i += 1) {
    await h.api('/api/auth/login', { ...stranger, method: 'POST', headers, body: { username: `guess-${i}`, password: 'wrong-password' } });
  }
  const blocked = await h.api('/api/auth/login', { ...stranger, method: 'POST', headers, body: { username: 'another', password: 'wrong-password' } });
  assert.equal(blocked.status, 429);
});

test('repeated sign-up attempts are stopped', async () => {
  const headers = fromNewIp();
  for (let i = 0; i < h.config.limits.signupPerHour; i += 1) {
    const res = await h.api('/api/auth/signup', { ...stranger, method: 'POST', headers, body: { username: `user-${i}`, password: 'a-long-password', code: 'WRONG' } });
    assert.equal(res.status, 403);
  }
  const code = await newInvite();
  const blocked = await h.api('/api/auth/signup', { ...stranger, method: 'POST', headers, body: { username: 'late', password: 'a-long-password', code } });
  assert.equal(blocked.status, 429);
});

test('a session lasts 30 days of no use, and using it keeps it going', async () => {
  const fresh = await startHarness();
  try {
    const person = await fresh.addUser('long-session');
    fresh.clock.at += 20 * DAY;
    const used = await fresh.api('/api/state', { as: person.cookie });
    assert.equal(used.status, 200);
    assert.ok(cookieFrom(used), 'the cookie is renewed once half its life has passed');

    fresh.clock.at += 20 * DAY;
    assert.equal((await fresh.api('/api/state', { as: person.cookie })).status, 200, 'still alive thanks to the renewal');

    fresh.clock.at += 31 * DAY;
    assert.equal((await fresh.api('/api/state', { as: person.cookie })).status, 401);
  } finally {
    await fresh.close();
  }
});

test('session tokens are not stored in the database as they are', async () => {
  const person = await h.addUser('token-check');
  const token = person.cookie.split('=')[1];
  assert.equal(h.store.getSessionUser(token), null, 'the raw token finds nothing');
});

test('changing a password needs the current one, and logs out other devices', async () => {
  const person = await h.addUser('changer');
  const otherDevice = h.sessionFor(person.id);
  const change = (body) => h.api('/api/auth/password', { as: person.cookie, method: 'POST', body });

  const wrong = await change({ current: 'wrong-password', next: 'a-brand-new-password' });
  assert.equal(wrong.status, 403);
  const short = await change({ current: TEST_PASSWORD, next: 'short' });
  assert.equal(short.status, 422);

  assert.equal((await change({ current: TEST_PASSWORD, next: 'a-brand-new-password' })).status, 204);
  assert.equal((await h.api('/api/state', { as: person.cookie })).status, 200, 'this device stays logged in');
  assert.equal((await h.api('/api/state', { as: otherDevice })).status, 401);

  const login = (password) => h.api('/api/auth/login', { ...stranger, method: 'POST', headers: fromNewIp(), body: { username: 'changer', password } });
  assert.equal((await login(TEST_PASSWORD)).status, 401);
  assert.equal((await login('a-brand-new-password')).status, 200);
});

test('the first account needs the setup code, becomes admin, and takes the existing data', async () => {
  const fresh = await startHarness({ seedOwner: false, appPassword: 'the-setup-code' });
  try {
    const session = (await fresh.api('/api/session', stranger)).data;
    assert.equal(session.needsSetup, true);
    assert.equal(session.needsSetupCode, true);

    const signup = (username, code) => fresh.api('/api/auth/signup', { ...stranger, method: 'POST', body: { username, password: 'a-long-password', code } });
    assert.equal((await signup('intruder', 'wrong-code')).status, 403);
    assert.equal((await signup('intruder')).status, 403);
    assert.equal(fresh.store.countUsers(), 0);

    const created = await signup('boss', 'the-setup-code');
    assert.equal(created.status, 201);
    assert.equal(created.data.user.isAdmin, true);

    const after = (await fresh.api('/api/session', stranger)).data;
    assert.equal(after.needsSetup, false);
    assert.equal(after.needsInvite, true);

    assert.equal((await signup('second', 'the-setup-code')).status, 403, 'the setup code only works once');
  } finally {
    await fresh.close();
  }
});

test('with open sign-up, no invite code is needed', async () => {
  const open = await startHarness({ configure: (config) => { config.signup.open = true; } });
  try {
    assert.equal((await open.api('/api/session', stranger)).data.needsInvite, false);
    const res = await open.api('/api/auth/signup', { ...stranger, method: 'POST', body: { username: 'walk-in', password: 'a-long-password' } });
    assert.equal(res.status, 201);
    assert.equal(res.data.user.isAdmin, false);
  } finally {
    await open.close();
  }
});

test('only an admin can reach the admin page', async () => {
  const person = await h.addUser('not-admin');
  const routes = [
    ['GET', '/api/admin/overview'],
    ['POST', '/api/admin/invites'],
    ['DELETE', '/api/admin/invites/ABCD'],
    ['POST', `/api/admin/users/${h.ownerId}/disable`],
    ['POST', `/api/admin/users/${h.ownerId}/enable`],
    ['POST', `/api/admin/users/${h.ownerId}/reset-password`],
  ];
  for (const [method, route] of routes) {
    assert.equal((await h.api(route, { as: person.cookie, method })).status, 403, `${method} ${route}`);
  }
  assert.equal(h.store.getUser(h.ownerId).disabled, 0);
});

test('the admin page lists people and invites, and never password hashes', async () => {
  const code = await newInvite();
  const { status, data } = await h.api('/api/admin/overview');
  assert.equal(status, 200);
  assert.ok(data.users.some((user) => user.username === 'owner' && user.isAdmin && user.limitBytes === null));
  assert.ok(data.users.some((user) => !user.isAdmin && user.limitBytes === h.config.storage.perUserBytes));
  assert.ok(data.invites.some((invite) => invite.code === code && !invite.usedBy));
  assert.ok(data.freeBytes > 0);
  assert.ok(!JSON.stringify(data).includes('scrypt'));
});

test('an invite code can be removed until it is used', async () => {
  const code = await newInvite();
  assert.equal((await h.api(`/api/admin/invites/${code}`, { method: 'DELETE' })).status, 204);
  assert.equal((await h.api(`/api/admin/invites/${code}`, { method: 'DELETE' })).status, 404);
  const res = await h.api('/api/auth/signup', { ...stranger, method: 'POST', headers: fromNewIp(), body: { username: 'too-late', password: 'a-long-password', code } });
  assert.equal(res.status, 403);
});

test('turning someone off logs them out at once, and turning them on lets them back', async () => {
  const person = await h.addUser('switched-off');
  assert.equal((await h.api(`/api/admin/users/${person.id}/disable`, { method: 'POST' })).status, 204);
  assert.equal((await h.api('/api/state', { as: person.cookie })).status, 401);

  const headers = fromNewIp();
  const login = () => h.api('/api/auth/login', { ...stranger, method: 'POST', headers, body: { username: 'switched-off', password: TEST_PASSWORD } });
  const refused = await login();
  assert.equal(refused.status, 403);
  assert.match(refused.data.error, /turned off/);

  assert.equal((await h.api(`/api/admin/users/${person.id}/enable`, { method: 'POST' })).status, 204);
  assert.equal((await login()).status, 200);
});

test('a reset password replaces the old one and logs the person out', async () => {
  const person = await h.addUser('forgetful');
  const { status, data } = await h.api(`/api/admin/users/${person.id}/reset-password`, { method: 'POST' });
  assert.equal(status, 200);
  assert.ok(data.password.length >= 12);
  assert.equal((await h.api('/api/state', { as: person.cookie })).status, 401);

  const login = (password) => h.api('/api/auth/login', { ...stranger, method: 'POST', headers: fromNewIp(), body: { username: 'forgetful', password } });
  assert.equal((await login(TEST_PASSWORD)).status, 401);
  assert.equal((await login(data.password)).status, 200);
});

test('an admin cannot turn off or reset their own account by accident', async () => {
  assert.equal((await h.api(`/api/admin/users/${h.ownerId}/disable`, { method: 'POST' })).status, 409);
  assert.equal((await h.api(`/api/admin/users/${h.ownerId}/reset-password`, { method: 'POST' })).status, 409);
  assert.equal((await h.api('/api/admin/users/nobody/disable', { method: 'POST' })).status, 404);
});

test('logins from another site are refused', async () => {
  const res = await h.api('/api/auth/login', {
    ...stranger,
    method: 'POST',
    headers: { ...fromNewIp(), Origin: 'https://other.example.com' },
    body: { username: 'owner', password: TEST_PASSWORD },
  });
  assert.equal(res.status, 403);
});

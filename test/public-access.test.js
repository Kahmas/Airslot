import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig, requiresPassword } from '../src/config.js';
import { startHarness } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_ADDRESS = 'https://airslot.example.com';

function rawRequest(port, { method = 'GET', path: route, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, method, path: route, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

function runMain(env) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      timeout: 15_000,
    }, (err, stdout, stderr) => resolve({ code: err?.code, stdout, stderr }));
  });
}

test('a setup code is required for any address other than this machine', () => {
  assert.equal(requiresPassword(loadConfig({})), false);
  assert.equal(requiresPassword(loadConfig({ HOST: '0.0.0.0' })), true);
  // The case a tunnel creates: bound locally, reachable by anyone.
  assert.equal(requiresPassword(loadConfig({ BASE_URL: PUBLIC_ADDRESS })), true);
  assert.equal(requiresPassword(loadConfig({ HOST: '127.0.0.1', BASE_URL: 'http://127.0.0.1:3000' })), false);
});

test('the app refuses to start behind a public address without a setup code', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cm-main-'));
  try {
    const { code, stderr } = await runMain({ BASE_URL: PUBLIC_ADDRESS, APP_PASSWORD: '', DATA_DIR: dataDir, PORT: '0' });
    assert.equal(code, 1);
    assert.match(stderr, /APP_PASSWORD is required/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the login page opens for anyone, and everything behind it refuses a stranger', async () => {
  const h = await startHarness();
  try {
    const stranger = { as: null };
    assert.equal((await h.fetch('/', stranger)).status, 200, 'the page itself holds no data');
    assert.equal((await h.api('/api/session', stranger)).status, 200);
    assert.equal((await h.api('/api/session', stranger)).data.user, null);

    const refused = [
      ['GET', '/api/state'],
      ['GET', '/api/posts'],
      ['POST', '/api/posts'],
      ['DELETE', '/api/posts/x'],
      ['POST', '/api/uploads'],
      ['PUT', '/api/uploads/x/chunk'],
      ['POST', '/api/uploads/x/complete'],
      ['DELETE', '/api/uploads/x'],
      ['GET', '/api/videos/x/file'],
      ['GET', '/api/videos/x/thumb'],
      ['DELETE', '/api/accounts/x'],
      ['POST', '/api/targets/x/retry'],
      ['POST', '/api/targets/x/cancel'],
      ['POST', '/api/auth/password'],
      ['GET', '/api/admin/overview'],
      ['POST', '/api/admin/invites'],
      ['POST', '/api/admin/users/x/disable'],
      ['GET', '/api/does-not-exist'],
    ];
    for (const [method, route] of refused) {
      const res = await h.fetch(route, { ...stranger, method, headers: { 'Content-Type': 'application/json' }, ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }) });
      assert.equal(res.status, 401, `${method} ${route}`);
    }

    const start = await h.fetch('/auth/meta/start', { ...stranger, redirect: 'manual' });
    assert.equal(start.status, 302);
    assert.equal(start.headers.get('location'), '/#/login', 'connecting an account needs a login first');
  } finally {
    await h.close();
  }
});

test('the page always comes fresh and points at files whose address changes with their content', async () => {
  const h = await startHarness();
  try {
    const page = await h.fetch('/', { as: null });
    assert.equal(page.headers.get('cache-control'), 'no-cache');
    const html = await page.text();

    const script = html.match(/src="(\/v\/[0-9a-f]{12}\/app\.js)"/)?.[1];
    const styles = html.match(/href="(\/v\/[0-9a-f]{12}\/styles\.css)"/)?.[1];
    assert.ok(script, 'the script address carries a version');
    assert.ok(styles, 'the stylesheet address carries a version');

    // Relative imports inside app.js have to resolve under the same version.
    const prefix = script.replace('/app.js', '');
    for (const route of [script, styles, `${prefix}/guide.js`, `${prefix}/access.js`, `${prefix}/admin.js`, `${prefix}/profile.js`, `${prefix}/clipboard.js`]) {
      const res = await h.fetch(route, { as: null });
      assert.equal(res.status, 200, route);
      assert.match(res.headers.get('cache-control'), /immutable/, route);
      await res.arrayBuffer();
    }

    assert.equal((await h.fetch('/app.js', { as: null })).status, 404, 'no unversioned copy a browser could keep');
    assert.equal((await h.fetch('/v/000000000000/app.js', { as: null })).status, 404);
    assert.equal((await h.fetch(`${prefix}/index.html`, { as: null })).status, 200, 'harmless, it holds no data');
  } finally {
    await h.close();
  }
});

test('requests arriving through a tunnel with the public hostname are accepted', async () => {
  const h = await startHarness();
  const localBase = h.config.baseUrl;
  h.config.baseUrl = PUBLIC_ADDRESS;
  try {
    const host = new URL(PUBLIC_ADDRESS).host;
    const page = await rawRequest(h.config.port, { path: '/api/state', headers: { Host: host, Cookie: h.ownerCookie } });
    assert.equal(page.status, 200);

    const write = await rawRequest(h.config.port, {
      method: 'DELETE',
      path: '/api/uploads/none',
      headers: { Host: host, Origin: PUBLIC_ADDRESS, Cookie: h.ownerCookie },
    });
    assert.equal(write.status, 204);

    const foreign = await rawRequest(h.config.port, {
      method: 'DELETE',
      path: '/api/uploads/none',
      headers: { Host: host, Origin: 'https://other.example.com', Cookie: h.ownerCookie },
    });
    assert.equal(foreign.status, 403);

    const signIn = await rawRequest(h.config.port, { path: '/auth/google/start', headers: { Host: host, Cookie: h.ownerCookie } });
    assert.equal(signIn.status, 302);
    assert.equal(new URL(signIn.headers.location).searchParams.get('redirect_uri'), `${PUBLIC_ADDRESS}/auth/google/callback`);
  } finally {
    h.config.baseUrl = localBase;
    await h.close();
  }
});

test('session cookies are marked Secure behind an https address', async () => {
  const h = await startHarness({ seedOwner: false });
  const localBase = h.config.baseUrl;
  h.config.baseUrl = PUBLIC_ADDRESS;
  try {
    const body = JSON.stringify({ username: 'first', password: 'a-long-password' });
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        port: h.config.port,
        method: 'POST',
        path: '/api/auth/signup',
        headers: { Host: new URL(PUBLIC_ADDRESS).host, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (response) => {
        response.resume();
        response.on('end', () => resolve(response));
      });
      req.on('error', reject);
      req.end(body);
    });
    assert.equal(res.statusCode, 403, 'no setup code was configured, so a public address refuses to create the admin');
  } finally {
    h.config.baseUrl = localBase;
    await h.close();
  }

  const open = await startHarness({ seedOwner: false, appPassword: 'setup-code' });
  const base = open.config.baseUrl;
  open.config.baseUrl = PUBLIC_ADDRESS;
  try {
    const body = JSON.stringify({ username: 'first', password: 'a-long-password', code: 'setup-code' });
    const cookie = await new Promise((resolve, reject) => {
      const req = http.request({
        port: open.config.port,
        method: 'POST',
        path: '/api/auth/signup',
        headers: { Host: new URL(PUBLIC_ADDRESS).host, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.headers['set-cookie'][0]));
      });
      req.on('error', reject);
      req.end(body);
    });
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Secure/);
  } finally {
    open.config.baseUrl = base;
    await open.close();
  }
});

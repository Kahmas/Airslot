import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { startHarness } from './helpers.js';

const HOST = 'example.com';
const CONTACT = 'owner@example.com';

let h;
before(async () => { h = await startHarness({ appPassword: 'secret', site: { host: HOST, contactEmail: CONTACT } }); });
after(async () => { await h.close(); });

function request(route, { host = HOST, method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port: h.config.port, method, path: route, headers: { Host: host, ...headers } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the home page, privacy policy, and terms open without an account', async () => {
  for (const [route, text] of [['/', 'Schedule one video'], ['/privacy', 'Privacy policy'], ['/terms', 'Terms of service']]) {
    const res = await request(route);
    assert.equal(res.status, 200, route);
    assert.match(res.headers['content-type'], /html/);
    assert.ok(res.body.includes(text), route);
    assert.ok(res.body.includes(CONTACT), `${route} names the contact`);
    assert.ok(!res.body.includes('{{'), `${route} has no unfilled placeholders`);
  }
});

test('the page policy lets Cloudflare restore the contact address, and nothing from elsewhere', async () => {
  const policy = (await request('/privacy')).headers['content-security-policy'];
  assert.match(policy, /script-src 'self'/);
  assert.ok(!/https?:|\*|unsafe-eval/.test(policy));
  assert.ok(!(await request('/privacy')).body.includes('<script'), 'the pages ship no script of their own');
});

test('the privacy policy has what Google asks for', async () => {
  const { body } = await request('/privacy');
  for (const needed of ['YouTube API Services', 'youtube.com/t/terms', 'policies.google.com/privacy', 'Limited Use', 'myaccount.google.com/permissions']) {
    assert.ok(body.includes(needed), needed);
  }
});

test('the privacy policy says how to delete data, which Meta asks for', async () => {
  const { body } = await request('/privacy');
  assert.match(body, /Deleting your data/);
});

test('the public hostname reaches nothing but those pages', async () => {
  for (const route of ['/api/state', '/api/posts', '/api/session', '/app.js', '/index.html', '/auth/meta/start', '/fonts/x.woff2', '/../src/main.js']) {
    assert.equal((await request(route)).status, 404, route);
  }
  assert.equal((await request('/', { method: 'POST' })).status, 404);
  assert.equal((await request('/api/uploads', { method: 'POST' })).status, 404);
  assert.equal((await request('/api/auth/login', { method: 'POST' })).status, 404);
});

test('the app address opens the login page and keeps its data behind a login', async () => {
  const local = `localhost:${h.config.port}`;
  const page = await request('/', { host: local });
  assert.equal(page.status, 200);
  assert.ok(page.body.includes('/app.js'), 'it is the app, not the public home page');
  assert.equal((await request('/api/state', { host: local })).status, 401);
  assert.equal((await request('/', { host: 'unknown.example.net' })).status, 403);
});

test('the app address cannot be shown inside another site', async () => {
  const page = await request('/', { host: `localhost:${h.config.port}` });
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
});

test('the in-app guide is told the addresses to show', async () => {
  const state = await (await h.fetch('/api/state')).json();
  assert.equal(state.baseUrl, h.config.baseUrl);
  assert.equal(state.siteHost, HOST);
  assert.equal((await request('/guide.js')).status, 404, 'the public hostname does not serve app files');
});

test('a contact address cannot inject markup', async () => {
  const other = await startHarness({ site: { host: HOST, contactEmail: '"><script>x</script>' } });
  try {
    const res = await new Promise((resolve, reject) => {
      http.get({ port: other.config.port, path: '/privacy', headers: { Host: HOST } }, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve(body));
      }).on('error', reject);
    });
    assert.ok(!res.includes('<script>x'));
  } finally {
    await other.close();
  }
});

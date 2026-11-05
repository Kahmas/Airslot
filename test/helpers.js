import { execFileSync } from 'node:child_process';
import { mkdtempSync, openAsBlob, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashPassword, startSession } from '../src/auth.js';
import { boot } from '../src/boot.js';
import { loadConfig } from '../src/config.js';
import { startMockPlatforms } from './mock-platforms.js';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const TEST_PASSWORD = 'test-password-1';

// Hashing is slow on purpose, and most tests never log in with a password.
const testHash = hashPassword(TEST_PASSWORD);

const sampleCache = new Map();
const sampleDir = mkdtempSync(path.join(tmpdir(), 'cm-samples-'));
process.on('exit', () => rmSync(sampleDir, { recursive: true, force: true }));

// Generates a real encoded file once per shape, so tests exercise ffprobe rather than fake metadata.
export function sampleVideo({ width = 1080, height = 1920, seconds = 4, faststart = true } = {}) {
  const key = `${width}x${height}-${seconds}-${faststart}`;
  if (!sampleCache.has(key)) {
    const file = path.join(sampleDir, `${key}.mp4`);
    execFileSync('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=30:duration=${seconds}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ac', '2',
      ...(faststart ? ['-movflags', '+faststart'] : []),
      file,
    ]);
    sampleCache.set(key, file);
  }
  return sampleCache.get(key);
}

export async function startHarness({ processingPolls = 1, appPassword = null, site = null, seedOwner = true, configure = null } = {}) {
  const clock = { at: Date.UTC(2030, 0, 15, 8, 0, 0) };
  const now = () => clock.at;
  const mock = await startMockPlatforms({ now, processingPolls });
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cm-test-'));
  const config = mock.wire(loadConfig({ PORT: '0', DATA_DIR: dataDir }));
  config.google.clientId = 'test-client';
  config.google.clientSecret = 'test-secret';
  config.meta.appId = 'test-app';
  config.meta.appSecret = 'test-secret';
  config.appPassword = appPassword;
  if (site) config.site = site;
  // Small enough that the sample videos really do travel in several pieces.
  config.upload.chunkBytes = 1024 * 1024;
  configure?.(config);

  const silent = { error() {}, log() {} };
  const app = await boot(config, { now, autoStart: false, log: silent });

  const sessionFor = (userId) => `airslot_session=${startSession(app.store, userId, clock.at)}`;

  let ownerId = null;
  let ownerCookie = null;
  let accounts = {};
  if (seedOwner) {
    ownerId = app.store.createFirstAdmin({ username: 'owner', passwordHash: await testHash });
    ownerCookie = sessionFor(ownerId);
    accounts = {
      instagram: app.store.upsertAccount({ userId: ownerId, platform: 'instagram', remote_id: 'ig-1', name: '@akun_uji', token: 'ig-page-token' }),
      facebook: app.store.upsertAccount({ userId: ownerId, platform: 'facebook', remote_id: 'page-1', name: 'Page Uji', token: 'fb-page-token' }),
      youtube: app.store.upsertAccount({
        userId: ownerId,
        platform: 'youtube',
        remote_id: 'channel-1',
        name: 'Kanal Uji',
        token: 'yt-access-token',
        refresh_token: 'yt-refresh-token',
        token_expires_at: clock.at + 100 * HOUR,
      }),
    };
  }

  const cookieHeader = (cookie) => (cookie ? { Cookie: cookie } : {});

  // Sends the owner's session unless `as` names someone else's cookie, or null for a stranger.
  const authedFetch = (route, { as = ownerCookie, ...options } = {}) => fetch(`${config.baseUrl}${route}`, {
    ...options,
    headers: { ...cookieHeader(as), ...options.headers },
  });

  const api = async (route, { as = ownerCookie, ...options } = {}) => {
    const res = await fetch(`${config.baseUrl}${route}`, {
      ...options,
      headers: { ...cookieHeader(as), ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null, headers: res.headers };
  };

  const sendChunk = async (id, offset, body, as = ownerCookie) => {
    const res = await fetch(`${config.baseUrl}/api/uploads/${id}/chunk`, {
      method: 'PUT',
      headers: { ...cookieHeader(as), 'X-Upload-Offset': String(offset) },
      body,
    });
    return { status: res.status, data: await res.json() };
  };

  // Returns the first failing step's answer, or the final answer with the video and its checks.
  const upload = async (filePath, name = 'klip.mp4', as = ownerCookie) => {
    const blob = await openAsBlob(filePath);
    const started = await api('/api/uploads', { as, method: 'POST', body: { fileName: name, size: blob.size } });
    if (started.status !== 201) return started;
    const { id, chunkBytes } = started.data;
    for (let offset = 0; offset < blob.size; offset += chunkBytes) {
      const sent = await sendChunk(id, offset, blob.slice(offset, offset + chunkBytes), as);
      if (sent.status !== 200) return sent;
    }
    return api(`/api/uploads/${id}/complete`, { as, method: 'POST' });
  };

  const schedule = async ({ platform, at, caption = 'Caption uji', title, video }) => {
    const uploaded = video ?? (await upload(sampleVideo())).data.video;
    const result = await api('/api/posts', {
      method: 'POST',
      body: {
        videoId: uploaded.id,
        caption,
        publishAt: at,
        targets: [{ accountId: accounts[platform], ...(platform === 'youtube' ? { title: title ?? 'Judul uji' } : {}) }],
      },
    });
    if (result.status !== 201) throw new Error(`schedule failed: ${JSON.stringify(result.data)}`);
    return app.store.listPosts(ownerId).find((post) => post.id === result.data.id).targets[0].id;
  };

  // A second person, already logged in.
  const addUser = async (username) => {
    const id = app.store.createUser({ username, passwordHash: await testHash });
    return { id, username, cookie: sessionFor(id) };
  };

  // Runs everything due at the current clock until the queue stops moving.
  const settle = async () => {
    for (let round = 0; round < 20; round += 1) {
      await app.scheduler.tick();
      if (app.store.dueTargets(clock.at, 1).length === 0) return;
    }
    throw new Error('queue did not settle');
  };

  // Walks the clock forward in steps so that polling happens as it would in real time.
  const advance = async (ms, stepMs = MINUTE) => {
    const end = clock.at + ms;
    while (clock.at < end) {
      clock.at = Math.min(end, clock.at + stepMs);
      await settle();
    }
  };

  return {
    clock,
    config,
    mock,
    store: app.store,
    scheduler: app.scheduler,
    ownerId,
    ownerCookie,
    accounts,
    api,
    fetch: authedFetch,
    upload,
    sendChunk,
    schedule,
    addUser,
    sessionFor,
    settle,
    advance,
    target: (id) => app.store.getTarget(id),
    async close() {
      await app.close();
      await mock.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

import { rmSync } from 'node:fs';
import path from 'node:path';
import { hashPassword } from '../src/auth.js';
import { boot } from '../src/boot.js';
import { loadConfig } from '../src/config.js';
import { startMockPlatforms } from '../test/mock-platforms.js';

// Runs the real app against a local stand-in for the platforms, so nothing reaches a real account.
const dataDir = path.resolve('data-demo');
rmSync(dataDir, { recursive: true, force: true });

const mock = await startMockPlatforms();
const config = mock.wire(loadConfig({ PORT: '3100', DATA_DIR: dataDir }));
config.demo = true;

const app = await boot(config);
const userId = app.store.createFirstAdmin({ username: 'demo', passwordHash: await hashPassword('demo-password') });
const year = new Date().getFullYear() + 1;
app.store.upsertAccount({ userId, platform: 'instagram', remote_id: 'ig-demo', name: '@demo_account', token: 'ig-page-token' });
app.store.upsertAccount({ userId, platform: 'facebook', remote_id: 'page-demo', name: 'Demo Page', token: 'fb-page-token' });
app.store.upsertAccount({
  userId,
  platform: 'youtube',
  remote_id: 'channel-demo',
  name: 'Demo Channel',
  token: 'yt-access-token',
  refresh_token: 'demo-refresh',
  token_expires_at: Date.UTC(year, 0, 1),
});

console.log(`Demo mode is running at ${config.baseUrl}. Log in with demo / demo-password. Nothing is actually posted.`);

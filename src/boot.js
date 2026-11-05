import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createPlatforms } from './platforms/index.js';
import { createScheduler } from './scheduler.js';
import { createApp } from './server.js';
import { createStore } from './store.js';
import { createVault, loadKey } from './vault.js';

export async function boot(config, { now = Date.now, autoStart = true, log = console } = {}) {
  mkdirSync(config.dataDir, { recursive: true });
  const vault = createVault(loadKey(path.join(config.dataDir, 'secret.key')));
  const store = createStore(path.join(config.dataDir, 'airslot.db'), vault, now);
  const platforms = createPlatforms(config);
  const scheduler = createScheduler({ store, platforms, config, now, log });
  const app = createApp({ config, store, scheduler, platforms, now });

  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(config.port, config.host, (err) => (err ? reject(err) : resolve(listening)));
  });
  if (config.port === 0) {
    config.port = server.address().port;
    config.baseUrl = `http://localhost:${config.port}`;
  }
  if (autoStart) scheduler.start();

  return {
    store,
    scheduler,
    server,
    async close() {
      await scheduler.stop();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      store.close();
    },
  };
}

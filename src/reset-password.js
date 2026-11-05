// The way back in when the only admin has lost their password, since there is no email to reset it by.
//   node src/reset-password.js <username>
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { hashPassword } from './auth.js';
import { loadConfig } from './config.js';
import { createStore } from './store.js';
import { createVault, loadKey } from './vault.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const username = process.argv[2];
if (!username) {
  console.error('Usage: node src/reset-password.js <username>');
  process.exit(2);
}

const { dataDir } = loadConfig();
const store = createStore(path.join(dataDir, 'airslot.db'), createVault(loadKey(path.join(dataDir, 'secret.key'))));
const user = store.getUserByUsername(username);
if (!user) {
  console.error(`No user is named ${username}.`);
  store.close();
  process.exit(1);
}

const password = randomBytes(12).toString('base64url');
store.setPasswordHash(user.id, await hashPassword(password));
store.deleteUserSessions(user.id);
store.close();
console.log(`New password for ${user.username}: ${password}`);

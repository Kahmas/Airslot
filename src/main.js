import { existsSync } from 'node:fs';
import { boot } from './boot.js';
import { loadConfig, requiresPassword } from './config.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const config = loadConfig();
if (requiresPassword(config) && !config.appPassword) {
  console.error('APP_PASSWORD is required when the app is reachable from outside this machine, including through a tunnel. It is the setup code that creates the first admin account.');
  process.exit(1);
}
if (config.site.host && !config.site.contactEmail) {
  console.error('SITE_CONTACT_EMAIL is required when SITE_HOST is set, because the privacy policy has to name a contact.');
  process.exit(1);
}
if (config.site.host === new URL(config.baseUrl).hostname) {
  console.error('SITE_HOST must differ from the BASE_URL hostname, or the app would be unreachable.');
  process.exit(1);
}

await boot(config);
console.log(`Airslot is running at ${config.baseUrl}`);

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// Platform tokens are sealed at rest; the key lives beside the database, outside version control.
export function loadKey(keyPath) {
  if (existsSync(keyPath)) return readFileSync(keyPath);
  const key = randomBytes(32);
  writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

export function createVault(key) {
  return {
    seal(text) {
      if (text == null) return null;
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return [iv, cipher.getAuthTag(), body].map((part) => part.toString('base64')).join('.');
    },
    open(sealed) {
      if (sealed == null) return null;
      const [iv, tag, body] = sealed.split('.').map((part) => Buffer.from(part, 'base64'));
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    },
  };
}

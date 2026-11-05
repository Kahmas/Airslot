import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = `package-test-${process.pid}.tar.gz`;

after(() => rmSync(path.join(ROOT, OUTPUT), { force: true }));

test('the server package holds what the app needs, and a script bash can run', () => {
  execFileSync(process.execPath, ['scripts/package.js', OUTPUT], { cwd: ROOT, stdio: 'pipe' });

  const names = execFileSync('tar', ['-tzf', OUTPUT], { cwd: ROOT, encoding: 'utf8' }).split(/\r?\n/);
  for (const needed of ['package.json', 'package-lock.json', 'src/main.js', 'src/uploads.js', 'public/index.html', 'public/app.js', 'site/privacy.html', 'deploy/install.sh']) {
    assert.ok(names.includes(needed), `${needed} should be packaged`);
  }
  for (const excluded of ['.env', 'data', 'data-demo', 'node_modules', 'test']) {
    assert.ok(!names.some((name) => name === excluded || name.startsWith(`${excluded}/`)), `${excluded} should stay out`);
  }

  const script = execFileSync('tar', ['-xOzf', OUTPUT, 'deploy/install.sh'], { cwd: ROOT, encoding: 'utf8' });
  assert.ok(script.startsWith('#!/usr/bin/env bash\n'));
  assert.ok(!script.includes('\r'), 'CRLF line endings would stop the script on Ubuntu');
});

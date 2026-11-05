import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const output = process.argv[2] ?? 'airslot.tar.gz';
const script = 'deploy/install.sh';

// Windows tools can save CRLF line endings, and bash on the server can't run a script that has them.
const text = readFileSync(script, 'utf8');
if (text.includes('\r')) writeFileSync(script, text.replaceAll('\r\n', '\n'));

execFileSync('tar', ['-czf', output, 'package.json', 'package-lock.json', 'public', 'site', 'src', 'deploy'], { stdio: 'inherit' });
console.log(`Created ${output}`);

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';

if (existsSync('.env')) {
  console.log('Existing .env preserved. Run npm run dev.');
} else {
  const host = process.env.HOST || '127.0.0.1';
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, host, resolve);
  });
  const port = process.env.PORT || socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const password = randomBytes(24).toString('base64url');
  mkdirSync('runtime', { recursive: true });
  const ai = readFileSync('.env.example', 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('AI_'))
    .join('\n');
  writeFileSync(
    '.env',
    `HOST=${host}\nPORT=${port}\nAPP_ORIGIN=http://${host}:${port}\nDATABASE_PATH=runtime/qarqyn.sqlite\nADMIN_USERNAME=owner\nADMIN_PASSWORD=${password}\nSESSION_HOURS=8\n${ai}\n`,
    { mode: 0o600 }
  );
  console.log(
    'Created .env with a random owner password and a free local port. Credentials remain in .env; do not commit this file. Run npm run dev.'
  );
}

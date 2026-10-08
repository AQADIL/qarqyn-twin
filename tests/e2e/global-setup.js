import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';

async function startServer() {
  if (!existsSync(resolve('dist/index.html')))
    throw new Error('Run npm run build before browser tests.');
  const directory = await mkdtemp(join(tmpdir(), 'qarqyn-e2e-'));
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const username = `test-${randomBytes(6).toString('hex')}`;
  const password = randomBytes(24).toString('base64url');
  const server = spawn(process.execPath, ['server/index.js', '--production'], {
    cwd: resolve('.'),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      APP_ORIGIN: origin,
      DATABASE_PATH: join(directory, 'test.sqlite'),
      ADMIN_USERNAME: username,
      ADMIN_PASSWORD: password,
      AI_API_KEY: '',
      AI_BASE_URL: '',
      AI_MODEL: '',
      TRUST_PROXY: '',
      BACKUP_DIR: join(directory, 'backups'),
      AUDIT_RETENTION_DAYS: '0',
      CHAT_RETENTION_DAYS: '0',
      BACKUP_KEEP_COUNT: '0'
    }
  });
  let output = '',
    spawnError;
  const collect = (chunk) => {
    output = (output + chunk.toString()).slice(-6000);
  };
  server.stdout.on('data', collect);
  server.stderr.on('data', collect);
  server.on('error', (error) => {
    spawnError = error;
  });
  async function cleanup() {
    if (server.exitCode === null && server.signalCode === null && !spawnError) {
      server.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => server.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 4000))
      ]);
      if (server.exitCode === null && server.signalCode === null) {
        server.kill('SIGKILL');
        await new Promise((resolve) => server.once('exit', resolve));
      }
    }
    const child = relative(resolve(tmpdir()), resolve(directory));
    if (!child || child.startsWith('..') || isAbsolute(child) || !child.startsWith('qarqyn-e2e-'))
      throw new Error('Unexpected test directory; cleanup refused.');
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnError || server.exitCode !== null)
        throw new Error(`Test server failed: ${spawnError?.message || output}`);
      try {
        ready = (await fetch(`${origin}/api/health/ready`, { signal: AbortSignal.timeout(1000) }))
          .ok;
      } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`Test server not ready: ${output}`);
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { origin, username, password, cleanup };
}

export default async function globalSetup(config) {
  const servers = {};
  async function cleanup() {
    for (const server of Object.values(servers)) await server.cleanup();
  }
  try {
    for (const project of config.projects) servers[project.name] = await startServer();
    process.env.QARQYN_E2E_SERVERS = JSON.stringify(
      Object.fromEntries(
        Object.entries(servers).map(([project, { origin, username, password }]) => [
          project,
          { origin, username, password }
        ])
      )
    );
  } catch (error) {
    await cleanup();
    throw error;
  }
  return cleanup;
}

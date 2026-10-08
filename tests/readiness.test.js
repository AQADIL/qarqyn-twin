import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDatabase, checkPassword, hashPassword } from '../server/db.js';

test('clean setup creates private generated credentials, usable environment and preserves existing configuration', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'qarqyn-setup-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  copyFileSync(resolve('.env.example'), join(folder, '.env.example'));
  const run = () => spawnSync(process.execPath, [resolve('scripts/setup.js')], {
    cwd: folder,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '' },
    encoding: 'utf8'
  });
  const first = run();
  assert.equal(first.status, 0);
  const content = readFileSync(join(folder, '.env'), 'utf8');
  const config = Object.fromEntries(content.trim().split(/\r?\n/).map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  assert.ok(config.ADMIN_PASSWORD.length >= 24);
  assert.equal(`${first.stdout}${first.stderr}`.includes(config.ADMIN_PASSWORD), false);
  assert.ok(Number(config.PORT) > 0 && Number(config.PORT) < 65536);
  assert.equal(new URL(config.APP_ORIGIN).port, config.PORT);
  assert.equal(config.AI_API_KEY, '');
  assert.equal(run().status, 0);
  assert.equal(readFileSync(join(folder, '.env'), 'utf8'), content);
});

test('configured owner rotation revokes old sessions and preserves data and unrelated accounts', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'qarqyn-rotation-'));
  const path = join(folder, 'rotation.sqlite');
  const firstPassword = randomBytes(24).toString('base64url');
  const nextPassword = randomBytes(24).toString('base64url');
  let config = { adminUsername: 'original-owner', adminPassword: firstPassword };
  let db;
  t.after(() => {
    db?.close();
    rmSync(folder, { recursive: true, force: true });
  });
  db = openDatabase(path, config);
  const originalHash = db
    .prepare("SELECT password_hash FROM users WHERE id='owner'")
    .get().password_hash;
  db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(
    'editor',
    'another-editor',
    hashPassword(firstPassword),
    'editor'
  );
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(
    'owner-session',
    'owner',
    'owner-csrf',
    Date.now() + 10000
  );
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(
    'editor-session',
    'editor',
    'editor-csrf',
    Date.now() + 10000
  );
  db.close();
  db = openDatabase(path, config);
  assert.equal(
    db.prepare("SELECT password_hash FROM users WHERE id='owner'").get().password_hash,
    originalHash
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 2);
  db.close();
  config = { adminUsername: 'renamed-owner', adminPassword: nextPassword };
  db = openDatabase(path, config);
  const owner = db.prepare("SELECT * FROM users WHERE id='owner'").get();
  assert.equal(owner.username, 'renamed-owner');
  assert.equal(checkPassword(firstPassword, owner.password_hash), false);
  assert.equal(checkPassword(nextPassword, owner.password_hash), true);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id='owner'").get().count,
    0
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id='editor'").get().count,
    1
  );
  assert.ok(db.prepare("SELECT id FROM datasets WHERE id='allur'").get());
  const audit = db.prepare("SELECT * FROM audit WHERE action='owner.credentials_changed'").all();
  assert.equal(audit.length, 1);
  assert.equal(JSON.stringify(audit).includes(nextPassword), false);
});

test('configured owner cannot take over an existing editor username', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'qarqyn-identity-'));
  const path = join(folder, 'identity.sqlite');
  const config = { adminUsername: 'owner', adminPassword: randomBytes(24).toString('base64url') };
  let db;
  t.after(() => {
    db?.close();
    rmSync(folder, { recursive: true, force: true });
  });
  db = openDatabase(path, config);
  db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(
    'editor',
    'reserved-name',
    hashPassword(config.adminPassword),
    'editor'
  );
  db.close();
  db = null;
  assert.throws(
    () => openDatabase(path, { ...config, adminUsername: 'reserved-name' }),
    /already assigned/
  );
  db = openDatabase(path, config);
  assert.equal(db.prepare("SELECT username FROM users WHERE id='owner'").get().username, 'owner');
  assert.equal(db.prepare("SELECT role FROM users WHERE id='editor'").get().role, 'editor');
});

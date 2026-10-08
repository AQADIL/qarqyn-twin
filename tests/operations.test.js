import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { openDatabase } from '../server/db.js';
import { createApp, errorHandler } from '../server/app.js';
import { snapshotDatabase, verifyDatabase } from '../server/operations.js';

async function harness(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'qarqyn-operations-'));
  const config = {
    adminUsername: 'test-owner',
    adminPassword: randomBytes(24).toString('hex'),
    sessionMs: 3600000,
    origin: 'https://qarqyn.invalid',
    testing: true,
    production: true,
    secure: false,
    ...overrides
  };
  const db = openDatabase(join(directory, 'data.sqlite'), config);
  const app = createApp(db, config);
  app.get('/{*path}', (req, res) => res.type('html').send('<main>App</main>'));
  app.use(errorHandler(config));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  if (!config.testing) config.origin = base;
  async function request(path, method = 'GET', body, session) {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        Host: new URL(config.origin).host,
        Origin: config.origin,
        'Content-Type': 'application/json',
        ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return {
      status: response.status,
      body: await response.json(),
      cookie: response.headers.get('set-cookie'),
      headers: response.headers
    };
  }
  async function login(username = config.adminUsername, password = config.adminPassword) {
    const response = await request('/auth/login', 'POST', { username, password });
    assert.equal(response.status, 200);
    return { cookie: response.cookie.split(';')[0], csrf: response.body.csrf };
  }
  const owner = await login();
  const source = (await request('/datasets/allur', 'GET', undefined, owner)).body.data;
  return { config, directory, db, app, base, request, login, owner, source };
}

test('failed audit rolls back dataset/entity CRUD and version archives', async (t) => {
  const h = await harness(t);
  const copy = await h.request('/datasets', 'POST', { ...h.source, name: 'Atomic copy' }, h.owner);
  assert.equal(copy.status, 201);
  const id = copy.body.id;
  const incident = {
    datasetId: id,
    stageId: null,
    title: 'Общий инцидент',
    description: 'No stage',
    priority: 'normal',
    status: 'open'
  };
  const row = (await h.request('/incidents', 'POST', incident, h.owner)).body;
  h.db.exec(
    "CREATE TRIGGER fail_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'injected audit failure'); END;"
  );
  for (const [path, method, body] of [
    ['/datasets', 'POST', { ...h.source, name: 'Must roll back' }],
    [`/datasets/${id}`, 'PUT', { version: 1, data: { ...h.source, name: 'Must roll back' } }],
    [`/datasets/${id}`, 'DELETE', { version: 1 }],
    ['/incidents', 'POST', incident],
    [`/incidents/${row.id}`, 'PUT', { version: 1, data: { ...incident, status: 'resolved' } }],
    [`/incidents/${row.id}`, 'DELETE', { version: 1 }]
  ])
    assert.equal((await h.request(path, method, body, h.owner)).status, 500);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM datasets').get().n, 2);
  assert.equal(
    h.db.prepare('SELECT COUNT(*) AS n FROM dataset_versions WHERE dataset_id=?').get(id).n,
    1
  );
  assert.equal(h.db.prepare('SELECT version FROM datasets WHERE id=?').get(id).version, 1);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM incidents').get().n, 1);
  assert.equal(h.db.prepare('SELECT version FROM incidents WHERE id=?').get(row.id).version, 1);
  h.db.exec('DROP TRIGGER fail_audit');
  assert.equal(
    (await h.request(`/datasets/${id}`, 'PUT', { version: 1, data: h.source }, h.owner)).status,
    200
  );
});

test('history snapshots survive updates and restore creates a new version with concurrency protection', async (t) => {
  const h = await harness(t);
  const id = (await h.request('/datasets', 'POST', { ...h.source, name: 'Original' }, h.owner)).body
    .id;
  const scenario = {
    name: 'Baseline',
    note: '',
    expectedDatasetVersion: 1,
    input: { datasetId: id, hours: 8, observationHours: 8, interventions: [] }
  };
  const missing = { ...scenario };
  delete missing.expectedDatasetVersion;
  assert.equal((await h.request('/scenarios', 'POST', missing, h.owner)).status, 422);
  const saved = (await h.request('/scenarios', 'POST', scenario, h.owner)).body;
  assert.equal(
    (
      await h.request(
        `/datasets/${id}`,
        'PUT',
        { version: 1, data: { ...h.source, name: 'Second' } },
        h.owner
      )
    ).status,
    200
  );
  const detail = await h.request(`/scenarios/${saved.id}`, 'GET', undefined, h.owner);
  assert.equal(detail.body.datasetSnapshot.data.name, 'Original');
  assert.equal(detail.body.datasetSnapshot.version, 1);
  assert.equal(
    (await h.request(`/datasets/${id}/restore`, 'POST', { version: 1, restoreVersion: 1 }, h.owner))
      .status,
    409
  );
  const restored = await h.request(
    `/datasets/${id}/restore`,
    'POST',
    { version: 2, restoreVersion: 1 },
    h.owner
  );
  assert.equal(restored.status, 200);
  assert.equal(restored.body.version, 3);
  assert.equal(
    (await h.request(`/datasets/${id}`, 'GET', undefined, h.owner)).body.data.name,
    'Original'
  );
  const versions = (
    await h.request(`/datasets/${id}/versions?page=1&pageSize=2`, 'GET', undefined, h.owner)
  ).body;
  assert.equal(versions.total, 3);
  assert.deepEqual(
    versions.items.map((row) => row.version),
    [3, 2]
  );
  assert.equal(
    (await h.request(`/datasets/${id}/versions/2`, 'GET', undefined, h.owner)).body.data.name,
    'Second'
  );
  const invalid = structuredClone(h.source);
  invalid.production[0].actual = -1;
  const validation = await h.request('/datasets/validate', 'POST', { data: invalid }, h.owner);
  assert.equal(validation.status, 422);
  assert.equal(validation.body.issues[0].path, 'production.0.actual');
  assert.equal(
    (await h.request('/datasets/validate', 'POST', { data: h.source }, h.owner)).body.valid,
    true
  );
});

test('paginated lists search before counting, expose old details, and keep ownership isolation', async (t) => {
  const h = await harness(t),
    now = new Date().toISOString();
  const insert = h.db.prepare(
    'INSERT INTO incidents(id,dataset_id,owner_id,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)'
  );
  for (let i = 0; i < 205; i++)
    insert.run(
      `incident-${i}`,
      'allur',
      'owner',
      JSON.stringify({
        datasetId: 'allur',
        stageId: null,
        title: `Сварка ${i}`,
        description: 'Измерение',
        status: i % 2 ? 'resolved' : 'open',
        priority: 'normal'
      }),
      now,
      now
    );
  const page = (
    await h.request('/incidents?datasetId=allur&page=3&pageSize=100', 'GET', undefined, h.owner)
  ).body;
  assert.equal(page.total, 205);
  assert.equal(page.items.length, 5);
  const filtered = (
    await h.request(
      '/incidents?datasetId=allur&page=1&pageSize=20&status=resolved&q=' +
        encodeURIComponent('СВАРКА'),
      'GET',
      undefined,
      h.owner
    )
  ).body;
  assert.equal(filtered.total, 102);
  assert.equal(filtered.items.length, 20);
  assert.equal((await h.request('/incidents/incident-0', 'GET', undefined, h.owner)).status, 200);
  const guest = await h.request('/auth/demo', 'POST', {});
  const session = { cookie: guest.cookie.split(';')[0], csrf: guest.body.csrf };
  assert.equal((await h.request('/incidents/incident-0', 'GET', undefined, session)).status, 404);
  assert.equal(
    (await h.request('/incidents?datasetId=allur&page=1', 'GET', undefined, session)).body.total,
    0
  );
  assert.equal(
    (await h.request('/incidents?datasetId=allur&page=0', 'GET', undefined, h.owner)).status,
    422
  );
});

test('admin accounts revoke sessions, protect the owner, and cannot expose password hashes', async (t) => {
  const h = await harness(t);
  const password = randomBytes(24).toString('hex');
  const created = await h.request(
    '/users',
    'POST',
    { username: 'Engineer', password, role: 'editor' },
    h.owner
  );
  assert.equal(created.status, 201);
  assert.equal(created.body.password_hash, undefined);
  const engineer = await h.login('Engineer', password);
  assert.equal((await h.request('/users', 'GET', undefined, engineer)).status, 403);
  assert.equal(
    (await h.request(`/users/${created.body.id}`, 'PATCH', { disabled: true }, h.owner)).status,
    200
  );
  assert.equal((await h.request('/session', 'GET', undefined, engineer)).status, 401);
  assert.equal(
    (await h.request('/auth/login', 'POST', { username: 'Engineer', password })).status,
    401
  );
  assert.equal((await h.request('/users/owner', 'PATCH', { disabled: true }, h.owner)).status, 409);
  assert.equal(
    (
      await h.request(
        `/users/${created.body.id}`,
        'PATCH',
        { disabled: false, role: 'viewer' },
        h.owner
      )
    ).status,
    200
  );
  const viewer = await h.login('Engineer', password);
  assert.equal((await h.request('/datasets', 'POST', h.source, viewer)).status, 403);
  assert.equal(
    (await h.request('/users', 'GET', undefined, h.owner)).body.some((user) =>
      Object.keys(user).includes('password_hash')
    ),
    false
  );
});

test('backup integrity, offline restore and disabled retention preserve data and budget ledgers', async (t) => {
  const h = await harness(t);
  assert.equal((await h.request('/health/live')).body.status, 'alive');
  assert.equal((await h.request('/health/ready')).body.status, 'ready');
  const backup = await h.request('/operations/backup', 'POST', {}, h.owner);
  assert.equal(backup.status, 200, JSON.stringify(backup.body));
  const path = join(h.directory, 'backups', backup.body.name);
  assert.equal(verifyDatabase(path).valid, true);
  const restored = join(h.directory, 'restored.sqlite');
  const child = spawnSync(
    process.execPath,
    ['scripts/database.js', 'restore', '--source', path, '--destination', restored],
    { cwd: resolve('.'), encoding: 'utf8' }
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(existsSync(restored), true);
  const check = new DatabaseSync(restored, { readOnly: true });
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM datasets').get().n, 1);
  check.close();
  assert.throws(() => snapshotDatabase(h.db, restored), /already exists/);
  h.db
    .prepare('INSERT INTO audit(actor,action,entity_id,detail,created_at) VALUES (?,?,?,?,?)')
    .run('test', 'old', 'x', '', '2000-01-01T00:00:00.000Z');
  const retained = await h.request('/operations/retention', 'POST', { confirm: true }, h.owner);
  assert.equal(retained.body.audit, 0);
  assert.equal(retained.body.backups, 0);
  assert.equal(existsSync(path), true);
  const operations = (await h.request('/operations', 'GET', undefined, h.owner)).body;
  assert.equal(operations.database.schemaVersion, 2);
  assert.equal(operations.backups.count, 1);
});

test('production malformed paths do not leak stack traces and secure cookies are set', async (t) => {
  const h = await harness(t, { secure: true });
  assert.equal(h.app.get('env'), 'production');
  const response = await fetch(h.base + '/bad%');
  const text = await response.text();
  assert.equal(response.status, 400);
  assert.doesNotMatch(text, /node_modules|URIError|Error:|at Layer|C:\\/);
  const login = await h.request('/auth/login', 'POST', {
    username: h.config.adminUsername,
    password: h.config.adminPassword
  });
  assert.match(login.cookie, /Secure/);
  assert.match(login.cookie, /HttpOnly/);
  assert.match(login.cookie, /SameSite=Strict/);
  assert.ok(response.headers.get('x-request-id'));
});

test('owner credentials validate and normalize identically to login', () => {
  assert.throws(
    () => openDatabase(':memory:', { adminUsername: 'owner', adminPassword: 'x'.repeat(257) }),
    (error) => error.status === 422
  );
  const config = { adminUsername: ' owner ', adminPassword: 'long-password-for-test' };
  const db = openDatabase(':memory:', config);
  try {
    assert.equal(config.adminUsername, 'owner');
    assert.equal(db.prepare("SELECT username FROM users WHERE id='owner'").get().username, 'owner');
  } finally {
    db.close();
  }
});

const aiConfig = {
  aiUrl: 'https://provider.invalid/v1',
  aiKey: 'test-only',
  aiModel: 'test-model',
  aiReasoning: 'medium',
  aiMaxOutput: 1000,
  aiBudget: 2,
  aiInputPrice: 2,
  aiOutputPrice: 10,
  aiTimeout: 1000
};
const answer = {
  summary: 'Проверенный ответ',
  observations: [{ title: 'Окраска', explanation: 'Источник существует', sourceIds: ['Q2'] }],
  nextSteps: ['Проверить журнал'],
  limitations: ['Ответ не доказывает причину'],
  proposal: null
};
function completedAnswer() {
  return {
    ok: true,
    json: async () => ({
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] }
      ],
      usage: { input_tokens: 100, output_tokens: 100 }
    })
  };
}
async function stream(h, conversationId, expectedDatasetVersion = 1) {
  return fetch(h.base + '/api/assistant/stream', {
    method: 'POST',
    headers: {
      Origin: h.config.origin,
      'Content-Type': 'application/json',
      Cookie: h.owner.cookie,
      'X-CSRF-Token': h.owner.csrf
    },
    body: JSON.stringify({
      conversationId,
      expectedDatasetVersion,
      question: 'Что проверить на окраске?'
    })
  });
}

test('persistent chat emits validated SSE answer and enforces ownership, rename versions and deletion', async (t) => {
  const h = await harness(t, { ...aiConfig, aiFetcher: async () => completedAnswer() });
  const thread = (await h.request('/conversations', 'POST', { datasetId: 'allur' }, h.owner)).body;
  const response = await stream(h, thread.id);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /event-stream/);
  const events = await response.text();
  assert.match(events, /event: status/);
  assert.match(events, /event: answer/);
  assert.doesNotMatch(events, /event: error/);
  const stored = (await h.request(`/conversations/${thread.id}`, 'GET', undefined, h.owner)).body;
  assert.equal(stored.messages.length, 2);
  assert.equal(stored.messages[0].role, 'user');
  assert.equal(stored.messages[1].role, 'assistant');
  assert.equal(stored.messages[0].requestId, stored.messages[1].requestId);
  assert.equal(stored.messages[1].answer.summary, answer.summary);
  assert.equal(stored.messages[1].state, 'completed');
  assert.equal(
    (
      await h.request(
        `/conversations/${thread.id}`,
        'PATCH',
        { version: 1, title: 'Stale' },
        h.owner
      )
    ).status,
    409
  );
  const renamed = await h.request(
    `/conversations/${thread.id}`,
    'PATCH',
    { version: stored.version, title: 'Диагностика окраски' },
    h.owner
  );
  assert.equal(renamed.status, 200);
  assert.equal(
    (
      await h.request(
        '/conversations?datasetId=allur&page=1&pageSize=20',
        'GET',
        undefined,
        h.owner
      )
    ).body.total,
    1
  );
  const guest = await h.request('/auth/demo', 'POST', {});
  const session = { cookie: guest.cookie.split(';')[0], csrf: guest.body.csrf };
  assert.equal(
    (await h.request(`/conversations/${thread.id}`, 'GET', undefined, session)).status,
    404
  );
  assert.equal(
    (
      await h.request(
        `/conversations/${thread.id}`,
        'DELETE',
        { version: renamed.body.version },
        h.owner
      )
    ).status,
    200
  );
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n, 0);
});

test('chat cancellation aborts the provider and reservation reconciliation requires explicit admin evidence', async (t) => {
  let providerAborted = false;
  const h = await harness(t, {
    ...aiConfig,
    aiFetcher: async (url, { signal }) =>
      new Promise((resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            providerAborted = true;
            reject(signal.reason);
          },
          { once: true }
        )
      )
  });
  const thread = (await h.request('/conversations', 'POST', { datasetId: 'allur' }, h.owner)).body;
  const response = await stream(h, thread.id);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /processing/);
  const reserved = (await h.request('/ai/reservations', 'GET', undefined, h.owner)).body[0];
  assert.equal(reserved.active, true);
  assert.equal(
    (
      await h.request(
        `/ai/reservations/${reserved.id}/reconcile`,
        'POST',
        { outcome: 'not_charged', note: 'Provider confirmed no charge' },
        h.owner
      )
    ).status,
    409
  );
  assert.equal(
    (await h.request(`/conversations/${thread.id}/cancel`, 'POST', {}, h.owner)).body.cancelled,
    true
  );
  while (!(await reader.read()).done) {}
  assert.equal(providerAborted, true);
  const stored = (await h.request(`/conversations/${thread.id}`, 'GET', undefined, h.owner)).body;
  assert.equal(stored.messages[1].state, 'cancelled');
  assert.equal(h.db.prepare('SELECT state FROM ai_usage').get().state, 'uncertain');
  const reconciled = await h.request(
    `/ai/reservations/${reserved.id}/reconcile`,
    'POST',
    { outcome: 'not_charged', note: 'Provider confirmed no charge' },
    h.owner
  );
  assert.equal(reconciled.status, 200);
  assert.equal(reconciled.body.budget.accountedUsd, 0);
  assert.equal(
    (
      await h.request(
        `/ai/reservations/${reserved.id}/reconcile`,
        'POST',
        { outcome: 'not_charged', note: 'Duplicate' },
        h.owner
      )
    ).status,
    409
  );
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM ai_reconciliations').get().n, 1);
});

test('invalid AI output persists failure without emitting an answer event', async (t) => {
  const h = await harness(t, {
    ...aiConfig,
    aiFetcher: async () => ({
      ok: true,
      json: async () => ({
        status: 'completed',
        output: [],
        usage: { input_tokens: 100, output_tokens: 10 }
      })
    })
  });
  const thread = (await h.request('/conversations', 'POST', { datasetId: 'allur' }, h.owner)).body;
  const response = await stream(h, thread.id);
  const events = await response.text();
  assert.match(events, /event: error/);
  assert.doesNotMatch(events, /event: answer/);
  const stored = (await h.request(`/conversations/${thread.id}`, 'GET', undefined, h.owner)).body;
  assert.equal(stored.messages[1].state, 'failed');
  assert.equal((await stream(h, thread.id, 2)).status, 409);
});

test('explicit proxy trust separates client quotas while untrusted forwarding cannot bypass limits', async (t) => {
  for (const trustProxy of [[], ['loopback']]) {
    const h = await harness(t, {
      testing: false,
      origin: 'http://localhost',
      trustProxy,
      logger: () => {}
    });
    const statuses = [];
    for (let index = 0; index < 22; index++) {
      const response = await fetch(h.base + '/api/auth/demo', {
        method: 'POST',
        headers: {
          Host: 'localhost',
          Origin: h.config.origin,
          'Content-Type': 'application/json',
          'X-Forwarded-For': `192.0.2.${index + 1}`
        },
        body: '{}'
      });
      statuses.push(response.status);
      await response.text();
    }
    if (trustProxy.length) assert.ok(statuses.every((status) => status === 200));
    else assert.ok(statuses.includes(429));
  }
});

test('configured retention removes only expired records and retains billing evidence', async (t) => {
  const h = await harness(t, { auditRetentionDays: 1, chatRetentionDays: 1, backupKeepCount: 1 });
  const old = '2000-01-01T00:00:00.000Z',
    now = new Date().toISOString();
  h.db
    .prepare('INSERT INTO audit(actor,action,entity_id,detail,created_at) VALUES (?,?,?,?,?)')
    .run('test', 'old', 'x', '', old);
  h.db
    .prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?,?)')
    .run('old-chat', 'allur', 'owner', 'Old', 1, old, old);
  h.db
    .prepare(
      'INSERT INTO ai_usage(id,user_id,model,state,cost_usd,created_at) VALUES (?,?,?,?,?,?)'
    )
    .run('old-cost', 'owner', 'test', 'completed', 1, old);
  h.db
    .prepare('INSERT INTO sessions VALUES (?,?,?,?)')
    .run('expired', 'owner', 'csrf', Date.now() - 1000);
  await h.request('/operations/backup', 'POST', {}, h.owner);
  await h.request('/operations/backup', 'POST', {}, h.owner);
  const result = await h.request('/operations/retention', 'POST', { confirm: true }, h.owner);
  assert.equal(result.body.audit, 1);
  assert.equal(result.body.conversations, 1);
  assert.equal(result.body.backups, 1);
  assert.equal(result.body.sessions, 1);
  assert.equal(
    JSON.parse(
      h.db
        .prepare(
          "SELECT detail FROM audit WHERE action='database.retention.complete' ORDER BY id DESC LIMIT 1"
        )
        .get().detail
    ).backups,
    1
  );
  assert.equal(
    h.db.prepare('SELECT cost_usd FROM ai_usage WHERE id=?').get('old-cost').cost_usd,
    1
  );
  assert.equal(
    h.db.prepare('SELECT COUNT(*) AS n FROM audit WHERE created_at>=?').get(now).n > 0,
    true
  );
});

test('readiness detects a read-only database while liveness remains available', async (t) => {
  const h = await harness(t);
  const before = h.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  assert.equal((await h.request('/health/ready')).status, 200);
  assert.deepEqual(h.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), before);
  h.db.exec('PRAGMA query_only=ON');
  assert.equal((await h.request('/health/live')).status, 200);
  assert.equal((await h.request('/health/ready')).status, 503);
  h.db.exec('PRAGMA query_only=OFF');
  assert.equal((await h.request('/health/ready')).status, 200);
});

test('database restart terminates orphan chat messages and preserves uncertain provider cost', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'qarqyn-chat-restart-'));
  const path = join(directory, 'test.sqlite');
  const config = { adminUsername: 'owner', adminPassword: randomBytes(24).toString('hex') };
  let db = openDatabase(path, config);
  const now = new Date().toISOString();
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?,?)').run(
    'thread',
    'allur',
    'owner',
    'Conversation',
    1,
    now,
    now
  );
  db.prepare('INSERT INTO chat_messages VALUES (?,?,?,?,?,?,?,?)').run(
    'message',
    'thread',
    'request',
    'assistant',
    'pending',
    '{}',
    now,
    now
  );
  db.prepare(
    'INSERT INTO ai_usage(id,user_id,model,state,cost_usd,created_at) VALUES (?,?,?,?,?,?)'
  ).run('request', 'owner', 'test', 'reserved', 0.5, now);
  db.close();
  db = openDatabase(path, config);
  const message = db.prepare('SELECT state,payload FROM chat_messages').get();
  assert.equal(message.state, 'failed');
  assert.match(JSON.parse(message.payload).error, /перезапущен/);
  assert.equal(db.prepare('SELECT cost_usd FROM ai_usage').get().cost_usd, 0.5);
});

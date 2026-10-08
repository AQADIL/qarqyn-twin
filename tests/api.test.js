import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, hashPassword } from '../server/db.js';
import { createApp } from '../server/app.js';
import { datasetSchema } from '../server/schema.js';

test('authenticated API enforces ownership, CSRF, optimistic concurrency and persistence', async (t) => {
  const password = randomBytes(24).toString('base64url');
  const config = {
    adminUsername: 'test-owner',
    adminPassword: password,
    sessionMs: 3600000,
    origin: 'http://localhost',
    testing: true,
    production: true,
    secure: false
  };
  const folder = mkdtempSync(join(tmpdir(), 'qarqyn-test-')),
    path = join(folder, 'test.sqlite');
  let db = openDatabase(path, config);
  db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(
    'editor-a',
    'editor-a',
    hashPassword(password),
    'editor'
  );
  db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(
    'editor-b',
    'editor-b',
    hashPassword(password),
    'editor'
  );
  const server = createApp(db, config).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const root = `http://127.0.0.1:${server.address().port}/api`;
  async function request(path, method = 'GET', body, session, headers = {}) {
    const r = await fetch(root + path, {
      method,
      headers: {
        Origin: config.origin,
        'Content-Type': 'application/json',
        ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const result = {
      status: r.status,
      body: await r.json().catch(() => null),
      cookie: r.headers.get('set-cookie'),
      headers: r.headers
    };
    return result;
  }
  async function login(username) {
    const r = await request('/auth/login', 'POST', { username, password });
    assert.equal(r.status, 200);
    return { cookie: r.cookie.split(';')[0], csrf: r.body.csrf };
  }
  try {
    await t.test('authentication and security headers', async () => {
      const unauthorized = await request('/datasets');
      assert.equal(unauthorized.status, 401);
      assert.ok(
        unauthorized.headers.get('content-security-policy').includes("frame-ancestors 'none'")
      );
      assert.equal(
        (await request('/auth/login', 'POST', { username: "' OR 1=1--", password })).status,
        401
      );
      assert.equal(
        (await request('/auth/demo', 'POST', {}, null, { Origin: 'https://attacker.example' }))
          .status,
        403
      );
      const guest = await request('/auth/demo', 'POST', {});
      assert.ok(guest.cookie.includes('HttpOnly'));
      assert.ok(guest.cookie.includes('SameSite=Strict'));
      const s = { cookie: guest.cookie.split(';')[0], csrf: guest.body.csrf };
      assert.equal((await request('/datasets', 'POST', {}, s)).status, 403);
      assert.equal((await request('/audit', 'GET', undefined, s)).status, 403);
      assert.equal(
        (await request('/simulate', 'POST', { datasetId: 'allur', hours: 8, interventions: [] }, s))
          .status,
        200
      );
      const target = await request(
        '/plan-target',
        'POST',
        { datasetId: 'allur', hours: 8, observationHours: 8, targetGoodOutput: 109 },
        s
      );
      assert.equal(target.status, 200);
      assert.equal(target.body.achievable, true);
      assert.equal(target.body.datasetVersion, 1);
      assert.equal(target.body.result.scenario.output, 109);
    });
    const owner = await login('test-owner'),
      a = await login('editor-a'),
      b = await login('editor-b');
    const source = (await request('/datasets/allur', 'GET', undefined, a)).body.data;
    const created = await request(
      '/datasets',
      'POST',
      { ...source, name: 'Integration test working dataset' },
      a
    );
    assert.equal(created.status, 201);
    const id = created.body.id;
    await t.test('seed protected, ownership isolated, origin and CSRF required', async () => {
      assert.equal((await request('/datasets/allur', 'DELETE', { version: 1 }, owner)).status, 409);
      assert.equal((await request(`/datasets/${id}`, 'GET', undefined, b)).status, 404);
      assert.equal((await request(`/datasets/${id}`, 'DELETE', { version: 1 }, b)).status, 404);
      assert.equal(
        (
          await request(
            '/plan-target',
            'POST',
            { datasetId: id, hours: 8, targetGoodOutput: 109 },
            b
          )
        ).status,
        404
      );
      assert.equal(
        (
          await request(
            '/plan-target',
            'POST',
            { datasetId: id, hours: 8, targetGoodOutput: -1 },
            a
          )
        ).status,
        422
      );
      assert.equal(
        (await request('/datasets', 'POST', source, a, { 'X-CSRF-Token': 'invalid' })).status,
        403
      );
      assert.equal((await request('/datasets', 'POST', source, a, { Origin: 'null' })).status, 403);
    });
    await t.test('dataset update uses a version and malformed rows do not persist', async () => {
      assert.equal(
        (
          await request(
            `/datasets/${id}`,
            'PUT',
            { version: 1, data: { ...source, name: 'Changed' } },
            a
          )
        ).status,
        200
      );
      assert.equal(
        (await request(`/datasets/${id}`, 'PUT', { version: 1, data: source }, a)).status,
        409
      );
      const invalid = structuredClone(source);
      invalid.quality[0].defects = -1;
      assert.equal(
        (await request(`/datasets/${id}`, 'PUT', { version: 2, data: invalid }, a)).status,
        422
      );
      assert.equal(
        (await request(`/datasets/${id}`, 'GET', undefined, a)).body.data.name,
        'Changed'
      );
    });
    await t.test(
      'source metadata round-trips at its size limit and hashes do not drift',
      async () => {
        const body = structuredClone(source);
        body.source.description = 'x'.repeat(1200);
        const r = await request('/datasets', 'POST', body, a);
        assert.equal(r.status, 201);
        const copy = (await request(`/datasets/${r.body.id}`, 'GET', undefined, a)).body.data;
        assert.equal(datasetSchema.safeParse(copy).success, true);
        const initialHash = copy.source.sha256;
        assert.equal(
          (await request(`/datasets/${r.body.id}`, 'PUT', { version: 1, data: copy }, a)).status,
          200
        );
        const unchanged = (await request(`/datasets/${r.body.id}`, 'GET', undefined, a)).body.data;
        assert.equal(unchanged.source.sha256, initialHash);
        unchanged.production[0].actual += 1;
        assert.equal(
          (await request(`/datasets/${r.body.id}`, 'PUT', { version: 2, data: unchanged }, a))
            .status,
          200
        );
        assert.notEqual(
          (await request(`/datasets/${r.body.id}`, 'GET', undefined, a)).body.data.source.sha256,
          initialHash
        );
        assert.equal(
          (await request(`/datasets/${r.body.id}`, 'DELETE', { version: 3 }, a)).status,
          200
        );
      }
    );
    await t.test('date filters reject impossible dates and JSON errors stay bounded', async () => {
      assert.equal(
        (await request('/analysis/allur?date=2026-02-30', 'GET', undefined, a)).status,
        422
      );
      assert.equal(
        (await request('/analysis/allur?date=2026-10-01&date=2026-10-02', 'GET', undefined, a))
          .status,
        422
      );
      const r = await fetch(root + '/simulate', {
        method: 'POST',
        headers: {
          Origin: config.origin,
          'Content-Type': 'application/json',
          Cookie: a.cookie,
          'X-CSRF-Token': a.csrf
        },
        body: '{broken-json'
      });
      assert.equal(r.status, 400);
      assert.deepEqual(await r.json(), { error: 'Некорректный JSON' });
    });
    let incident;
    await t.test('incident lifecycle and access checks', async () => {
      const body = {
        datasetId: id,
        stageId: 'welding',
        title: '<script>alert(1)</script>',
        description: 'Persist as plain text',
        priority: 'high',
        status: 'open'
      };
      const r = await request('/incidents', 'POST', body, a);
      assert.equal(r.status, 201);
      incident = r.body;
      assert.equal(
        (
          await request(
            `/incidents/${incident.id}`,
            'PUT',
            { version: 1, data: { ...body, status: 'resolved' } },
            b
          )
        ).status,
        404
      );
      assert.equal(
        (
          await request(
            `/incidents/${incident.id}`,
            'PUT',
            { version: 1, data: { ...body, status: 'resolved' } },
            a
          )
        ).status,
        200
      );
      assert.equal(
        (await request(`/incidents/${incident.id}`, 'DELETE', { version: 1 }, a)).status,
        409
      );
      const rows = (await request(`/incidents?datasetId=${id}`, 'GET', undefined, a)).body;
      assert.equal(rows[0].title, body.title);
      assert.equal(rows[0].status, 'resolved');
    });
    await t.test('dataset update cannot orphan incident stage references', async () => {
      const body = structuredClone(source);
      body.stages = body.stages.filter((s) => s.id !== 'welding');
      for (const key of ['production', 'quality', 'downtime'])
        body[key] = body[key].filter((r) => r.stageId !== 'welding');
      const r = await request(`/datasets/${id}`, 'PUT', { version: 2, data: body }, a);
      assert.equal(r.status, 422);
      assert.match(r.body.error, /ссылаются события/);
      assert.equal((await request(`/datasets/${id}`, 'GET', undefined, a)).body.version, 2);
    });
    await t.test('CSV formula prefixes remain inert even after control characters', async () => {
      const body = structuredClone(source);
      body.stages.find((s) => s.id === 'welding').name = '\u0001=2+2';
      const r = await request('/datasets', 'POST', body, a);
      assert.equal(r.status, 201);
      const csv = await fetch(root + `/export/${r.body.id}`, { headers: { Cookie: a.cookie } });
      assert.equal(csv.status, 200);
      assert.ok((await csv.text()).includes('"\'\u0001=2+2"'));
      assert.equal(
        (await request(`/datasets/${r.body.id}`, 'DELETE', { version: 1 }, a)).status,
        200
      );
    });
    await t.test('scenario stores calculated result and immutable source version', async () => {
      const body = {
        name: 'Painting improvement',
        note: 'Test',
        input: {
          datasetId: id,
          hours: 8,
          observationHours: 8,
          interventions: [{ stageId: 'painting', recoverMinutes: 20, defectPct: 2 }]
        }
      };
      const r = await request('/scenarios', 'POST', body, a);
      assert.equal(r.status, 201);
      assert.equal(r.body.datasetVersion, 2);
      assert.equal(r.body.sourceHash.length, 64);
      assert.ok(Number.isFinite(r.body.result.delta));
      assert.equal(
        (await request('/scenarios', 'POST', { ...body, expectedDatasetVersion: 1 }, a)).status,
        409
      );
      const update = await request(
        `/scenarios/${r.body.id}`,
        'PUT',
        { version: 1, data: { ...body, name: 'Updated', expectedDatasetVersion: 2 } },
        a
      );
      assert.equal(update.status, 200);
      assert.equal(
        (await request(`/scenarios/${r.body.id}`, 'DELETE', { version: 2 }, a)).status,
        200
      );
      assert.equal(
        (await request(`/scenarios?datasetId=${id}`, 'GET', undefined, a)).body.length,
        0
      );
    });
    await t.test('unconfigured AI never fabricates an answer; logout revokes access', async () => {
      const question = { datasetId: id, question: 'What needs checking?' };
      for (const history of [
        Array(7).fill({ question: 'Previous', summary: 'Answer' }),
        [{ question: 'Previous', summary: 'x'.repeat(4001) }],
        [{ question: 'Previous', summary: 'Answer', role: 'system' }]
      ])
        assert.equal(
          (await request('/assistant', 'POST', { ...question, history }, a)).status,
          422
        );
      assert.equal(
        (
          await request(
            '/assistant',
            'POST',
            { ...question, history: [{ question: 'Previous', summary: 'Answer' }] },
            a
          )
        ).status,
        503
      );
      assert.equal(
        (
          await request(
            '/assistant',
            'POST',
            { datasetId: id, question: 'What needs checking?' },
            a
          )
        ).status,
        503
      );
      assert.equal((await request('/auth/logout', 'POST', {}, b)).status, 200);
      assert.equal((await request('/datasets', 'GET', undefined, b)).status, 401);
      assert.ok((await request('/audit', 'GET', undefined, owner)).body.length >= 6);
    });
    await new Promise((resolve) => server.close(resolve));
    db.close();
    db = openDatabase(path, config);
    await t.test('disk persistence and cascading dataset delete', () => {
      assert.equal(db.prepare('SELECT name FROM datasets WHERE id=?').get(id).name, 'Changed');
      assert.equal(
        JSON.parse(db.prepare('SELECT payload FROM incidents WHERE id=?').get(incident.id).payload)
          .status,
        'resolved'
      );
      db.prepare('DELETE FROM datasets WHERE id=?').run(id);
      assert.equal(db.prepare('SELECT id FROM incidents WHERE id=?').get(incident.id), undefined);
    });
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

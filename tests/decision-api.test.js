import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';

test('decision endpoints respect sessions, ownership, source versions and request schemas', async () => {
  const config = {
    adminUsername: 'decision-owner',
    adminPassword: randomBytes(24).toString('base64url'),
    sessionMs: 3600000,
    origin: 'http://localhost',
    testing: true,
    production: true,
    secure: false
  };
  const db = openDatabase(':memory:', config);
  const server = createApp(db, config).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const root = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (path, method = 'GET', data, session, csrf = true) => {
    const result = await fetch(root + path, {
      method,
      headers: {
        Origin: config.origin,
        'Content-Type': 'application/json',
        ...(session
          ? { Cookie: session.cookie, ...(csrf ? { 'X-CSRF-Token': session.csrf } : {}) }
          : {})
      },
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    return {
      status: result.status,
      body: await result.json(),
      cookie: result.headers.get('set-cookie')?.split(';')[0]
    };
  };
  try {
    assert.equal((await request('/forecast/allur')).status, 401);
    const auth = await request('/auth/demo', 'POST', {});
    const guest = { cookie: auth.cookie, csrf: auth.body.csrf };
    const first = await request('/forecast/allur', 'GET', undefined, guest);
    assert.equal(first.status, 200);
    assert.equal(first.body.datasetVersion, 1);
    assert.equal(first.body.observationCount, 2);
    assert.equal(first.body.readiness.status, 'provisional');
    const input = {
      datasetId: 'allur',
      expectedDatasetVersion: 1,
      hours: 8,
      observationHours: 8,
      targetGoodOutput: 109
    };
    assert.equal((await request('/impact', 'POST', input, guest, false)).status, 403);
    const impact = await request('/impact', 'POST', input, guest);
    assert.equal(impact.status, 200);
    assert.equal(impact.body.plannedOutput, 109);
    assert.equal(impact.body.datasetVersion, 1);
    assert.equal(
      (await request('/impact', 'POST', { ...input, expectedDatasetVersion: 2 }, guest)).status,
      409
    );
    assert.equal(
      (await request('/impact', 'POST', { ...input, unitContribution: -10 }, guest)).status,
      422
    );
    assert.equal(
      (await request('/impact', 'POST', { ...input, anything: 'unexpected' }, guest)).status,
      422
    );
    const ownerAuth = await request('/auth/login', 'POST', {
      username: config.adminUsername,
      password: config.adminPassword
    });
    const owner = { cookie: ownerAuth.cookie, csrf: ownerAuth.body.csrf };
    const original = await request('/datasets/allur', 'GET', undefined, owner);
    const copy = await request(
      '/datasets',
      'POST',
      { ...original.body.data, name: 'Decision endpoint isolation' },
      owner
    );
    assert.equal(copy.status, 201);
    assert.equal((await request(`/forecast/${copy.body.id}`, 'GET', undefined, guest)).status, 404);
    assert.equal(
      (await request('/impact', 'POST', { ...input, datasetId: copy.body.id }, guest)).status,
      404
    );
    const before = await request(`/forecast/${copy.body.id}`, 'GET', undefined, owner);
    assert.equal(before.body.datasetVersion, 1);
    const changed = structuredClone(original.body.data);
    changed.production.at(-1).actual -= 1;
    assert.equal(
      (await request(`/datasets/${copy.body.id}`, 'PUT', { version: 1, data: changed }, owner))
        .status,
      200
    );
    const after = await request(`/forecast/${copy.body.id}`, 'GET', undefined, owner);
    assert.equal(after.body.datasetVersion, 2);
    assert.notDeepEqual(before.body.stages, after.body.stages);
    assert.equal(
      (await request('/impact', 'POST', { ...input, datasetId: copy.body.id }, owner)).status,
      409
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

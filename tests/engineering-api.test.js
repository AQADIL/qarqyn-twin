import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase, hashPassword } from '../server/db.js';
import { createApp } from '../server/app.js';

test('engineering studies preserve access, versions, evidence and atomic task dispatch', async (t) => {
  const password = randomBytes(24).toString('hex');
  const config = {
    adminUsername: 'owner-test',
    adminPassword: password,
    sessionMs: 3600000,
    origin: 'http://localhost',
    testing: true,
    production: true,
    secure: false
  };
  const db = openDatabase(':memory:', config);
  for (const name of ['engineer-a', 'engineer-b'])
    db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(
      name,
      name,
      hashPassword(password),
      'editor'
    );
  const server = createApp(db, config).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api`;
  async function request(path, method = 'GET', data, session, withCsrf = true) {
    const response = await fetch(origin + path, {
      method,
      headers: {
        Origin: config.origin,
        'Content-Type': 'application/json',
        ...(session
          ? { Cookie: session.cookie, ...(withCsrf ? { 'X-CSRF-Token': session.csrf } : {}) }
          : {})
      },
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    return {
      status: response.status,
      body: await response.json(),
      cookie: response.headers.get('set-cookie')?.split(';')[0]
    };
  }
  async function login(username) {
    const result = await request('/auth/login', 'POST', { username, password });
    assert.equal(result.status, 200);
    return { cookie: result.cookie, csrf: result.body.csrf };
  }
  try {
    const a = await login('engineer-a'),
      b = await login('engineer-b');
    const demoAuth = await request('/auth/demo', 'POST', {});
    const guest = { cookie: demoAuth.cookie, csrf: demoAuth.body.csrf };
    const flow = {
      datasetId: 'allur',
      expectedDatasetVersion: 1,
      horizonMinutes: 20,
      materialCount: 5,
      assumptionsConfirmed: true,
      stages: ['welding', 'painting', 'assembly'].map((stageId) => ({
        stageId,
        machines: 1,
        cycleMinutes: 2,
        bufferCapacity: 2,
        initialWip: 0,
        reworkEvery: 0,
        maxRework: 0,
        downtime: []
      }))
    };
    const plan = {
      datasetId: 'allur',
      expectedDatasetVersion: 1,
      hours: 8,
      observationHours: 8,
      status: 'ready',
      actions: [
        {
          eventId: 'D1',
          title: 'Synthetic test intervention',
          owner: 'Test engineer',
          dueDate: '2026-10-16',
          mechanism: 'Controlled API fixture; not a maintenance prescription',
          evidence: 'Synthetic contract test',
          validationMethod: 'Record actual downtime under matching conditions',
          expectedRecoveredMinutes: 2,
          confidencePct: 50,
          confirmed: true,
          oneOffCost: 0,
          recurringCostPerPeriod: 0
        }
      ]
    };
    let study;
    await t.test('sessions, source version and CSRF protect every calculation', async () => {
      assert.equal((await request('/forecast-validation/allur')).status, 401);
      const validation = await request('/forecast-validation/allur', 'GET', undefined, guest);
      assert.equal(validation.status, 200);
      assert.equal(validation.body.datasetVersion, 1);
      assert.equal((await request('/flow-simulate', 'POST', flow, guest, false)).status, 403);
      assert.equal(
        (await request('/flow-simulate', 'POST', { ...flow, expectedDatasetVersion: 2 }, guest))
          .status,
        409
      );
      const result = await request('/flow-simulate', 'POST', flow, guest);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.completed, 5);
      assert.equal(result.body.conservation.difference, 0);
      assert.equal(
        (
          await request(
            '/action-plan/evaluate',
            'POST',
            { ...plan, expectedDatasetVersion: 2 },
            guest
          )
        ).status,
        409
      );
      const evaluated = await request('/action-plan/evaluate', 'POST', plan, guest);
      assert.equal(evaluated.status, 200, JSON.stringify(evaluated.body));
      assert.equal(evaluated.body.readiness.status, 'ready');
    });
    await t.test('malformed or excessive simulation cannot run', async () => {
      for (const mutation of [
        { materialCount: 999999 },
        { assumptionsConfirmed: false },
        { horizonMinutes: 999999 },
        { unknown: true }
      ])
        assert.equal(
          (await request('/flow-simulate', 'POST', { ...flow, ...mutation }, a)).status,
          422
        );
      assert.equal(
        (
          await request(
            '/action-plan/evaluate',
            'POST',
            { ...plan, actions: [{ ...plan.actions[0], eventId: 'D4' }] },
            a
          )
        ).status,
        422
      );
    });
    await t.test(
      'saved flow is recomputed and isolated by owner even on public source',
      async () => {
        const body = { name: 'Isolated study', input: flow, expectedDatasetVersion: 1 };
        assert.equal((await request('/flow-studies', 'POST', body, guest)).status, 403);
        assert.equal(
          (await request('/flow-studies', 'POST', { ...body, result: { completed: 9999 } }, a))
            .status,
          422
        );
        const saved = await request('/flow-studies', 'POST', body, a);
        assert.equal(saved.status, 201, JSON.stringify(saved.body));
        study = saved.body;
        assert.equal(study.result.completed, 5);
        assert.equal((await request(`/flow-studies/${study.id}`, 'GET', undefined, b)).status, 404);
        assert.equal(
          (await request(`/flow-studies/${study.id}`, 'DELETE', { version: 1 }, b)).status,
          404
        );
        assert.equal(
          (await request('/flow-studies?datasetId=allur', 'GET', undefined, b)).body.total,
          0
        );
        const detail = await request(`/flow-studies/${study.id}`, 'GET', undefined, a);
        assert.equal(detail.body.datasetSnapshot.version, 1);
        assert.equal(detail.body.datasetSnapshot.data.source.kind, 'organizer-test');
        assert.equal(
          (await request('/flow-studies?datasetId=allur&pageSize=999', 'GET', undefined, a)).status,
          422
        );
      }
    );
    await t.test('saved studies use optimistic versions and recalculate edits', async () => {
      const data = {
        name: 'Updated study',
        input: { ...flow, materialCount: 3 },
        expectedDatasetVersion: 1
      };
      const updated = await request(`/flow-studies/${study.id}`, 'PUT', { version: 1, data }, a);
      assert.equal(updated.status, 200);
      assert.equal(updated.body.version, 2);
      assert.equal(updated.body.result.completed, 3);
      assert.equal(
        (await request(`/flow-studies/${study.id}`, 'PUT', { version: 1, data }, a)).status,
        409
      );
      assert.equal(
        (await request(`/flow-studies/${study.id}`, 'DELETE', { version: 1 }, a)).status,
        409
      );
      assert.equal(
        (await request(`/flow-studies/${study.id}`, 'DELETE', { version: 2 }, a)).status,
        200
      );
    });
    await t.test(
      'private datasets cannot leak through calculations or stored reports',
      async () => {
        const source = (await request('/datasets/allur', 'GET', undefined, a)).body.data;
        const copy = await request(
          '/datasets',
          'POST',
          { ...source, name: 'Private engineering fixture' },
          a
        );
        const datasetId = copy.body.id;
        assert.equal(
          (await request(`/forecast-validation/${datasetId}`, 'GET', undefined, b)).status,
          404
        );
        assert.equal(
          (await request('/flow-simulate', 'POST', { ...flow, datasetId }, b)).status,
          404
        );
        assert.equal(
          (await request('/action-plan/evaluate', 'POST', { ...plan, datasetId }, b)).status,
          404
        );
        const saved = await request(
          '/flow-studies',
          'POST',
          {
            name: 'Private source snapshot',
            input: { ...flow, datasetId },
            expectedDatasetVersion: 1
          },
          a
        );
        assert.equal(saved.status, 201);
        const changed = await request(
          `/datasets/${datasetId}`,
          'PUT',
          { version: 1, data: { ...source, name: 'Changed fixture' } },
          a
        );
        assert.equal(changed.status, 200);
        assert.equal(
          (await request('/flow-simulate', 'POST', { ...flow, datasetId }, a)).status,
          409
        );
        const detail = await request(`/flow-studies/${saved.body.id}`, 'GET', undefined, a);
        assert.equal(detail.body.datasetSnapshot.version, 1);
      }
    );
    let savedPlan;
    await t.test('ready plans create assigned tasks exactly once', async () => {
      const saved = await request(
        '/action-plans',
        'POST',
        { name: 'Test handoff', input: plan, expectedDatasetVersion: 1 },
        a
      );
      assert.equal(saved.status, 201, JSON.stringify(saved.body));
      savedPlan = saved.body;
      const dispatchBody = { version: 1, expectedDatasetVersion: 1 };
      assert.equal(
        (await request(`/action-plans/${savedPlan.id}/tasks`, 'POST', dispatchBody, b)).status,
        404
      );
      assert.equal(
        (
          await request(
            `/action-plans/${savedPlan.id}/tasks`,
            'POST',
            { ...dispatchBody, expectedDatasetVersion: 2 },
            a
          )
        ).status,
        409
      );
      const created = await request(`/action-plans/${savedPlan.id}/tasks`, 'POST', dispatchBody, a);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.count, 1);
      assert.equal(created.body.items[0].assignee, plan.actions[0].owner);
      assert.match(created.body.items[0].description, /D1/);
      const repeat = await request(`/action-plans/${savedPlan.id}/tasks`, 'POST', dispatchBody, a);
      assert.equal(repeat.status, 200);
      assert.equal(repeat.body.alreadyCreated, true);
      assert.equal(repeat.body.items[0].id, created.body.items[0].id);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM incidents').get().n, 1);
    });
    await t.test('draft plans cannot be dispatched and resolved tasks require proof', async () => {
      const draft = await request(
        '/action-plans',
        'POST',
        {
          name: 'Unconfirmed fixture',
          input: { ...plan, status: 'draft', actions: [{ ...plan.actions[0], confirmed: false }] },
          expectedDatasetVersion: 1
        },
        a
      );
      assert.equal(draft.status, 201);
      assert.equal(
        (
          await request(
            `/action-plans/${draft.body.id}/tasks`,
            'POST',
            { version: 1, expectedDatasetVersion: 1 },
            a
          )
        ).status,
        422
      );
      assert.equal(
        (
          await request(
            '/incidents',
            'POST',
            {
              datasetId: 'allur',
              title: 'Unproven closure',
              description: '',
              stageId: null,
              priority: 'normal',
              status: 'resolved'
            },
            a
          )
        ).status,
        422
      );
    });
    await t.test('failed auditing rolls back saved studies and all dispatched tasks', async () => {
      const planCopy = await request(
        '/action-plans',
        'POST',
        { name: 'Atomic handoff', input: plan, expectedDatasetVersion: 1 },
        a
      );
      const studyCount = db.prepare('SELECT COUNT(*) AS n FROM engineering_studies').get().n;
      db.exec(
        "CREATE TRIGGER reject_engineering_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'test audit failure'); END;"
      );
      const result = await request(
        `/action-plans/${planCopy.body.id}/tasks`,
        'POST',
        { version: 1, expectedDatasetVersion: 1 },
        a
      );
      assert.equal(result.status, 500);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM incidents').get().n, 1);
      assert.equal(
        db
          .prepare('SELECT COUNT(*) AS n FROM engineering_dispatches WHERE study_id=?')
          .get(planCopy.body.id).n,
        0
      );
      assert.equal(
        (
          await request(
            '/flow-studies',
            'POST',
            { name: 'Must roll back', input: flow, expectedDatasetVersion: 1 },
            a
          )
        ).status,
        500
      );
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM engineering_studies').get().n, studyCount);
      db.exec('DROP TRIGGER reject_engineering_audit');
    });
    await t.test(
      'administrator dispatch preserves plan ownership and deletion cannot silently replay',
      async () => {
        const admin = await login('owner-test');
        const saved = await request(
          '/action-plans',
          'POST',
          { name: 'Admin assisted handoff', input: plan, expectedDatasetVersion: 1 },
          a
        );
        const path = `/action-plans/${saved.body.id}/tasks`;
        const body = { version: 1, expectedDatasetVersion: 1 };
        const dispatched = await request(path, 'POST', body, admin);
        assert.equal(dispatched.status, 201);
        const incident = dispatched.body.items[0];
        assert.equal((await request(`/incidents/${incident.id}`, 'GET', undefined, a)).status, 200);
        assert.equal((await request(`/incidents/${incident.id}`, 'GET', undefined, b)).status, 404);
        const repeated = await request(path, 'POST', body, a);
        assert.equal(repeated.status, 200);
        assert.equal(repeated.body.items[0].id, incident.id);
        assert.equal(repeated.body.count, repeated.body.items.length);
        assert.equal(
          (await request(`/incidents/${incident.id}`, 'DELETE', { version: incident.version }, a))
            .status,
          200
        );
        const deletedReplay = await request(path, 'POST', body, a);
        assert.equal(deletedReplay.status, 409);
        assert.match(deletedReplay.body.error, /удалена или недоступна/);
        assert.equal(
          db.prepare('SELECT COUNT(*) AS n FROM incidents WHERE id=?').get(incident.id).n,
          0
        );
      }
    );
    await t.test(
      'incomplete source permits an honest draft but cannot claim effect or dispatch',
      async () => {
        const source = (await request('/datasets/allur', 'GET', undefined, a)).body.data;
        const copy = await request(
          '/datasets',
          'POST',
          { ...source, name: 'Missing quality fixture', quality: [] },
          a
        );
        assert.equal(copy.status, 201);
        const input = { ...plan, datasetId: copy.body.id, status: 'draft' };
        const evaluated = await request('/action-plan/evaluate', 'POST', input, a);
        assert.equal(evaluated.status, 200);
        assert.equal(evaluated.body.readiness.status, 'draft');
        assert.equal(evaluated.body.modelReadiness.status, 'unavailable');
        assert.equal(evaluated.body.baselineOutput, null);
        assert.ok(evaluated.body.candidates.some((candidate) => candidate.id === 'D1'));
        const saved = await request(
          '/action-plans',
          'POST',
          { name: 'Awaiting source evidence', input, expectedDatasetVersion: 1 },
          a
        );
        assert.equal(saved.status, 201);
        assert.equal(
          (
            await request(
              `/action-plans/${saved.body.id}/tasks`,
              'POST',
              { version: 1, expectedDatasetVersion: 1 },
              a
            )
          ).status,
          422
        );
      }
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

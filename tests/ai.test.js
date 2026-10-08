import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDatabase } from '../server/db.js';
import { createAssistant } from '../server/ai.js';
const data = JSON.parse(readFileSync(new URL('../data/allur.json', import.meta.url), 'utf8'));
const config = {
  adminUsername: 'test',
  adminPassword: 'test-only-password-42',
  aiUrl: 'https://provider.invalid/v1',
  aiKey: 'test-only-key',
  aiModel: 'test-model',
  aiReasoning: 'medium',
  aiMaxOutput: 6000,
  aiBudget: 2,
  aiInputPrice: 2,
  aiOutputPrice: 10,
  aiTimeout: 1000
};
const request = {
  data,
  datasetId: 'allur',
  datasetVersion: 1,
  question: 'Compare bottlenecks',
  userId: 'owner'
};
const insight = {
  summary: 'Test response',
  observations: [{ title: 'Quality', explanation: 'A test assertion', sourceIds: ['Q2'] }],
  nextSteps: ['Check source'],
  limitations: ['Test fixture'],
  proposal: {
    title: 'Test scenario',
    explanation: 'Test hypothesis',
    hours: 8,
    observationHours: 8,
    interventions: [{ stageId: 'painting', recoverMinutes: 20, defectPct: 2 }]
  }
};
function providerResponse(value = insight, status = 'completed') {
  return {
    ok: true,
    json: async () => ({
      status,
      output: [
        { type: 'reasoning', content: [] },
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }
      ],
      usage: { input_tokens: 2000, output_tokens: 1000 }
    })
  };
}
test('AI contract validates references, recalculates proposals and accounts tokens', async () => {
  const db = openDatabase(':memory:', config);
  try {
    const assistant = createAssistant(db, config, async (url, options) => {
      assert.equal(url, `${config.aiUrl}/responses`);
      const payload = JSON.parse(options.body);
      assert.equal(payload.reasoning.effort, 'medium');
      assert.equal(payload.store, false);
      assert.equal(payload.text.format.strict, true);
      assert.equal(payload.max_output_tokens, 6000);
      return providerResponse();
    });
    const result = await assistant.ask(request);
    assert.equal(result.proposal.result.delta, 2.59);
    assert.equal(result.usage.estimatedCostUsd, 0.014);
    assert.equal(assistant.budget().accountedUsd, 0.014);
    assert.equal(db.prepare('SELECT state FROM ai_usage').get().state, 'completed');
  } finally {
    db.close();
  }
});
test('AI unknown sources, infeasible changes and incomplete output are rejected', async () => {
  const db = openDatabase(':memory:', config);
  try {
    const badId = structuredClone(insight);
    badId.observations[0].sourceIds = ['UNKNOWN'];
    await assert.rejects(
      createAssistant(db, config, async () => providerResponse(badId)).ask(request),
      /неизвестную ссылку/
    );
    const badRecovery = structuredClone(insight);
    badRecovery.proposal.interventions[0].recoverMinutes = 400;
    await assert.rejects(
      createAssistant(db, config, async () => providerResponse(badRecovery)).ask(request),
      /границы/
    );
    await assert.rejects(
      createAssistant(db, config, async () => providerResponse(insight, 'incomplete')).ask(request),
      /не завершил/
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_usage').get().n, 3);
  } finally {
    db.close();
  }
});
test('budget rejects before network and ambiguous transport failure retains reservation', async () => {
  const db = openDatabase(':memory:', config);
  let calls = 0;
  try {
    await assert.rejects(
      createAssistant(db, { ...config, aiBudget: 0.001 }, async () => {
        calls++;
      }).ask(request),
      /бюджет/
    );
    assert.equal(calls, 0);
    const assistant = createAssistant(db, config, async () => {
      calls++;
      throw new Error('Disconnected');
    });
    await assert.rejects(assistant.ask(request), /прервано/);
    assert.equal(calls, 1);
    assert.ok(assistant.budget().accountedUsd > 0.06);
    assert.equal(db.prepare('SELECT state FROM ai_usage').get().state, 'reserved');
  } finally {
    db.close();
  }
});
test('same user cannot start concurrent paid requests', async () => {
  const db = openDatabase(':memory:', config);
  let finish;
  try {
    const assistant = createAssistant(
      db,
      config,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = assistant.ask(request);
    await assert.rejects(assistant.ask(request), /Предыдущий/);
    finish(providerResponse());
    await pending;
  } finally {
    db.close();
  }
});

test('budget admission uses unrounded amounts at the precision boundary', async () => {
  const db = openDatabase(':memory:', config);
  let encodedBytes = 0;
  try {
    await assert.rejects(
      createAssistant(db, config, async (url, options) => {
        encodedBytes = Buffer.byteLength(options.body);
        throw new Error('Test transport interruption');
      }).ask(request)
    );
    assert.ok(encodedBytes > 0);
    db.prepare('DELETE FROM ai_usage').run();
    let calls = 0;
    const assistant = createAssistant(
      db,
      {
        ...config,
        aiInputPrice: 20060 / encodedBytes,
        aiBudget: 0.080059
      },
      async () => {
        calls++;
        return providerResponse();
      }
    );
    await assert.rejects(assistant.ask(request), /бюджет/);
    assert.equal(calls, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_usage').get().n, 0);
  } finally {
    db.close();
  }
});

test('provider rejection releases reservation while absent usage and timeout retain it', async () => {
  const db = openDatabase(':memory:', config);
  try {
    const rejected = createAssistant(db, config, async () => ({ ok: false, status: 401 }));
    await assert.rejects(rejected.ask(request), /отклонил ключ/);
    assert.equal(rejected.budget().accountedUsd, 0);
    assert.equal(db.prepare('SELECT state FROM ai_usage').get().state, 'rejected');
    const noUsage = createAssistant(db, config, async () => ({
      ok: true,
      json: async () => {
        const body = await providerResponse().json();
        delete body.usage;
        return body;
      }
    }));
    const answer = await noUsage.ask(request);
    assert.equal(answer.usage, null);
    assert.ok(answer.budget.accountedUsd > 0.06);
    const beforeTimeout = answer.budget.accountedUsd;
    const timedOut = createAssistant(db, config, async () => {
      throw new DOMException('Test timeout', 'TimeoutError');
    });
    await assert.rejects(timedOut.ask(request), (error) => error.status === 504);
    assert.ok(timedOut.budget().accountedUsd > beforeTimeout);
  } finally {
    db.close();
  }
});

test('oversized context and structurally invalid provider content never become accepted answers', async () => {
  const db = openDatabase(':memory:', config);
  let calls = 0;
  try {
    const largeData = structuredClone(data);
    largeData.production = Array.from({ length: 1100 }, (_, i) => ({
      ...data.production[0],
      id: `EX${i}`
    }));
    const bounded = createAssistant(db, config, async () => {
      calls++;
      return providerResponse();
    });
    await assert.rejects(
      bounded.ask({ ...request, data: largeData }),
      (error) => error.status === 422
    );
    assert.equal(calls, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_usage').get().n, 0);
    await assert.rejects(
      createAssistant(db, config, async () =>
        providerResponse({ summary: 'Missing required fields' })
      ).ask(request),
      /проверку структуры/
    );
    assert.equal(bounded.budget().accountedUsd, 0.014);
  } finally {
    db.close();
  }
});

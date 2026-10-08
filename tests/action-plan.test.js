import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateActionPlan } from '../server/action-plan.js';

const allur = JSON.parse(readFileSync(new URL('../data/allur.json', import.meta.url)));
const request = { datasetId: 'allur', expectedDatasetVersion: 1, hours: 8, observationHours: 8 };
const action = {
  eventId: 'D1',
  title: 'Проверить и закрепить разъём датчика',
  owner: 'Инженер участка',
  dueDate: '2026-10-10',
  mechanism: 'Осмотр подтвердил ослабленный контакт.',
  evidence: 'Протокол осмотра и контрольного прогона',
  validationMethod: 'Сравнить журнал остановок за сопоставимые смены.',
  expectedRecoveredMinutes: 20,
  confidencePct: 80,
  confirmed: true,
  oneOffCost: 100,
  recurringCostPerPeriod: 10
};

test('event minutes are normalized by observed periods; engineering evidence and source stay attached', () => {
  const result = evaluateActionPlan(allur, { ...request, actions: [action] });
  assert.equal(result.actions[0].normalizedRecoveredMinutes, 10);
  assert.equal(result.actions[0].eventMinutes, 25);
  assert.equal(result.actions[0].equipment, 'ABB-01');
  assert.deepEqual(result.actions[0].sourceIds, ['D1']);
  assert.equal(result.readiness.status, 'ready');
  assert.ok(result.plannedOutput > result.baselineOutput);
  assert.equal(result.economics.knownTotalCost, 110);
  assert.equal(result.economics.netContribution, null);
  assert.equal(result.economics.status, 'missing_inputs');
});

test('planned, unknown, unavailable and duplicated events cannot create recoverable time', () => {
  for (const patch of [
    { actions: [{ ...action, eventId: 'D4' }] },
    { actions: [{ ...action, eventId: 'D2' }] },
    { actions: [{ ...action, eventId: 'missing' }] },
    { actions: [{ ...action, expectedRecoveredMinutes: 26 }] },
    { actions: [action, { ...action }] },
    { date: '2026-10-02', actions: [action] }
  ])
    assert.throws(
      () => evaluateActionPlan(allur, { ...request, ...patch }),
      (error) => error.status === 422
    );
});

test('incomplete drafts are explicit and cannot be marked ready for execution', () => {
  const incomplete = { eventId: 'D1', expectedRecoveredMinutes: 5 };
  const result = evaluateActionPlan(allur, { ...request, actions: [incomplete] });
  assert.equal(result.readiness.status, 'draft');
  assert.ok(result.readiness.blockers.some((value) => value.includes('ответственного')));
  assert.ok(
    result.readiness.blockers.some((value) => value.includes('подтверждение оценки минут'))
  );
  assert.equal(result.economics.unknownCostCount, 1);
  assert.throws(
    () => evaluateActionPlan(allur, { ...request, status: 'ready', actions: [incomplete] }),
    (error) => error.status === 422
  );
  assert.throws(
    () => evaluateActionPlan(allur, { ...request, status: 'ready' }),
    (error) => error.status === 422
  );
});

const simple = {
  ...allur,
  stages: [{ id: 'welding', name: 'Сварка', kind: 'production' }],
  production: [
    {
      id: 'P1',
      date: '2026-10-01',
      stageId: 'welding',
      line: 'L1',
      plan: 80,
      actual: 60,
      runtimeHours: 6,
      utilizationPct: 75,
      periodHours: 8
    }
  ],
  quality: [{ id: 'Q1', date: '2026-10-01', stageId: 'welding', produced: 60, defects: 0 }],
  downtime: [
    {
      id: 'D1',
      date: '2026-10-01',
      stageId: 'welding',
      equipment: 'M1',
      reason: 'Останов',
      classification: 'unplanned',
      minutes: 60
    },
    {
      id: 'D2',
      date: '2026-10-01',
      stageId: 'welding',
      equipment: 'M1',
      reason: 'ТО',
      classification: 'planned',
      minutes: 60
    }
  ],
  plans: []
};

test('hand-calculated engineering plan honors demand, recurring costs and partial execution', () => {
  const result = evaluateActionPlan(simple, {
    ...request,
    actions: [{ ...action, expectedRecoveredMinutes: 60 }],
    realizationPct: 50,
    periods: 2,
    unitContribution: 50,
    maxAdditionalSalesPerPeriod: 3,
    economicEvidence: 'Подтверждённый заказ: 3 машины за смену; маржа по калькуляции.'
  });
  assert.equal(result.baselineOutput, 60);
  assert.equal(result.plannedOutput, 70);
  assert.equal(result.partialOutput, 65);
  assert.equal(result.economics.additionalUnits, 10);
  assert.equal(result.economics.soldUnits, 6);
  assert.equal(result.economics.unsoldUnits, 4);
  assert.equal(result.economics.knownTotalCost, 120);
  assert.equal(result.economics.grossContribution, 300);
  assert.equal(result.economics.netContribution, 180);
  assert.equal(result.sensitivity.find((row) => row.realizationPct === 0).netContribution, -120);
});

test('confidence is engineer judgment, not an invented success probability', () => {
  const low = evaluateActionPlan(simple, {
    ...request,
    actions: [{ ...action, confidencePct: 10 }]
  });
  const high = evaluateActionPlan(simple, {
    ...request,
    actions: [{ ...action, confidencePct: 99 }]
  });
  assert.equal(low.plannedOutput, high.plannedOutput);
  assert.equal(low.partialOutput, high.partialOutput);
});

test('transferred target is checked against partial execution, not the full promised result', () => {
  const result = evaluateActionPlan(simple, {
    ...request,
    targetGoodOutput: 69,
    actions: [{ ...action, expectedRecoveredMinutes: 60 }],
    realizationPct: 50
  });
  assert.equal(result.targetGoodOutput, 69);
  assert.equal(result.plannedOutput, 70);
  assert.equal(result.partialOutput, 65);
  assert.equal(result.targetMet, false);
  assert.equal(result.targetGap, 4);
  const full = evaluateActionPlan(simple, { ...result.input, realizationPct: 100 });
  assert.equal(full.targetMet, true);
  assert.equal(full.targetGap, 0);
});

test('no economics is claimed without explicit demand, costs and their source', () => {
  for (const input of [
    { unitContribution: 50, economicEvidence: 'Калькуляция' },
    { unitContribution: 50, maxAdditionalSalesPerPeriod: 5 },
    { maxAdditionalSalesPerPeriod: 5, economicEvidence: 'Заказ' }
  ]) {
    const result = evaluateActionPlan(simple, { ...request, ...input, actions: [action] });
    assert.equal(result.economics.netContribution, null);
    assert.equal(result.economics.knownTotalCost, 110);
  }
  const zeroDemand = evaluateActionPlan(simple, {
    ...request,
    actions: [action],
    unitContribution: 50,
    maxAdditionalSalesPerPeriod: 0,
    economicEvidence: 'Дополнительных заказов нет'
  });
  assert.equal(zeroDemand.economics.soldUnits, 0);
  assert.equal(zeroDemand.economics.netContribution, -110);
});

test('schema rejects invalid money, fabricated flags and unreasonable inputs', () => {
  for (const patch of [
    { actions: [{ ...action, oneOffCost: -1 }] },
    { actions: [{ ...action, oneOffCost: 0.015 }] },
    { actions: [{ ...action, confidencePct: 101 }] },
    { actions: [{ ...action, dueDate: '2026-02-30' }] },
    { actions: [{ ...action, approvedByPlant: true }] },
    { periods: 367 },
    { hours: Infinity },
    { unexpected: true }
  ])
    assert.throws(
      () => evaluateActionPlan(allur, { ...request, ...patch }),
      (error) => error.status === 422
    );
});

test('missing quality preserves real maintenance candidates and draft work without fabricated effects', () => {
  const data = structuredClone(allur);
  data.quality = [];
  const result = evaluateActionPlan(data, {
    ...request,
    targetGoodOutput: 109,
    actions: [action],
    unitContribution: 100,
    maxAdditionalSalesPerPeriod: 20,
    economicEvidence:
      'Synthetic test: available economic inputs cannot replace missing quality records.'
  });
  assert.equal(result.candidates.length, 4);
  assert.equal(result.candidates.find((event) => event.id === 'D1').eligible, true);
  assert.equal(result.actions[0].equipment, 'ABB-01');
  assert.equal(result.actions[0].normalizedRecoveredMinutes, 10);
  assert.equal(result.readiness.status, 'draft');
  assert.equal(result.modelReadiness.status, 'unavailable');
  assert.ok(result.modelReadiness.blockers.some((value) => value.includes('качества')));
  for (const key of ['baselineOutput', 'plannedOutput', 'partialOutput', 'targetGap', 'targetMet'])
    assert.equal(result[key], null);
  for (const key of [
    'additionalUnits',
    'soldUnits',
    'unsoldUnits',
    'grossContribution',
    'netContribution'
  ])
    assert.equal(result.economics[key], null);
  assert.equal(result.economics.knownTotalCost, 110);
  assert.equal(result.economics.status, 'missing_inputs');
  assert.deepEqual(result.sensitivity, []);
  assert.ok(result.sourceIds.includes('D1'));
  assert.throws(
    () => evaluateActionPlan(data, { ...result.input, status: 'ready' }),
    (error) => error.status === 422
  );
  assert.deepEqual(evaluateActionPlan(data, JSON.parse(JSON.stringify(result.input))), result);
  const restored = evaluateActionPlan(allur, result.input);
  assert.equal(restored.modelReadiness.status, 'available');
  assert.equal(restored.readiness.status, 'ready');
  assert.ok(restored.plannedOutput > restored.baselineOutput);
});

test('unequal observed dates block estimated effect while retaining draft costs and event evidence', () => {
  const data = structuredClone(allur);
  data.production = data.production.filter((row) => row.id !== 'P4');
  data.quality = data.quality.filter((row) => row.id !== 'Q4');
  data.downtime = data.downtime.filter((row) => row.id !== 'D4');
  const result = evaluateActionPlan(data, { ...request, actions: [action] });
  assert.equal(result.readiness.status, 'draft');
  assert.equal(result.actions[0].observations, 1);
  assert.equal(result.actions[0].normalizedRecoveredMinutes, 20);
  assert.equal(result.economics.knownTotalCost, 110);
  assert.equal(result.partialOutput, null);
  assert.equal(result.economics.netContribution, null);
  assert.ok(result.modelReadiness.blockers.some((value) => value.includes('одинаковые даты')));
});

test('opening an empty action draft works on incomplete valid sources and keeps unknowns null', () => {
  for (const update of [
    (data) => {
      data.quality = [];
    },
    (data) => {
      data.downtime = [];
    }
  ]) {
    const data = structuredClone(allur);
    update(data);
    const result = evaluateActionPlan(data, { ...request, actions: [] });
    assert.equal(result.candidates.length, data.downtime.length);
    assert.equal(result.modelReadiness.status, 'unavailable');
    assert.equal(result.readiness.status, 'draft');
    assert.deepEqual(result.actions, []);
    assert.equal(result.baselineOutput, null);
    assert.equal(result.plannedOutput, null);
    assert.equal(result.economics.additionalUnits, null);
    assert.equal(result.economics.knownTotalCost, 0);
  }
});

test('draft handling still rejects malformed source records before any partial result', () => {
  const data = structuredClone(allur);
  data.quality = [];
  data.production[0].runtimeHours = -1;
  assert.throws(
    () => evaluateActionPlan(data, { ...request, actions: [] }),
    (error) => error.status === 422
  );
});

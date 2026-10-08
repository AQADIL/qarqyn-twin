import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planTarget, simulate } from '../server/analytics.js';
import { simulationSchema } from '../server/schema.js';

const source = JSON.parse(readFileSync(new URL('../data/allur.json', import.meta.url), 'utf8'));
function fixture() {
  return {
    ...structuredClone(source),
    stages: [
      { id: 'a', name: 'Stage A', kind: 'production' },
      { id: 'b', name: 'Stage B', kind: 'production' }
    ],
    production: ['a', 'b'].map((stageId, i) => ({
      id: `P${i}`,
      date: '2026-10-01',
      stageId,
      line: stageId,
      plan: 100,
      actual: 100,
      runtimeHours: 10,
      utilizationPct: 100
    })),
    quality: ['a', 'b'].map((stageId, i) => ({
      id: `Q${i}`,
      date: '2026-10-01',
      stageId,
      produced: 100,
      defects: 0
    })),
    downtime: [
      {
        id: 'D0',
        date: '2026-10-01',
        stageId: 'a',
        equipment: 'A1',
        reason: 'Test stoppage',
        minutes: 60
      },
      {
        id: 'D1',
        date: '2026-10-01',
        stageId: 'a',
        equipment: 'A1',
        reason: 'Плановое ТО',
        minutes: 60
      },
      {
        id: 'D2',
        date: '2026-10-01',
        stageId: 'b',
        equipment: 'B1',
        reason: 'Test stoppage',
        minutes: 180
      }
    ]
  };
}
const input = { datasetId: 'allur', hours: 10, observationHours: 10, targetGoodOutput: 85 };
const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);

test('target already met produces no intervention or artificial improvement', () => {
  const plan = planTarget(fixture(), { ...input, targetGoodOutput: 65 });
  assert.equal(plan.achievable, true);
  assert.equal(plan.reasonCode, 'already_met');
  assert.equal(plan.totalRecoverMinutes, 0);
  assert.deepEqual(plan.interventions, []);
  assert.deepEqual(plan.input.interventions, []);
  close(plan.baselineGoodOutput, 70);
  assert.equal(plan.result.delta, 0);
});

test('inverse plan attains the goal with coordinate-wise minimal recovery and excludes planned maintenance', () => {
  const data = fixture();
  const plan = planTarget(data, input);
  assert.equal(plan.achievable, true);
  assert.equal(plan.reasonCode, 'achievable');
  assert.equal(simulationSchema.safeParse(plan.input).success, true);
  close(plan.maxGoodOutput, 90);
  close(plan.result.scenario.output, 85);
  close(plan.totalRecoverMinutes, 120);
  close(plan.interventions[0].recoverMinutes, 30);
  close(plan.interventions[1].recoverMinutes, 90);
  assert.equal(plan.evidence[0].availableMinutes, 60);
  assert.equal(plan.evidence[0].excludedPlannedMinutes, 60);
  assert.deepEqual(plan.evidence[0].excludedSourceIds, ['D1']);
  for (const intervention of plan.input.interventions) {
    const reduced = structuredClone(plan.input);
    reduced.interventions.find((s) => s.stageId === intervention.stageId).recoverMinutes -= 0.1;
    assert.ok(simulate(data, reduced).scenario.output < input.targetGoodOutput);
    assert.equal(intervention.defectPct, null);
    const bound = plan.evidence.find((s) => s.stageId === intervention.stageId);
    assert.ok(
      intervention.recoverMinutes >= 0 && intervention.recoverMinutes <= bound.availableMinutes
    );
  }
});

test('backward calculation includes every downstream quality yield', () => {
  const data = fixture();
  data.quality[0].defects = 10;
  data.quality[1].defects = 20;
  const plan = planTarget(data, { ...input, targetGoodOutput: 63 });
  assert.equal(plan.achievable, true);
  close(plan.result.scenario.output, 63);
  close(plan.interventions[0].recoverMinutes, 45);
  close(plan.interventions[1].recoverMinutes, 52.5);
  close(plan.maxGoodOutput, 64.8);
});

test('unattainable targets return a bound without a fabricated scenario', () => {
  const plan = planTarget(fixture(), { ...input, targetGoodOutput: 91 });
  assert.equal(plan.achievable, false);
  assert.equal(plan.reasonCode, 'beyond_capacity');
  close(plan.maxGoodOutput, 90);
  close(plan.shortfall, 1);
  assert.equal(plan.input, null);
  assert.equal(plan.result, null);
  assert.deepEqual(plan.interventions, []);
  const zeroOutput = fixture();
  zeroOutput.quality[1].defects = 100;
  assert.equal(planTarget(zeroOutput, { ...input, targetGoodOutput: 1e-12 }).achievable, false);
});

test('target planner rejects invalid limits and missing observations instead of assuming quality', () => {
  for (const invalid of [
    { ...input, targetGoodOutput: 0 },
    { ...input, targetGoodOutput: 1000001 },
    { ...input, hours: 0 },
    { ...input, observationHours: 25 },
    { ...input, recoverMinutes: 9999 }
  ])
    assert.throws(
      () => planTarget(fixture(), invalid),
      (e) => e.status === 422
    );
  for (const mutate of [
    (data) => {
      data.production = [];
    },
    (data) => {
      data.quality = [];
    },
    (data) => {
      data.quality.pop();
    },
    (data) => {
      data.downtime[0].minutes = -1;
    }
  ]) {
    const data = fixture();
    mutate(data);
    assert.throws(
      () => planTarget(data, input),
      (e) => e.status === 422
    );
  }
});

test('original Allur target 109 is attainable while 110 exceeds the fixed-quality limit', () => {
  const request = { datasetId: 'allur', hours: 8, observationHours: 8, targetGoodOutput: 109 };
  const plan = planTarget(source, request);
  assert.equal(plan.achievable, true);
  close(plan.result.scenario.output, 109);
  close(plan.maxGoodOutput, 109.34186130723752);
  assert.equal(plan.evidence.find((s) => s.stageId === 'welding').excludedPlannedMinutes, 15);
  assert.equal(planTarget(source, { ...request, targetGoodOutput: 110 }).achievable, false);
});

test('large observed equipment downtime cannot bypass the 480-minute scenario limit', () => {
  const data = fixture();
  data.stages = data.stages.slice(0, 1);
  data.production = data.production.slice(0, 1);
  data.quality = data.quality.slice(0, 1);
  data.downtime = [{ ...data.downtime[0], minutes: 1000 }];
  const plan = planTarget(data, { ...input, targetGoodOutput: 10 });
  assert.equal(plan.achievable, true);
  assert.equal(plan.evidence[0].availableMinutes, 480);
  close(plan.interventions[0].recoverMinutes, 460);
  assert.equal(simulationSchema.safeParse(plan.input).success, true);
  assert.equal(planTarget(data, { ...input, targetGoodOutput: 14 }).achievable, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateImpact } from '../server/impact.js';

const data = JSON.parse(readFileSync(new URL('../data/allur.json', import.meta.url)));
const request = {
  datasetId: 'allur',
  expectedDatasetVersion: 1,
  hours: 8,
  observationHours: 8,
  targetGoodOutput: 109
};

test('economic decision uses minimum safe recovery and has no invented prices', () => {
  const value = evaluateImpact(data, request);
  assert.equal(value.achievable, true);
  assert.equal(value.plannedOutput, 109);
  assert.equal(value.economics.netContribution, null);
  assert.equal(value.economics.status, 'missing_inputs');
  assert.equal(value.interventions.length, 1);
  assert.equal(value.interventions[0].protectedMaintenanceMinutes, 15);
  assert.ok(value.interventions[0].recoverMinutes <= 12.5);
});

test('zero realization preserves baseline and charges supplied investment without fabricated gain', () => {
  const value = evaluateImpact(data, {
    ...request,
    realizationPct: 0,
    periods: 10,
    unitContribution: 200,
    implementationCost: 1000
  });
  assert.equal(value.realizedOutput, value.baselineOutput);
  assert.equal(value.totalGain, 0);
  assert.equal(value.economics.netContribution, -1000);
  assert.equal(value.economics.breakEvenPeriods, null);
  assert.equal(value.economics.status, 'no_gain');
});

test('economic thresholds derive from full precision flow and explicit assumptions', () => {
  const value = evaluateImpact(data, {
    ...request,
    periods: 4,
    unitContribution: 200,
    implementationCost: 1000
  });
  assert.ok(Math.abs(value.totalGain - 10.400134680134613) < 0.0001);
  assert.equal(value.economics.breakEvenUnits, 5);
  assert.equal(value.economics.breakEvenPeriods, 2);
  assert.ok(value.economics.netContribution > 1000);
  const half = evaluateImpact(data, { ...request, realizationPct: 50 });
  assert.ok(half.realizedOutput > half.baselineOutput && half.realizedOutput < value.plannedOutput);
  assert.equal(half.realizedOutput, half.sensitivity.find((s) => s.realizationPct === 50).output);
});

test('impossible target never promises financial effect or fabricates an intervention', () => {
  const value = evaluateImpact(data, {
    ...request,
    targetGoodOutput: 110,
    unitContribution: 200,
    implementationCost: 100
  });
  assert.equal(value.achievable, false);
  assert.equal(value.economics.status, 'unattainable');
  assert.equal(value.economics.netContribution, null);
  assert.equal(value.simulationInput, null);
  assert.deepEqual(value.interventions, []);
});

test('free action and zero contribution do not create infinite ROI or payback', () => {
  const free = evaluateImpact(data, { ...request, implementationCost: 0, unitContribution: 200 });
  assert.equal(free.economics.roiPct, null);
  assert.equal(free.economics.breakEvenPeriods, 0);
  const zero = evaluateImpact(data, { ...request, implementationCost: 100, unitContribution: 0 });
  assert.equal(zero.economics.breakEvenPeriods, null);
  assert.equal(zero.economics.breakEvenUnits, null);
  assert.equal(zero.economics.netContribution, -100);
});

test('impact rejects nonphysical and oversized inputs before computation', () => {
  for (const patch of [
    { realizationPct: 101 },
    { periods: 0 },
    { periods: 1.5 },
    { unitContribution: -1 },
    { expectedDatasetVersion: 0 },
    { unexpected: true }
  ]) {
    assert.throws(
      () => evaluateImpact(data, { ...request, ...patch }),
      (error) => error.status === 422
    );
  }
});

test('demand caps and recurring costs are reflected in every economic calculation', () => {
  const value = evaluateImpact(data, {
    ...request,
    periods: 4,
    unitContribution: 200,
    implementationCost: 1000,
    recurringCostPerPeriod: 50,
    maxAdditionalSalesPerPeriod: 1
  });
  assert.equal(value.economics.soldAdditionalUnits, 4);
  assert.equal(value.economics.unsoldAdditionalUnits, 6.4001);
  assert.equal(value.economics.grossContribution, 800);
  assert.equal(value.economics.recurringCost, 200);
  assert.equal(value.economics.netContribution, -400);
  assert.equal(value.economics.breakEvenPeriods, 7);
  assert.equal(value.economics.breakEvenUnits, 6);
  assert.equal(value.economics.roiPct, -33.33);
  assert.equal(value.sensitivity.at(-1).netContribution, -400);
  const noMargin = evaluateImpact(data, {
    ...request,
    unitContribution: 200,
    implementationCost: 1000,
    recurringCostPerPeriod: 200,
    maxAdditionalSalesPerPeriod: 1
  });
  assert.equal(noMargin.economics.breakEvenPeriods, null);
});

test('sub-cent money is rejected and very small demand never emits non-finite payback', () => {
  for (const implementationCost of [Number.MIN_VALUE, 0.001, 0.015])
    assert.throws(
      () => evaluateImpact(data, { ...request, implementationCost, unitContribution: 200 }),
      (error) => error.status === 422
    );
  const value = evaluateImpact(data, {
    ...request,
    implementationCost: 1e12,
    unitContribution: 0.01,
    maxAdditionalSalesPerPeriod: Number.MIN_VALUE
  });
  assert.equal(value.economics.breakEvenPeriods, null);
  const visit = (item) => {
    if (typeof item === 'number') assert.ok(Number.isFinite(item));
    if (item && typeof item === 'object') Object.values(item).forEach(visit);
  };
  visit(value);
});

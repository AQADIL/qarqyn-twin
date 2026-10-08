import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluatePilot } from '../server/pilot.js';

const organizer = JSON.parse(readFileSync(new URL('../data/allur.json', import.meta.url), 'utf8'));
const request = {
  datasetId: 'allur',
  expectedDatasetVersion: 1,
  stageId: 'welding',
  beforeDates: ['2026-10-01', '2026-10-02'],
  afterDates: ['2026-10-03', '2026-10-04']
};
function measuredPilot() {
  const data = structuredClone(organizer);
  data.stages = [{ id: 'welding', name: 'Сварка', kind: 'production' }];
  data.production = [100, 110, 120, 130].map((actual, index) => ({
    id: `P${index}`,
    stageId: 'welding',
    line: 'Line A',
    date: `2026-10-0${index + 1}`,
    actual,
    plan: 130,
    runtimeHours: 5,
    periodHours: 8,
    regime: 'Product A / shift8h',
    utilizationPct: 70
  }));
  data.quality = data.production.map((row, index) => ({
    id: `Q${index}`,
    date: row.date,
    stageId: row.stageId,
    produced: 100,
    defects: index < 2 ? 10 : 5
  }));
  data.downtime = data.production.slice(0, 2).map((row, index) => ({
    id: `D${index}`,
    date: row.date,
    stageId: row.stageId,
    equipment: 'Robot A',
    reason: 'Measured stoppage',
    classification: 'unplanned',
    minutes: 10
  }));
  data.observationCoverage = data.production.map((row) => ({
    stageId: row.stageId,
    date: row.date,
    downtimeComplete: true
  }));
  return data;
}

test('pilot compares actual before-after facts with explicit per-period and runtime normalization', () => {
  const data = measuredPilot();
  const original = structuredClone(data);
  const result = evaluatePilot(data, request);
  assert.deepEqual(data, original);
  assert.equal(result.comparable, true);
  assert.equal(result.datasetVersion, 1);
  assert.deepEqual(result.metrics.outputPerPeriod, {
    before: 105,
    after: 125,
    delta: 20,
    unit: 'шт./период',
    comparable: true,
    detail: null
  });
  assert.equal(result.metrics.outputPerRuntimeHour.before, 21);
  assert.equal(result.metrics.outputPerRuntimeHour.after, 25);
  assert.equal(result.metrics.outputPerRuntimeHour.delta, 4);
  assert.equal(result.metrics.defectPct.delta, -5);
  assert.equal(result.metrics.downtimeMinutesPerPeriod.before, 10);
  assert.equal(result.metrics.downtimeMinutesPerPeriod.after, 0);
  assert.equal(result.metrics.downtimeMinutesPerPeriod.delta, -10);
  assert.equal(result.before.output, 210);
  assert.equal(result.after.output, 250);
  assert.equal(result.sourceIds.length, 10);
  assert.equal(result.evidenceLevel, 'descriptive');
  assert.match(result.warnings.join(' '), /не доказывает/);
  assert.match(result.warnings.join(' '), /Денежная экономия.*не рассчитываются/);
});

test('single-date organizer periods produce descriptive observations, not invented comparability', () => {
  const result = evaluatePilot(organizer, {
    ...request,
    beforeDates: ['2026-10-01'],
    afterDates: ['2026-10-02']
  });
  assert.equal(result.comparable, false);
  assert.deepEqual(
    result.reasons.map((reason) => reason.code),
    ['period_unknown', 'regime_unknown']
  );
  assert.equal(result.before.output, 118);
  assert.equal(result.after.output, 111);
  assert.equal(result.metrics.outputPerPeriod.delta, null);
  assert.equal(result.metrics.downtimeMinutesPerPeriod.before, null);
  assert.equal(result.before.downtime.registeredMinutes, 25);
  assert.match(result.warnings.join(' '), /только одна дата/);
});

test('pilot rejects overlaps, repetitions, interleaving, absent dates and nonproduction stages', () => {
  for (const patch of [
    { beforeDates: [] },
    { beforeDates: ['2026-10-01', '2026-10-01'] },
    { afterDates: ['2026-10-02'] },
    { beforeDates: ['2026-10-01', '2026-10-04'], afterDates: ['2026-10-02', '2026-10-03'] },
    { afterDates: ['2030-01-01'] },
    { beforeDates: ['2026-02-30'] },
    { stageId: 'warehouse' },
    { expectedDatasetVersion: 0 },
    { claimedSavings: 1000000 }
  ])
    assert.throws(
      () => evaluatePilot(measuredPilot(), { ...request, ...patch }),
      (error) => error.status === 422
    );
});

test('pilot with different line, period length or declared regime cannot claim a comparable delta', () => {
  for (const [key, value, reason] of [
    ['line', 'Line B', 'line_mismatch'],
    ['periodHours', 10, 'period_mismatch'],
    ['regime', 'Product B', 'regime_mismatch']
  ]) {
    const data = measuredPilot();
    data.production.slice(2).forEach((row) => {
      row[key] = value;
    });
    const result = evaluatePilot(data, request);
    assert.equal(result.comparable, false);
    assert.ok(result.reasons.some((row) => row.code === reason));
    assert.equal(result.metrics.outputPerPeriod.before, 105);
    assert.equal(result.metrics.outputPerPeriod.after, 125);
    assert.equal(result.metrics.outputPerPeriod.delta, null);
  }
});

test('missing quality and unconfirmed event-free periods remain unknown without hiding observed records', () => {
  const data = measuredPilot();
  data.quality = data.quality.filter((row) => row.date !== '2026-10-04');
  data.observationCoverage = data.observationCoverage.filter((row) => row.date !== '2026-10-04');
  const result = evaluatePilot(data, request);
  assert.equal(result.comparable, true);
  assert.equal(result.metrics.outputPerPeriod.delta, 20);
  assert.equal(result.metrics.defectPct.after, 5);
  assert.equal(result.metrics.defectPct.comparable, false);
  assert.equal(result.metrics.defectPct.delta, null);
  assert.equal(result.after.downtime.totalMinutes, null);
  assert.equal(result.after.downtime.registeredMinutes, null);
  assert.ok(result.after.downtime.classification.every((row) => row.registeredMinutes === null));
  assert.equal(result.metrics.downtimeMinutesPerPeriod.after, null);
  assert.equal(result.metrics.downtimeMinutesPerPeriod.delta, null);
  data.quality = [];
  const absent = evaluatePilot(data, request);
  assert.equal(absent.metrics.defectPct.before, null);
  assert.equal(absent.metrics.defectPct.after, null);
});

test('different numbers of observed periods use per-period means rather than misleading totals', () => {
  const result = evaluatePilot(measuredPilot(), { ...request, beforeDates: ['2026-10-01'] });
  assert.equal(result.before.observationCount, 1);
  assert.equal(result.after.observationCount, 2);
  assert.equal(result.metrics.outputPerPeriod.before, 100);
  assert.equal(result.metrics.outputPerPeriod.after, 125);
  assert.equal(result.metrics.outputPerPeriod.delta, 25);
});

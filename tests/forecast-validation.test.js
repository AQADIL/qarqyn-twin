import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateForecast } from '../server/forecast-validation.js';

const organizer = JSON.parse(readFileSync(new URL('../data/allur.json', import.meta.url), 'utf8'));
const metric = (report, key = 'output') =>
  report.stages[0].metrics.find((item) => item.key === key);

function syntheticHistory(values) {
  const data = structuredClone(organizer);
  data.stages = [{ id: 'welding', name: 'Сварка', kind: 'production' }];
  data.production = values.map((actual, index) => ({
    id: `P${index}`,
    date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
    stageId: 'welding',
    line: 'Test line',
    plan: 200,
    actual,
    runtimeHours: 8,
    periodHours: 8,
    regime: 'Synthetic test fixture',
    utilizationPct: 90
  }));
  data.quality = data.production.map((row, index) => ({
    id: `Q${index}`,
    date: row.date,
    stageId: row.stageId,
    produced: 100,
    defects: 2
  }));
  data.downtime = [];
  data.observationCoverage = data.production.map((row) => ({
    stageId: row.stageId,
    date: row.date,
    downtimeComplete: true
  }));
  return data;
}

test('organizer history cannot manufacture holdout, improvements or forecast accuracy', () => {
  const before = structuredClone(organizer);
  const result = validateForecast(organizer);
  assert.deepEqual(organizer, before);
  assert.equal(result.version, 'forecast-validation-v1');
  assert.equal(result.summary.better, 0);
  assert.equal(result.summary.evaluated, 0);
  for (const value of result.stages.flatMap((stage) => stage.metrics)) {
    assert.equal(value.status, 'insufficient');
    assert.equal(value.metrics, null);
    assert.equal(value.training, null);
    assert.equal(value.nextEstimate, null);
    assert.deepEqual(value.rows, []);
    assert.ok(value.readiness.additionalObservations >= 14);
  }
});

test('minimum history separates eight training periods from eight held-out observations', () => {
  const short = metric(validateForecast(syntheticHistory(Array(15).fill(100))));
  assert.equal(short.metrics, null);
  assert.equal(short.readiness.additionalObservations, 1);
  const enough = metric(validateForecast(syntheticHistory(Array(16).fill(100))));
  assert.equal(enough.training.observations, 8);
  assert.equal(enough.holdout.observations, 8);
  assert.equal(enough.training.candidates[0].folds, 5);
  assert.equal(enough.selectedMethod, 'persistence');
  assert.equal(enough.status, 'baseline');
  assert.equal(enough.metrics.mae, 0);
  assert.equal(enough.metrics.improvementPct, null);
});

test('long comparable trend earns a measured stable gain with fully paired evidence', () => {
  const value = metric(
    validateForecast(syntheticHistory(Array.from({ length: 80 }, (_, index) => 100 + index * 3)))
  );
  assert.equal(value.training.observations, 60);
  assert.equal(value.holdout.observations, 20);
  assert.equal(value.selectedMethod, 'local-trend');
  assert.equal(value.metrics.mae, 0);
  assert.equal(value.metrics.baselineMae, 3);
  assert.equal(value.metrics.improvementPct, 100);
  assert.equal(value.status, 'better');
  assert.equal(value.pairedEvidence.wins, 20);
  assert.equal(value.pairedEvidence.positiveBlocks, 4);
  assert.equal(value.pairedEvidence.interval.low, 3);
  assert.equal(value.pairedEvidence.interval.high, 3);
  assert.equal(value.nextEstimate, 340);
  for (const row of value.rows) {
    assert.ok(row.knownThrough < row.date);
    assert.ok(row.methodSelectedThrough < row.date);
  }
});

test('changing all holdout targets cannot change training selection or the first prediction', () => {
  const values = Array.from({ length: 80 }, (_, index) => 100 + 2 * index);
  const original = metric(validateForecast(syntheticHistory(values)));
  const shocked = metric(
    validateForecast(
      syntheticHistory(values.map((value, index) => (index >= 60 ? 8000 - index * 17 : value)))
    )
  );
  assert.deepEqual(shocked.training, original.training);
  assert.equal(shocked.selectedMethod, original.selectedMethod);
  assert.equal(shocked.rows[0].predicted, original.rows[0].predicted);
  assert.equal(shocked.rows[0].baseline, original.rows[0].baseline);
  const lastShock = metric(
    validateForecast(syntheticHistory(values.map((value, index) => (index === 79 ? 99999 : value))))
  );
  assert.deepEqual(lastShock.rows.slice(0, -1), original.rows.slice(0, -1));
  assert.equal(lastShock.rows.at(-1).predicted, original.rows.at(-1).predicted);
});

test('training winner remains frozen even when a held-out plateau makes it worse', () => {
  const values = [
    ...Array.from({ length: 60 }, (_, index) => 100 + index * 3),
    ...Array(20).fill(277)
  ];
  const value = metric(validateForecast(syntheticHistory(values)));
  assert.equal(value.selectedMethod, 'local-trend');
  assert.ok(value.metrics.mae > value.metrics.baselineMae);
  assert.equal(value.metrics.improvementPct, null);
  assert.equal(value.status, 'baseline');
  assert.equal(value.rows.length, 20);
});

test('measured gains on short holdout never earn the stability verdict', () => {
  const value = metric(
    validateForecast(syntheticHistory(Array.from({ length: 32 }, (_, index) => 100 + index)))
  );
  assert.equal(value.metrics.improvementPct, 100);
  assert.equal(value.holdout.observations, 8);
  assert.equal(value.pairedEvidence.interval, null);
  assert.equal(value.status, 'baseline');
});

test('zero event-free periods require explicit coverage and cannot invent equipment observations', () => {
  const data = syntheticHistory(Array(80).fill(100));
  const complete = metric(validateForecast(data), 'downtime');
  assert.equal(complete.observations, 80);
  assert.equal(complete.metrics.mae, 0);
  assert.equal(complete.rows[0].coverageEvidence.downtimeComplete, true);
  assert.deepEqual(complete.rows[0].sourceIds, []);
  data.observationCoverage = [];
  const unknown = metric(validateForecast(data), 'downtime');
  assert.equal(unknown.observations, 0);
  assert.equal(unknown.metrics, null);
  assert.equal(unknown.status, 'insufficient');
});

test('a recorded event for every date does not prove complete downtime coverage', () => {
  const data = syntheticHistory(Array(80).fill(100));
  data.observationCoverage = [];
  data.downtime = data.production.map((row, index) => ({
    id: `D${index}`,
    date: row.date,
    stageId: row.stageId,
    equipment: 'Fixture',
    reason: 'Synthetic test',
    minutes: index + 1
  }));
  const value = metric(validateForecast(data), 'downtime');
  assert.equal(value.metrics.improvementPct, 100);
  assert.equal(value.readiness.completeCoverage, false);
  assert.equal(value.status, 'insufficient');
  assert.match(value.readiness.blockers.join(' '), /полноту журнала/);
});

test('missing duration and incomplete quality gate empirical wins without hiding measured errors', () => {
  const data = syntheticHistory(Array.from({ length: 80 }, (_, index) => 100 + index));
  data.production.forEach((row) => delete row.periodHours);
  data.quality.splice(35, 1);
  const result = validateForecast(data);
  assert.equal(metric(result).metrics.improvementPct, 100);
  assert.equal(metric(result).status, 'insufficient');
  assert.equal(metric(result, 'quality').readiness.missingDates.length, 1);
  assert.equal(metric(result, 'quality').status, 'insufficient');
});

test('current regime only is evaluated and an apparent old win cannot survive a regime reset', () => {
  const data = syntheticHistory(Array.from({ length: 80 }, (_, index) => 100 + index));
  data.production.slice(-2).forEach((row) => {
    row.regime = 'Other fixture regime';
  });
  const value = metric(validateForecast(data));
  assert.equal(value.observations, 2);
  assert.equal(value.readiness.excludedPriorRegimeDates, 78);
  assert.equal(value.metrics, null);
  assert.equal(value.status, 'insufficient');
});

test('validation uses full history beyond chart display caps and is deterministic', () => {
  const data = syntheticHistory(Array.from({ length: 220 }, (_, index) => 100 + index));
  const result = validateForecast(data);
  const value = metric(result);
  assert.equal(value.observations, 220);
  assert.equal(value.training.observations, 165);
  assert.equal(value.holdout.observations, 55);
  assert.equal(value.rows.length, 55);
  assert.deepEqual(result, validateForecast(data));
  for (const key of ['production', 'quality', 'downtime', 'observationCoverage'])
    data[key].reverse();
  assert.deepEqual(result, validateForecast(data));
});

test('every reported score agrees with exported per-period source evidence', () => {
  const data = syntheticHistory(
    Array.from({ length: 80 }, (_, index) => 100 + index + (index % 4))
  );
  const value = metric(validateForecast(data));
  const rounded = (number) => Number(number.toFixed(6));
  const errors = value.rows.map((row) => {
    assert.equal(row.absoluteError, rounded(Math.abs(row.actual - row.predicted)));
    assert.equal(row.baselineError, Math.abs(row.actual - row.baseline));
    assert.ok(
      data.production.some(
        (record) => record.id === row.sourceIds[0] && record.actual === row.actual
      )
    );
    return row.absoluteError;
  });
  assert.equal(
    value.metrics.mae,
    rounded(errors.reduce((sum, error) => sum + error, 0) / errors.length)
  );
});

test('irregular sampling remains flagged instead of fabricating calendar interpolation', () => {
  const data = syntheticHistory(Array(32).fill(100));
  for (const key of ['production', 'quality', 'observationCoverage'])
    data[key].at(-1).date = '2026-03-01';
  const value = metric(validateForecast(data));
  assert.equal(value.observations, 32);
  assert.equal(value.status, 'insufficient');
  assert.match(value.readiness.blockers.join(' '), /Интервалы/);
});

test('malformed source data is rejected rather than silently normalized to a forecast', () => {
  const data = syntheticHistory(Array(16).fill(100));
  data.production[0].actual = -1;
  assert.throws(() => validateForecast(data));
});

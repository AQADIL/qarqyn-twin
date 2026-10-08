import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { forecast } from '../server/forecast.js';

const organizer = JSON.parse(readFileSync(new URL('../data/allur.json', import.meta.url), 'utf8'));
const stage = (result, id = 'welding') => result.stages.find((value) => value.stageId === id);

function history(values) {
  const data = structuredClone(organizer);
  data.stages = [{ id: 'welding', name: 'Сварка', kind: 'production' }];
  data.production = values.map((actual, index) => ({
    id: `P${index}`,
    date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
    stageId: 'welding',
    line: 'Line A',
    plan: 200,
    actual,
    runtimeHours: 8,
    utilizationPct: 90
  }));
  data.quality = data.production.map((row, index) => ({
    id: `Q${index}`,
    date: row.date,
    stageId: row.stageId,
    produced: 100,
    defects: index % 3
  }));
  data.downtime = data.production.map((row, index) => ({
    id: `D${index}`,
    date: row.date,
    stageId: row.stageId,
    equipment: 'Station A',
    reason: 'Recorded event',
    minutes: 10 + (index % 4)
  }));
  return data;
}

test('organizer two-date forecasts stay provisional with no fabricated accuracy', () => {
  const before = structuredClone(organizer);
  const result = forecast(organizer);
  assert.deepEqual(organizer, before);
  assert.equal(result.version, 'forecast-v1');
  assert.equal(result.observationCount, 2);
  assert.equal(result.readiness.status, 'provisional');
  assert.equal(result.summary.backtestedMetrics, 0);
  assert.equal(stage(result).nextOutput, 111);
  assert.equal(stage(result, 'painting').nextOutput, 116);
  assert.equal(stage(result, 'assembly').nextOutput, 119);
  assert.equal(stage(result, 'painting').nextDefectPct, 5.1724);
  assert.equal(stage(result).output.method, 'persistence');
  assert.equal(stage(result).output.validation.mae, null);
  assert.equal(stage(result).output.validation.baselineMae, null);
  assert.equal(stage(result).output.range.kind, 'observed');
  assert.equal(stage(result).output.range.probability, null);
  assert.deepEqual([stage(result).output.range.low, stage(result).output.range.high], [111, 118]);
  assert.equal(stage(result, 'warehouse').nextOutput, null);
  assert.equal(stage(result, 'warehouse').output.range, null);
  assert.equal(result.summary.bottleneckStageId, 'welding');
  assert.match(result.summary.text, /не доказанное/);
});

test('missing downtime is unknown and equipment thresholds are not applied to summed stages', () => {
  const result = forecast(organizer);
  const painting = stage(result, 'painting');
  assert.equal(painting.nextDowntimeMinutes, 40);
  assert.equal(painting.downtime.observationCount, 1);
  assert.deepEqual(painting.downtime.missingDates, ['2026-10-02']);
  assert.match(painting.downtime.scope, /не означает ноль/);
  assert.equal(stage(result).equipment[0].nextDowntimeMinutes, 25);
  assert.equal(stage(result).equipment[0].metric.observationCount, 1);
  const twoMachines = structuredClone(organizer);
  twoMachines.downtime = [
    { ...organizer.downtime[0], minutes: 40 },
    { ...organizer.downtime[0], id: 'Dx', equipment: 'Other station', minutes: 40 }
  ];
  const value = stage(forecast(twoMachines));
  assert.equal(value.nextDowntimeMinutes, 80);
  assert.equal(
    value.risks.some((risk) => risk.kind === 'downtime'),
    false
  );
});

test('absent quality and downtime remain null rather than zero', () => {
  const data = structuredClone(organizer);
  data.quality = [];
  data.downtime = [];
  const result = forecast(data);
  for (const value of result.stages) {
    assert.equal(value.nextDefectPct, null);
    assert.equal(value.nextDowntimeMinutes, null);
    assert.equal(value.quality.method, null);
    assert.equal(value.quality.validation.improvementPct, null);
    assert.deepEqual(value.equipment, []);
  }
  assert.equal(
    result.dataPriorities.some((item) => item.id === 'quality-coverage'),
    true
  );
});

test('rows are grouped by date and quality percentages are weighted by inspected counts', () => {
  const data = history([100]);
  data.production.push({ ...data.production[0], id: 'Pother', line: 'Line B', actual: 200 });
  data.quality = [
    { ...data.quality[0], produced: 100, defects: 10 },
    { ...data.quality[0], id: 'Qother', produced: 900, defects: 0 }
  ];
  const value = stage(forecast(data));
  assert.equal(value.nextOutput, 300);
  assert.equal(value.output.observationCount, 1);
  assert.equal(value.nextDefectPct, 1);
  assert.deepEqual(value.output.sourceIds, ['P0', 'Pother']);
  assert.deepEqual(value.quality.sourceIds, ['Q0', 'Qother']);
});

test('model comparison waits for five genuinely held-out observations', () => {
  const value = stage(forecast(history([100, 102, 104, 106, 108, 110, 112]))).output;
  assert.equal(value.validation.folds, 4);
  assert.equal(value.method, 'persistence');
  assert.equal(value.validation.status, 'insufficient');
  assert.equal(value.validation.mae, null);
  assert.deepEqual(value.validation.candidates, []);
});

test('rolling-origin selects a trend only after earlier out-of-sample evidence supports it', () => {
  const value = stage(
    forecast(history(Array.from({ length: 12 }, (_, index) => 100 + 3 * index)))
  ).output;
  assert.equal(value.method, 'local-trend');
  assert.equal(value.estimate, 136);
  assert.equal(value.validation.status, 'backtested');
  assert.equal(value.validation.folds, 9);
  assert.equal(value.validation.baselineMae, 3);
  assert.equal(value.validation.mae, 1.6667);
  assert.ok(value.validation.improvementPct > 40);
  assert.equal(value.validation.backtest[4].method, 'persistence');
  assert.equal(value.validation.backtest[5].method, 'local-trend');
  assert.equal(value.validation.backtest[5].selectionFolds, 5);
  for (const fold of value.validation.backtest) {
    assert.ok(fold.trainThrough < fold.date);
    assert.ok(fold.trainingObservations >= 3);
  }
});

test('future appended shocks cannot change any earlier prediction or its model selection', () => {
  const values = Array.from({ length: 12 }, (_, index) => 100 + 3 * index);
  const first = stage(forecast(history(values))).output;
  const later = stage(forecast(history([...values, 9000, 10, 1, 99000]))).output;
  assert.deepEqual(
    later.validation.backtest.slice(0, first.validation.folds),
    first.validation.backtest
  );
  const shock = later.validation.backtest[first.validation.folds];
  assert.equal(shock.predicted, first.estimate);
  assert.equal(shock.actual, 9000);
  assert.equal(shock.trainThrough, '2026-01-12');
});

test('tied models preserve persistence and zero baseline error never fabricates improvement', () => {
  const value = stage(forecast(history(Array(12).fill(100)))).output;
  assert.equal(value.method, 'persistence');
  assert.equal(value.validation.mae, 0);
  assert.equal(value.validation.baselineMae, 0);
  assert.equal(value.validation.improvementPct, null);
});

test('empirical error range requires twenty held-out errors and states no probability guarantee', () => {
  const small = stage(
    forecast(history(Array.from({ length: 22 }, (_, index) => 100 + index)))
  ).output;
  const large = stage(
    forecast(history(Array.from({ length: 23 }, (_, index) => 100 + index)))
  ).output;
  assert.equal(small.validation.folds, 19);
  assert.equal(small.range.kind, 'observed');
  assert.equal(large.validation.folds, 20);
  assert.equal(large.range.kind, 'empirical');
  assert.equal(large.range.probability, null);
  assert.equal(large.range.calibrationObservations, 20);
  assert.equal(large.range.errorQuantile, 0.9);
  assert.ok(large.range.low <= large.estimate && large.range.high >= large.estimate);
  assert.match(large.range.label, /не гарантируется/);
});

test('quality trend extrapolation respects 0–100 percent physical bounds', () => {
  const data = history(Array(10).fill(100));
  data.quality.forEach((row, index) => {
    row.defects = 10 * (index + 1);
  });
  const value = stage(forecast(data)).quality;
  assert.equal(value.method, 'local-trend');
  assert.equal(value.estimate, 100);
  assert.ok(
    value.validation.backtest.every((fold) => fold.predicted >= 0 && fold.predicted <= 100)
  );
});

test('sparse and unsorted dates are not interpolated or counted as observed zero days', () => {
  const data = history([110, 90, 105]);
  const dates = ['2026-01-01', '2026-02-01', '2026-04-15'];
  for (const key of ['production', 'quality', 'downtime']) {
    data[key].forEach((row, index) => {
      row.date = dates[index];
    });
    data[key].reverse();
  }
  const result = forecast(data);
  assert.equal(result.observationCount, 3);
  assert.deepEqual(result.observedDates, dates);
  assert.equal(stage(result).nextOutput, 105);
  assert.deepEqual(
    stage(result).output.points.map((point) => point.date),
    dates
  );
});

test('forecast validates source schema and never silently accepts malformed data', () => {
  const data = structuredClone(organizer);
  data.quality[0].defects = 1000;
  assert.throws(() => forecast(data), /Брак не может превышать/);
});

test('long histories retain complete validation statistics while bounding displayed evidence', () => {
  const value = stage(forecast(history(Array(200).fill(100)))).output;
  assert.equal(value.observationCount, 200);
  assert.equal(value.validation.folds, 197);
  assert.equal(value.points.length, 180);
  assert.equal(value.historyTruncated, true);
  assert.equal(value.validation.backtest.length, 80);
  assert.equal(value.validation.backtestTruncated, true);
  assert.equal(value.validation.mae, 0);
  assert.equal(value.validation.backtest.at(-1).trainingObservations, 199);
  assert.equal(value.sourceIds.length, 200);
});

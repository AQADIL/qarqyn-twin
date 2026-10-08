import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyze, simulate, classifyDowntime } from '../server/analytics.js';
import { datasetSchema } from '../server/schema.js';

const source = JSON.parse(readFileSync(new URL('../data/allur.json', import.meta.url), 'utf8'));
const options = { datasetId: 'allur', hours: 8, observationHours: 8, interventions: [] };
const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
function singleStage() {
  const data = structuredClone(source);
  data.stages = [{ id: 'welding', name: 'Сварка', kind: 'production' }];
  data.production = [{ ...data.production[0], actual: 1000000, plan: 1000000, runtimeHours: 8 }];
  data.quality = [{ ...data.quality[0], produced: 1000000, defects: 49 }];
  data.downtime = [];
  data.observationCoverage = [
    { stageId: 'welding', date: data.production[0].date, downtimeComplete: true }
  ];
  return data;
}

test('small measured defects are retained through flow math rather than rounded to zero', () => {
  const data = singleStage();
  assert.equal(analyze(data).stages[0].defectPct, 0.0049);
  close(simulate(data, options).baseline.rawOutput, 999951);
  const changed = simulate(data, {
    ...options,
    interventions: [{ stageId: 'welding', recoverMinutes: 0, defectPct: 0 }]
  });
  assert.equal(changed.delta, 49);
});

test('missing losses remain unknown; only explicit complete ledger establishes zero downtime', () => {
  const data = singleStage();
  data.observationCoverage = [];
  data.quality = [];
  const unknown = analyze(data);
  assert.equal(unknown.totals.defects, null);
  assert.equal(unknown.totals.downtimeMinutes, null);
  assert.equal(unknown.stages[0].downtimeMinutes, null);
  assert.equal(unknown.modelReadiness.canSimulate, false);
  assert.throws(
    () => simulate(data, options),
    (error) => error.status === 422
  );
  const confirmed = singleStage();
  assert.equal(analyze(confirmed).totals.downtimeMinutes, 0);
  assert.equal(simulate(confirmed, options).baseline.output, 999951);
});

test('date-filtered recovery never subtracts maintenance from another day', () => {
  const first = analyze(source, '2026-10-01').recoveryLimits.find(
    (row) => row.stageId === 'welding'
  );
  const second = analyze(source, '2026-10-02').recoveryLimits.find(
    (row) => row.stageId === 'welding'
  );
  assert.equal(first.maxMinutes, 25);
  assert.equal(first.excludedPlannedMinutes, 0);
  assert.deepEqual(first.unplannedSourceIds, ['D1']);
  assert.equal(second.maxMinutes, 0);
  assert.equal(second.excludedPlannedMinutes, 30);
  assert.deepEqual(second.excludedSourceIds, ['D4']);
});

test('explicit classification overrides legacy text and unknown events cannot be recovered', () => {
  assert.deepEqual(classifyDowntime({ reason: 'Плановое ТО', classification: 'unknown' }), {
    kind: 'unknown',
    basis: 'explicit'
  });
  assert.equal(classifyDowntime({ reason: ' Техническое обслуживание ' }).kind, 'planned');
  assert.equal(classifyDowntime({ reason: 'Внеплановая поломка' }).kind, 'unplanned');
  assert.equal(classifyDowntime({ reason: 'Замена фильтра' }).kind, 'unknown');
  const analysis = analyze(source);
  const painting = analysis.recoveryLimits.find((row) => row.stageId === 'painting');
  assert.equal(painting.maxMinutes, 0);
  assert.equal(painting.excludedUnknownMinutes, 20);
  assert.throws(
    () =>
      simulate(source, {
        ...options,
        interventions: [{ stageId: 'painting', recoverMinutes: 1, defectPct: null }]
      }),
    /неизвестной классификацией/
  );
});

test('cross-period quality and downtime cannot enter an otherwise valid imported dataset', () => {
  for (const key of ['quality', 'downtime']) {
    const data = structuredClone(source);
    data[key][0].date = '2030-01-01';
    assert.equal(datasetSchema.safeParse(data).success, false);
    assert.throws(
      () => simulate(data, options),
      (error) => error.status === 422
    );
  }
});

test('partially missing quality coverage blocks simulation even with other measured quality', () => {
  const data = structuredClone(source);
  const removed = data.quality.shift();
  assert.equal(datasetSchema.safeParse(data).success, true);
  const stage = analyze(data).stages.find((row) => row.id === removed.stageId);
  assert.deepEqual(stage.coverage.missingQualityDates, [removed.date]);
  assert.throws(() => simulate(data, options), /качества/);
});

test('stationary flow rejects mixed line identities, periods and regimes rather than averaging them', () => {
  for (const mutate of [
    (data) => {
      data.production[3].line = 'Changed line';
    },
    (data) => {
      data.production[3].regime = 'Night shift';
    },
    (data) => {
      data.production[0].periodHours = 10;
    }
  ]) {
    const data = structuredClone(source);
    mutate(data);
    assert.equal(datasetSchema.safeParse(data).success, true);
    assert.throws(
      () => simulate(data, options),
      (error) => error.status === 422
    );
  }
  const data = singleStage();
  data.production[0].periodHours = 8;
  assert.throws(() => simulate(data, { ...options, observationHours: 10 }), /длительность/);
  data.production[0].periodHours = 7;
  assert.equal(datasetSchema.safeParse(data).success, false);
});

test('same-date parallel lines are inspectable but not treated as sequential one-line observations', () => {
  const data = singleStage();
  data.production.push({ ...data.production[0], id: 'Pparallel', line: 'Parallel line' });
  assert.equal(datasetSchema.safeParse(data).success, true);
  assert.throws(() => simulate(data, options), /одну линию/);
  data.production[1].line = data.production[0].line;
  assert.equal(datasetSchema.safeParse(data).success, false);
});

test('selected-date simulation consumes only its own complete observations', () => {
  const data = structuredClone(source);
  data.observationCoverage = data.production.map((row) => ({
    stageId: row.stageId,
    date: row.date,
    downtimeComplete: true
  }));
  const result = simulate(data, { ...options, date: '2026-10-01' });
  assert.ok(result.evidence.every((item) => !item.sourceIds.includes('D4')));
  assert.equal(result.recoveryLimits.find((item) => item.stageId === 'welding').maxMinutes, 25);
});

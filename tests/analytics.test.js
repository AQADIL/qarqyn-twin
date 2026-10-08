import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyze, simulate, optimize, wilson } from '../server/analytics.js';
import { datasetSchema, simulationSchema } from '../server/schema.js';
const data = JSON.parse(readFileSync(new URL('../data/allur.json', import.meta.url), 'utf8'));
test('organizer data validates and totals do not double count vehicle stages', () => {
  assert.equal(datasetSchema.safeParse(data).success, true);
  const a = analyze(data);
  assert.equal(a.totals.output, 240);
  assert.equal(a.totals.defects, 18);
  assert.equal(a.totals.downtimeMinutes, 150);
  assert.equal(a.totals.monthlyPlanned, 4800);
  assert.equal(a.totals.planGap, 700);
  assert.equal(a.totals.rows, 19);
  assert.equal(a.oee, null);
  assert.equal(a.stages.find((s) => s.id === 'painting').defectPct, 4.33);
  assert.equal(a.stages.find((s) => s.id === 'warehouse').rate, null);
  assert.equal(a.findings.filter((f) => f.kind === 'quality').length, 2);
});
test('date filtering is consistent across production, quality and downtime', () => {
  const a = analyze(data, '2026-10-01');
  assert.equal(a.totals.output, 121);
  assert.equal(a.totals.defects, 7);
  assert.equal(a.totals.downtimeMinutes, 65);
  assert.equal(analyze(data, '2026-12-01').totals.output, null);
});

test('missing final-stage and monthly-plan observations stay unknown', () => {
  const partial = structuredClone(data);
  partial.production = partial.production.filter(
    (r) => !(r.stageId === 'assembly' && r.date === '2026-10-01')
  );
  partial.plans = [];
  const a = analyze(partial, '2026-10-01');
  assert.equal(a.totals.output, null);
  assert.equal(a.totals.outputPlan, null);
  assert.equal(a.totals.monthlyPlanned, null);
  assert.equal(a.totals.planGap, null);
  assert.equal(
    a.findings.some((f) => f.id === 'monthly-gap'),
    false
  );
});

test('identical equipment labels in different stages do not combine into one downtime alert', () => {
  const independent = structuredClone(data);
  independent.downtime = [
    {
      id: 'D1',
      date: '2026-10-01',
      stageId: 'welding',
      equipment: 'Station 1',
      reason: 'Test',
      minutes: 40
    },
    {
      id: 'D2',
      date: '2026-10-01',
      stageId: 'painting',
      equipment: 'Station 1',
      reason: 'Test',
      minutes: 40
    }
  ];
  assert.equal(
    analyze(independent).findings.some((f) => f.kind === 'downtime'),
    false
  );
});
test('sequential model has a hand-calculated result and a bottleneck', () => {
  const fixture = structuredClone(data);
  fixture.stages = [
    { id: 'a', name: 'A', kind: 'production' },
    { id: 'b', name: 'B', kind: 'production' }
  ];
  fixture.production = fixture.stages.map((s, i) => ({
    id: `P${i}`,
    date: '2026-10-01',
    stageId: s.id,
    line: s.name,
    plan: 80,
    actual: i ? 160 : 80,
    runtimeHours: 8,
    utilizationPct: 100
  }));
  fixture.quality = fixture.stages.map((s, i) => ({
    id: `Q${i}`,
    date: '2026-10-01',
    stageId: s.id,
    produced: 100,
    defects: i ? 0 : 10
  }));
  fixture.downtime = [];
  const baseline = simulate(fixture, { hours: 8, observationHours: 8, interventions: [] });
  assert.equal(baseline.scenario.output, 72);
  assert.equal(baseline.delta, 0);
  assert.equal(baseline.sensitivity[0].stageId, 'a');
  assert.equal(
    simulate(fixture, {
      hours: 8,
      interventions: [{ stageId: 'a', recoverMinutes: 0, defectPct: 0 }]
    }).scenario.output,
    80
  );
});
test('scenario recovery is bounded, zero changes preserve baseline, quality 100 stops flow', () => {
  const base = { datasetId: 'allur', hours: 8, observationHours: 8, interventions: [] };
  assert.equal(simulate(data, base).delta, 0);
  assert.throws(
    () =>
      simulate(data, {
        ...base,
        interventions: [{ stageId: 'painting', recoverMinutes: 100, defectPct: 0 }]
      }),
    /простой/
  );
  assert.throws(
    () =>
      simulate(data, {
        ...base,
        interventions: [{ stageId: 'unknown', recoverMinutes: 0, defectPct: 0 }]
      }),
    /неизвестный/
  );
  assert.equal(
    simulate(data, {
      ...base,
      interventions: [{ stageId: 'painting', recoverMinutes: 0, defectPct: 100 }]
    }).scenario.output,
    0
  );
  const options = optimize(data, 8, 16);
  assert.equal(options.length, 3);
  assert.equal(options[0].input.observationHours, 16);
  for (let i = 1; i < options.length; i++) assert.ok(options[i - 1].delta >= options[i].delta);
});
test('schema rejects broken dates, duplicate references, impossible quality and unexpected keys', () => {
  for (const mutate of [
    (d) => (d.production[0].date = '2026-02-30'),
    (d) => (d.production[0].stageId = 'missing'),
    (d) => (d.quality[0].defects = 9999),
    (d) => d.production.push(d.production[0]),
    (d) => (d.quality[0].id = d.production[0].id),
    (d) => (d.production[0].stageId = 'warehouse'),
    (d) => d.stages.forEach((s) => (s.kind = 'buffer')),
    (d) => (d.production[0].runtimeHours = Number.MIN_VALUE),
    (d) => (d.admin = true)
  ]) {
    const d = structuredClone(data);
    mutate(d);
    assert.equal(datasetSchema.safeParse(d).success, false);
  }
  assert.equal(
    simulationSchema.safeParse({ datasetId: 'allur', hours: -1, interventions: [] }).success,
    false
  );
  assert.equal(
    simulationSchema.safeParse({
      datasetId: 'allur',
      hours: 8,
      interventions: [
        { stageId: 'welding', recoverMinutes: 0, defectPct: 0 },
        { stageId: 'welding', recoverMinutes: 0, defectPct: 0 }
      ]
    }).success,
    false
  );
});
test('Wilson bounds handle zero counts and all-defective samples', () => {
  assert.equal(wilson(0, 0), null);
  assert.equal(wilson(0, 100)[0], 0);
  assert.equal(wilson(100, 100)[1], 100);
});

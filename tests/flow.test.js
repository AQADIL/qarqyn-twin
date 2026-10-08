import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateFlow, flowSchema } from '../server/flow.js';

const data = {
  stages: [
    { id: 'a', name: 'A', kind: 'production' },
    { id: 'b', name: 'B', kind: 'production' }
  ]
};
const stage = (stageId, extra = {}) => ({
  stageId,
  machines: 1,
  cycleMinutes: 1,
  bufferCapacity: 0,
  initialWip: 0,
  reworkEvery: 0,
  maxRework: 0,
  downtime: [],
  ...extra
});
const input = (extra = {}) => ({
  datasetId: 'fixture',
  expectedDatasetVersion: 1,
  horizonMinutes: 10,
  materialCount: 20,
  assumptionsConfirmed: true,
  stages: [stage('a')],
  ...extra
});
function conservation(result) {
  const balance = result.conservation;
  assert.equal(balance.difference, 0);
  assert.equal(balance.totalInitial, balance.completed + balance.remainingWip + balance.unreleased);
  for (const snapshot of result.timeline)
    assert.equal(snapshot.completed + snapshot.wip + snapshot.unreleased, balance.totalInitial);
  for (const item of result.stages)
    for (const machine of item.machines) {
      assert.ok(
        Math.abs(
          Object.values(machine.minutes).reduce((a, b) => a + b, 0) - result.horizonMinutes
        ) < 0.00001
      );
    }
}

test('one machine completes exactly at the horizon without admitting an extra part', () => {
  const result = simulateFlow(data, input({ stages: [stage('a', { cycleMinutes: 2 })] }));
  assert.equal(result.completed, 5);
  assert.equal(result.firstCompletionMinute, 2);
  assert.equal(result.meanLeadMinutes, 2);
  assert.equal(result.conservation.unreleased, 15);
  assert.equal(result.conservation.remainingWip, 0);
  conservation(result);
});

test('parallel machines double deterministic capacity', () => {
  const result = simulateFlow(
    data,
    input({ stages: [stage('a', { machines: 2, cycleMinutes: 2 })] })
  );
  assert.equal(result.completed, 10);
  assert.equal(result.stages[0].machineMinutes.busy, 20);
  conservation(result);
});

test('zero buffer propagates backpressure and counts blocked time', () => {
  const result = simulateFlow(
    data,
    input({ horizonMinutes: 7, stages: [stage('a'), stage('b', { cycleMinutes: 3 })] })
  );
  assert.equal(result.completed, 2);
  assert.deepEqual(
    result.completions.map((entry) => entry.minute),
    [4, 7]
  );
  assert.equal(result.stages[0].machineMinutes.blocked, 4);
  assert.equal(result.stages[1].machineMinutes.starved, 1);
  conservation(result);
});

test('finite buffer absorbs upstream production without exceeding capacity', () => {
  const tight = simulateFlow(
    data,
    input({ stages: [stage('a'), stage('b', { cycleMinutes: 3 })] })
  );
  const buffered = simulateFlow(
    data,
    input({ stages: [stage('a'), stage('b', { cycleMinutes: 3, bufferCapacity: 2 })] })
  );
  assert.equal(buffered.completed, 3);
  assert.equal(buffered.stages[1].queuePeak, 2);
  assert.ok(buffered.stages[0].machineMinutes.blocked < tight.stages[0].machineMinutes.blocked);
  assert.ok(buffered.timeline.every((sample) => sample.stages[1].queued <= 2));
  conservation(buffered);
});

test('overlapping and touching stops are unioned and pause remaining service', () => {
  const result = simulateFlow(
    data,
    input({
      stages: [
        stage('a', {
          cycleMinutes: 2,
          downtime: [
            { machine: 1, startMinute: 1, endMinute: 4 },
            { machine: 1, startMinute: 3, endMinute: 5 },
            { machine: 1, startMinute: 5, endMinute: 6 }
          ]
        })
      ]
    })
  );
  assert.equal(result.stages[0].machineMinutes.down, 5);
  assert.deepEqual(result.stages[0].machines[0].downtime, [{ startMinute: 1, endMinute: 6 }]);
  assert.deepEqual(
    result.completions.map((entry) => entry.minute),
    [7, 9]
  );
  assert.equal(result.stages[0].machineMinutes.busy, 5);
  conservation(result);
});

test('downtime on separate machines remains independent', () => {
  const result = simulateFlow(
    data,
    input({
      horizonMinutes: 5,
      stages: [
        stage('a', {
          machines: 2,
          downtime: [
            { machine: 1, startMinute: 1, endMinute: 3 },
            { machine: 2, startMinute: 0, endMinute: 2 }
          ]
        })
      ]
    })
  );
  assert.equal(result.completed, 6);
  assert.equal(result.stages[0].machineMinutes.down, 4);
  conservation(result);
});

test('rework consumes real capacity and never creates extra material', () => {
  const result = simulateFlow(
    data,
    input({
      horizonMinutes: 6,
      materialCount: 4,
      stages: [stage('a', { reworkEvery: 2, maxRework: 1 })]
    })
  );
  assert.equal(result.completed, 4);
  assert.equal(result.stages[0].cyclesCompleted, 6);
  assert.equal(result.stages[0].reworkPasses, 2);
  assert.deepEqual(
    result.completions.map((entry) => entry.minute),
    [1, 3, 4, 6]
  );
  conservation(result);
});

test('initial downstream WIP is not forced to repeat upstream operations', () => {
  const result = simulateFlow(
    data,
    input({
      horizonMinutes: 3,
      materialCount: 0,
      stages: [stage('a'), stage('b', { initialWip: 3, bufferCapacity: 3 })]
    })
  );
  assert.equal(result.completed, 3);
  assert.equal(result.stages[0].started, 0);
  assert.equal(result.stages[1].started, 3);
  conservation(result);
});

test('unfinished processing and unreleased stock stay in material balance', () => {
  const result = simulateFlow(
    data,
    input({
      horizonMinutes: 1,
      materialCount: 7,
      stages: [stage('a', { cycleMinutes: 2, bufferCapacity: 2 })]
    })
  );
  assert.equal(result.completed, 0);
  assert.equal(result.meanLeadMinutes, null);
  assert.equal(result.conservation.remainingWip, 3);
  assert.equal(result.conservation.unreleased, 4);
  conservation(result);
});

test('empty source yields starvation rather than invented output', () => {
  const result = simulateFlow(data, input({ materialCount: 0 }));
  assert.equal(result.completed, 0);
  assert.equal(result.stages[0].machineMinutes.starved, 10);
  conservation(result);
});

test('config rejects missing assumptions, stale-contract omissions and unsafe bounds', () => {
  assert.equal(flowSchema.safeParse(input({ assumptionsConfirmed: false })).success, false);
  assert.equal(flowSchema.safeParse(input({ expectedDatasetVersion: undefined })).success, false);
  assert.equal(flowSchema.safeParse(input({ materialCount: 2001 })).success, false);
  assert.equal(
    flowSchema.safeParse(input({ stages: [stage('a', { initialWip: 1 })] })).success,
    false
  );
  assert.equal(
    flowSchema.safeParse(input({ stages: [stage('a', { machines: 9 })] })).success,
    false
  );
  assert.equal(
    flowSchema.safeParse(input({ stages: [stage('a', { reworkEvery: 1, maxRework: 0 })] })).success,
    false
  );
  assert.equal(
    flowSchema.safeParse(
      input({ stages: [stage('a', { downtime: [{ machine: 2, startMinute: 0, endMinute: 5 }] })] })
    ).success,
    false
  );
  assert.equal(flowSchema.safeParse(input({ stages: [stage('a'), stage('a')] })).success, false);
  assert.equal(flowSchema.safeParse({ ...input(), injected: true }).success, false);
  assert.throws(() => simulateFlow(data, input({ stages: [stage('missing')] })), /неизвестный/);
});

test('busy finite model remains deterministic and conserves material with overlaps and rework', () => {
  const config = input({
    horizonMinutes: 480,
    materialCount: 300,
    stages: [
      stage('a', {
        machines: 3,
        cycleMinutes: 1.25,
        bufferCapacity: 7,
        initialWip: 4,
        reworkEvery: 7,
        maxRework: 2,
        downtime: [{ machine: 2, startMinute: 17.5, endMinute: 103 }]
      }),
      stage('b', {
        machines: 2,
        cycleMinutes: 2.3,
        bufferCapacity: 5,
        initialWip: 2,
        reworkEvery: 9,
        maxRework: 1
      })
    ]
  });
  const result = simulateFlow(data, config);
  assert.deepEqual(result, simulateFlow(data, config));
  assert.equal(result.completed, 306);
  assert.equal(result.timeline.length, 61);
  conservation(result);
});

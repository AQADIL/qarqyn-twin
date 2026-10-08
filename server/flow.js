import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const bounded = (min, max) => z.number().finite().min(min).max(max);
const stageSchema = z
  .object({
    stageId: id,
    machines: bounded(1, 8).int(),
    cycleMinutes: bounded(0.1, 240),
    bufferCapacity: bounded(0, 200).int(),
    initialWip: bounded(0, 200).int(),
    reworkEvery: bounded(0, 2000).int(),
    maxRework: bounded(0, 3).int(),
    downtime: z
      .array(
        z
          .object({
            machine: bounded(1, 8).int(),
            startMinute: bounded(0, 1440),
            endMinute: bounded(0, 1440)
          })
          .strict()
      )
      .max(50)
  })
  .strict();

export const flowSchema = z
  .object({
    datasetId: id,
    expectedDatasetVersion: bounded(1, 1000000000).int(),
    horizonMinutes: bounded(1, 1440),
    materialCount: bounded(0, 2000).int(),
    assumptionsConfirmed: z.literal(true),
    stages: z.array(stageSchema).min(1).max(12)
  })
  .strict()
  .superRefine((input, ctx) => {
    const issue = (path, message) => ctx.addIssue({ code: 'custom', path, message });
    if (new Set(input.stages.map((stage) => stage.stageId)).size !== input.stages.length)
      issue(['stages'], 'Участки в маршруте не должны повторяться.');
    if (input.materialCount + input.stages.reduce((sum, stage) => sum + stage.initialWip, 0) > 2000)
      issue(
        ['materialCount'],
        'Не более 2000 деталей, включая начальное незавершённое производство.'
      );
    input.stages.forEach((stage, index) => {
      if (stage.initialWip > stage.bufferCapacity)
        issue(
          ['stages', index, 'initialWip'],
          'Начальный запас не может превышать вместимость буфера.'
        );
      if ((stage.reworkEvery === 0) !== (stage.maxRework === 0))
        issue(
          ['stages', index, 'maxRework'],
          'Для передела задайте и частоту, и число дополнительных проходов. Для отключения укажите оба нуля.'
        );
      stage.downtime.forEach((stop, stopIndex) => {
        if (
          stop.machine > stage.machines ||
          stop.endMinute <= stop.startMinute ||
          stop.endMinute > input.horizonMinutes
        )
          issue(
            ['stages', index, 'downtime', stopIndex],
            'Проверьте номер станка и интервал простоя в пределах расчётного периода.'
          );
      });
    });
  });

function intervalsForMachine(records, machine) {
  const merged = [];
  for (const record of records
    .filter((entry) => entry.machine === machine)
    .sort((a, b) => a.startMinute - b.startMinute)) {
    const last = merged.at(-1);
    if (last && record.startMinute <= last.endMinute)
      last.endMinute = Math.max(last.endMinute, record.endMinute);
    else merged.push({ startMinute: record.startMinute, endMinute: record.endMinute });
  }
  return merged;
}

const round = (value) => Math.round(value * 1000000) / 1000000;
const epsilon = 1e-8;

// Serial route, FIFO finite input buffers, parallel identical machines and blocking after service.
// Stops pause remaining service; overlap is unioned per machine. Every Nth admission repeats
// the same operation maxRework times, then succeeds. This is a deterministic scenario, not a fit.
export function simulateFlow(data, rawInput) {
  const input = flowSchema.parse(rawInput);
  const available = new Map(data.stages.map((stage) => [stage.id, stage]));
  for (const stage of input.stages) {
    if (!available.has(stage.stageId) || available.get(stage.stageId).kind === 'buffer') {
      const error = new Error('Маршрут содержит неизвестный или складской участок.');
      error.status = 400;
      throw error;
    }
  }
  let nextPartId = 0;
  const part = () => ({ id: ++nextPartId, enteredAt: 0 });
  const stages = input.stages.map((config) => ({
    config,
    name: available.get(config.stageId).name,
    queue: Array.from({ length: config.initialWip }, part),
    started: 0,
    transferred: 0,
    reworkPasses: 0,
    cyclesCompleted: 0,
    queueArea: 0,
    queuePeak: config.initialWip,
    machines: Array.from({ length: config.machines }, (_, index) => ({
      number: index + 1,
      stops: intervalsForMachine(config.downtime, index + 1),
      stopIndex: 0,
      part: null,
      remaining: 0,
      repeatsLeft: 0,
      pass: 0,
      ready: false,
      minutes: { busy: 0, blocked: 0, starved: 0, down: 0 }
    }))
  }));
  const totalInitial =
    input.materialCount + stages.reduce((sum, stage) => sum + stage.queue.length, 0);
  let unreleased = input.materialCount;
  let completed = 0;
  let totalLeadMinutes = 0;
  let firstCompletion = null;
  let time = 0;
  let events = 0;
  let sample = 0;
  const timeline = [];
  const completions = [];
  const isDown = (machine) => {
    while (machine.stops[machine.stopIndex]?.endMinute <= time + epsilon) machine.stopIndex++;
    const stop = machine.stops[machine.stopIndex];
    return Boolean(stop && stop.startMinute <= time + epsilon && stop.endMinute > time + epsilon);
  };
  const start = (stage, machine, item) => {
    stage.started++;
    machine.part = item;
    machine.remaining = stage.config.cycleMinutes;
    machine.ready = false;
    machine.pass = 0;
    machine.repeatsLeft =
      stage.config.reworkEvery && stage.started % stage.config.reworkEvery === 0
        ? stage.config.maxRework
        : 0;
  };
  const freeMachine = (stage) =>
    stage.machines.find((machine) => !machine.part && !isDown(machine));
  const accept = (stage, item, canStart) => {
    const free = canStart && !stage.queue.length && freeMachine(stage);
    if (free) start(stage, free, item);
    else if (stage.queue.length < stage.config.bufferCapacity) {
      stage.queue.push(item);
      stage.queuePeak = Math.max(stage.queuePeak, stage.queue.length);
    } else return false;
    return true;
  };
  const wip = () =>
    stages.reduce(
      (sum, stage) =>
        sum + stage.queue.length + stage.machines.filter((machine) => machine.part).length,
      0
    );
  while (true) {
    if (++events > 100000) {
      const error = new Error('Слишком много событий. Сократите число деталей или участков.');
      error.status = 422;
      throw error;
    }
    for (const stage of stages)
      for (const machine of stage.machines) {
        if (!machine.part || machine.ready || machine.remaining > epsilon) continue;
        stage.cyclesCompleted++;
        if (machine.pass > 0) stage.reworkPasses++;
        if (machine.repeatsLeft) {
          machine.repeatsLeft--;
          machine.pass++;
          machine.remaining = stage.config.cycleMinutes;
        } else machine.ready = true;
      }
    const canStart = time < input.horizonMinutes - epsilon;
    let changed;
    do {
      changed = false;
      for (let index = stages.length - 1; index >= 0; index--) {
        const stage = stages[index];
        for (const machine of stage.machines) {
          if (!machine.ready) continue;
          if (index === stages.length - 1) {
            completed++;
            firstCompletion ??= time;
            totalLeadMinutes += time - machine.part.enteredAt;
            completions.push({ minute: round(time), total: completed });
          } else if (!accept(stages[index + 1], machine.part, canStart)) continue;
          stage.transferred++;
          machine.part = null;
          machine.ready = false;
          changed = true;
        }
        let free;
        while (canStart && stage.queue.length && (free = freeMachine(stage))) {
          start(stage, free, stage.queue.shift());
          changed = true;
        }
      }
      while (canStart && unreleased > 0) {
        const item = { id: nextPartId + 1, enteredAt: time };
        if (!accept(stages[0], item, true)) break;
        nextPartId++;
        unreleased--;
        changed = true;
      }
    } while (changed);

    if (
      time + epsilon >= (sample / 60) * input.horizonMinutes ||
      time >= input.horizonMinutes - epsilon
    ) {
      timeline.push({
        minute: round(time),
        completed,
        unreleased,
        wip: wip(),
        stages: stages.map((stage) => ({
          stageId: stage.config.stageId,
          queued: stage.queue.length,
          inMachines: stage.machines.filter((machine) => machine.part).length,
          blocked: stage.machines.filter((machine) => machine.ready).length
        }))
      });
      sample++;
    }
    if (time >= input.horizonMinutes - epsilon) break;
    let nextTime = Math.min(input.horizonMinutes, (sample / 60) * input.horizonMinutes);
    for (const stage of stages)
      for (const machine of stage.machines) {
        const down = isDown(machine);
        const stop = machine.stops[machine.stopIndex];
        if (stop) nextTime = Math.min(nextTime, down ? stop.endMinute : stop.startMinute);
        if (machine.part && !machine.ready && !down)
          nextTime = Math.min(nextTime, time + machine.remaining);
      }
    const duration = nextTime - time;
    if (duration <= epsilon / 10) throw new Error('Не удалось продвинуть время модели.');
    for (const stage of stages) {
      stage.queueArea += stage.queue.length * duration;
      for (const machine of stage.machines) {
        const state = isDown(machine)
          ? 'down'
          : machine.ready
            ? 'blocked'
            : machine.part
              ? 'busy'
              : 'starved';
        machine.minutes[state] += duration;
        if (state === 'busy') machine.remaining = Math.max(0, machine.remaining - duration);
      }
    }
    time = nextTime;
  }
  const remainingWip = wip();
  return {
    model: 'deterministic-finite-buffer-v1',
    datasetId: input.datasetId,
    datasetVersion: input.expectedDatasetVersion,
    input,
    horizonMinutes: input.horizonMinutes,
    completed,
    firstCompletionMinute: firstCompletion === null ? null : round(firstCompletion),
    meanLeadMinutes: completed ? round(totalLeadMinutes / completed) : null,
    conservation: {
      totalInitial,
      completed,
      remainingWip,
      unreleased,
      difference: totalInitial - completed - remainingWip - unreleased
    },
    stages: stages.map((stage) => ({
      stageId: stage.config.stageId,
      name: stage.name,
      started: stage.started,
      transferred: stage.transferred,
      cyclesCompleted: stage.cyclesCompleted,
      reworkPasses: stage.reworkPasses,
      queuePeak: stage.queuePeak,
      averageQueue: round(stage.queueArea / input.horizonMinutes),
      remainingQueued: stage.queue.length,
      remainingInMachines: stage.machines.filter((machine) => machine.part).length,
      machineMinutes: Object.fromEntries(
        ['busy', 'blocked', 'starved', 'down'].map((key) => [
          key,
          round(stage.machines.reduce((sum, machine) => sum + machine.minutes[key], 0))
        ])
      ),
      machines: stage.machines.map((machine) => ({
        number: machine.number,
        downtime: machine.stops,
        minutes: Object.fromEntries(
          Object.entries(machine.minutes).map(([key, value]) => [key, round(value)])
        )
      }))
    })),
    timeline,
    completions,
    assumptions: [
      'Маршрут — последовательность выбранных участков; станки одного участка работают параллельно и имеют одинаковый цикл.',
      'Буфер находится перед участком. После обработки деталь блокирует станок до освобождения следующего буфера или станка.',
      'Начальный НЗП находится в очереди и ещё не начал цикл. На входе конечное число деталей, выход не ограничен.',
      'Среднее время завершённых деталей считается только внутри модели. Для начального НЗП предыдущая длительность ожидания неизвестна и не учитывается.',
      'Простои вводятся интервалами с начала периода. Пересечения объединяются по каждому станку, незавершённая обработка продолжается после простоя.',
      'Каждая N-я деталь на участке проходит указанное число повторных циклов, затем принимается. Списание брака, смена маршрута и наладка не моделируются.',
      'Результат проверяет введённый сценарий. Данные о буферах, станках, времени событий и переделе требуют сверки с реальной линией.'
    ]
  };
}

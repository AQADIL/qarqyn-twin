import { datasetSchema, targetPlanSchema, parse, fail } from './schema.js';

export const sum = (rows, key) => rows.reduce((n, r) => n + r[key], 0);
export const round = (n, digits = 2) => Number(n.toFixed(digits));

export function wilson(defects, count) {
  if (!count) return null;
  const z = 1.96,
    p = defects / count,
    den = 1 + (z * z) / count;
  const center = (p + (z * z) / (2 * count)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / count + (z * z) / (4 * count * count))) / den;
  return [Math.max(0, center - half), Math.min(1, center + half)].map((x) => round(x * 100, 3));
}

export function recoveryLimits(data, stages = analyze(data).stages) {
  return stages
    .filter((stage) => stage.kind === 'production')
    .map((stage) => {
      const excluded = data.downtime.filter(
        (row) =>
          row.stageId === stage.id &&
          row.reason.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU') === 'плановое то'
      );
      const observedMinutes = stage.observations ? stage.downtimeMinutes / stage.observations : 0;
      const excludedPlannedMinutes = stage.observations
        ? sum(excluded, 'minutes') / stage.observations
        : 0;
      return {
        stageId: stage.id,
        observedMinutes,
        maxMinutes: Math.min(480, Math.max(0, observedMinutes - excludedPlannedMinutes)),
        excludedPlannedMinutes,
        excludedSourceIds: excluded.map((row) => row.id)
      };
    });
}

export function analyze(data, date = null) {
  const filter = (rows) => (date ? rows.filter((r) => r.date === date) : rows);
  const production = filter(data.production),
    quality = filter(data.quality),
    downtime = filter(data.downtime);
  const stages = data.stages.map((stage) => {
    const p = production.filter((r) => r.stageId === stage.id),
      q = quality.filter((r) => r.stageId === stage.id),
      d = downtime.filter((r) => r.stageId === stage.id);
    const actual = sum(p, 'actual'),
      plan = sum(p, 'plan'),
      runtimeHours = sum(p, 'runtimeHours');
    const produced = sum(q, 'produced'),
      defects = sum(q, 'defects');
    return {
      ...stage,
      observations: p.length,
      actual,
      plan,
      runtimeHours: round(runtimeHours),
      downtimeMinutes: sum(d, 'minutes'),
      defects,
      inspected: produced,
      defectPct: produced ? round((100 * defects) / produced) : null,
      qualityInterval: wilson(defects, produced),
      planPct: plan ? round((100 * actual) / plan) : null,
      utilizationPct: p.length ? round(sum(p, 'utilizationPct') / p.length) : null,
      rate: runtimeHours ? actual / runtimeHours : null,
      sourceIds: [...p, ...q, ...d].map((r) => r.id)
    };
  });
  const last = stages.filter((s) => s.kind === 'production').at(-1);
  const findings = [];
  for (const s of stages) {
    if (s.defectPct !== null && s.defectPct > data.targets.maxDefectPct)
      findings.push({
        id: `quality-${s.id}`,
        kind: 'quality',
        severity: 'high',
        stageId: s.id,
        title: `${s.name}: брак выше порога`,
        detail: `${s.defects} из ${s.inspected} операций (${s.defectPct}%) при пороге ${data.targets.maxDefectPct}%.`,
        action: 'Проверить причины дефектов и сравнить сценарий снижения брака.',
        sourceIds: quality.filter((q) => q.stageId === s.id).map((q) => q.id)
      });
    if (s.actual < s.plan)
      findings.push({
        id: `plan-${s.id}`,
        kind: 'production',
        severity: 'normal',
        stageId: s.id,
        title: `${s.name}: отставание от плана`,
        detail: `Выполнено ${s.actual} из ${s.plan}. Разница ${s.plan - s.actual}.`,
        action: 'Сопоставить загрузку, простои и доступность входящих деталей.',
        sourceIds: production.filter((q) => q.stageId === s.id).map((q) => q.id)
      });
  }
  const monthlyPlanned = data.plans.length ? sum(data.plans, 'quantity') : null;
  if (monthlyPlanned !== null && monthlyPlanned !== data.targets.monthlyOutput)
    findings.push({
      id: 'monthly-gap',
      kind: 'data',
      severity: 'high',
      stageId: null,
      title: 'Производственный план не согласован',
      detail: `План по моделям ${monthlyPlanned}, целевой выпуск ${data.targets.monthlyOutput}. Разница ${data.targets.monthlyOutput - monthlyPlanned}.`,
      action: 'Уточнить отсутствующие модели или скорректировать целевой план.',
      sourceIds: data.plans.map((r) => r.id)
    });
  const equipmentDays = new Map();
  for (const d of downtime) {
    const key = `${d.date}:${d.stageId}:${d.equipment}`;
    const v = equipmentDays.get(key) || {
      minutes: 0,
      ids: [],
      equipment: d.equipment,
      date: d.date,
      stageId: d.stageId
    };
    v.minutes += d.minutes;
    v.ids.push(d.id);
    equipmentDays.set(key, v);
  }
  for (const v of equipmentDays.values())
    if (v.minutes > data.targets.maxDowntimeMinutes)
      findings.push({
        id: `downtime-${v.date}-${v.stageId}-${v.equipment}`,
        kind: 'downtime',
        severity: 'high',
        stageId: v.stageId,
        title: `${v.equipment}: превышен порог простоя`,
        detail: `${v.minutes} мин за ${v.date}; порог ${data.targets.maxDowntimeMinutes} мин.`,
        action: 'Уточнить критичность оборудования и причину суммарного простоя.',
        sourceIds: v.ids
      });
  const warnings = [
    'Выпуск разных участков не суммируется: один автомобиль проходит несколько операций.',
    'Простои суммируются по оборудованию. Это не длительность остановки всего завода.',
    'Не указан идеальный цикл оборудования. OEE не рассчитывается.',
    `В целевом режиме указано ${data.targets.shiftsPerDay} смен по ${data.targets.hoursPerShift} ч. Длительность периода одной исходной строки требует уточнения и задаётся отдельно в сценарии.`,
    'Участки без наблюдений не получают вымышленные показатели. Склад, контроль и готовая продукция показаны как схема процесса.'
  ];
  return {
    dates: [...new Set(data.production.map((r) => r.date))].sort(),
    date,
    stages,
    recoveryLimits: recoveryLimits(data, stages),
    findings,
    warnings,
    totals: {
      output: last?.observations ? last.actual : null,
      outputPlan: last?.observations ? last.plan : null,
      outputStage: last?.name ?? null,
      defects: sum(quality, 'defects'),
      downtimeMinutes: sum(downtime, 'minutes'),
      monthlyPlanned,
      monthlyTarget: data.targets.monthlyOutput,
      planGap: monthlyPlanned === null ? null : data.targets.monthlyOutput - monthlyPlanned,
      rows: production.length + quality.length + downtime.length + data.plans.length
    },
    oee: null,
    source: data.source,
    targets: data.targets,
    records: { production, quality, downtime, plans: data.plans }
  };
}

function throughput(stages, hours, interventions, qualityBound, observationHours = 8) {
  let flow = Infinity;
  const steps = [];
  for (const s of stages) {
    const change = interventions.find((x) => x.stageId === s.id);
    const recoveredPerObservation = change?.recoverMinutes || 0;
    const downtimePerObservation = s.downtimeMinutes / s.observations;
    const uptime = Math.max(
      0,
      hours -
        (Math.max(0, downtimePerObservation - recoveredPerObservation) * hours) /
          observationHours /
          60
    );
    const capacity = s.rate * uptime;
    const defectPct =
      change?.defectPct ??
      (qualityBound === 'low'
        ? s.qualityInterval?.[1]
        : qualityBound === 'high'
          ? s.qualityInterval?.[0]
          : s.defectPct) ??
      0;
    const incoming = Math.min(flow, capacity);
    flow = incoming * (1 - defectPct / 100);
    steps.push({
      stageId: s.id,
      name: s.name,
      capacity: round(capacity),
      input: round(incoming),
      goodOutput: round(flow),
      loss: round(incoming - flow),
      defectPct: round(defectPct),
      uptimeHours: round(uptime),
      recoveredMinutes: recoveredPerObservation
    });
  }
  return { output: Number.isFinite(flow) ? round(flow) : 0, steps };
}

export function simulate(data, input) {
  const a = analyze(data),
    stages = a.stages.filter((s) => s.kind === 'production');
  if (!stages.length || stages.some((s) => s.rate === null || s.defectPct === null))
    fail(
      422,
      'Для расчёта потока нужны наблюдения выпуска, времени работы и качества каждого производственного участка. Отсутствующее качество нельзя считать нулевым браком.'
    );
  const limits = recoveryLimits(data, stages);
  for (const change of input.interventions) {
    const stage = stages.find((s) => s.id === change.stageId);
    if (!stage) {
      const e = new Error('Сценарий ссылается на неизвестный производственный участок');
      e.status = 422;
      throw e;
    }
    if (
      change.recoverMinutes >
      limits.find((limit) => limit.stageId === stage.id).maxMinutes + 1e-9
    ) {
      const e = new Error(
        'Восстановленное время превышает доступный простой после исключения планового ТО'
      );
      e.status = 422;
      throw e;
    }
  }
  const calc = (changes, bound) =>
    throughput(stages, input.hours, changes, bound, input.observationHours ?? 8);
  const baseline = calc([]),
    scenario = calc(input.interventions);
  const low = calc(input.interventions, 'low').output,
    high = calc(input.interventions, 'high').output;
  const sensitivity = stages
    .map((s) => {
      const alt = input.interventions.filter((x) => x.stageId !== s.id);
      alt.push({
        stageId: s.id,
        recoverMinutes: limits.find((limit) => limit.stageId === s.id).maxMinutes,
        defectPct: 0
      });
      return { stageId: s.id, name: s.name, headroom: round(calc(alt).output - scenario.output) };
    })
    .sort((a, b) => b.headroom - a.headroom);
  return {
    model: 'Последовательная модель потока v2',
    baseline,
    scenario,
    delta: round(scenario.output - baseline.output),
    sensitivity,
    range: [low, high],
    recoveryLimits: limits,
    assumptions: [
      `Расчётный период одной исходной строки принят равным ${input.observationHours ?? 8} часам. Это допущение, а не установленный режим завода.`,
      'Скорость участка = суммарный выпуск / суммарное время работы. Исторические простои нормируются на число наблюдений.',
      'Сумма простоев отдельных машин условно используется как потеря времени участка. Одновременность остановок и фактический простой всей линии неизвестны; возможен двойной учёт времени. Эффект восстановления требует проверки инженером.',
      'Явно указанное «Плановое ТО» остаётся в базовом простое и исключается из доступного восстановления. Устранимость других причин должен подтвердить инженер.',
      'Годный поток = min(входящий поток, производственная ёмкость) × (1 − доля брака). Начальные запасы, передел и транспортные задержки не учитываются.',
      'Это стационарная сценарная модель без разгона линии, а не прогноз отказов или обещание реального прироста.',
      'Диапазон отражает чувствительность к 95% интервалам Уилсона для исторической доли брака. Это не доверительный интервал выпуска. Заданный целевой брак считается фиксированным.',
      'Расчёт доступен только при наличии наблюдений качества каждого производственного участка. Полноту и сопоставимость периодов должен подтвердить инженер.'
    ],
    evidence: stages.map((s) => ({
      stageId: s.id,
      rate: round(s.rate, 4),
      downtimePerObservation: round(s.downtimeMinutes / s.observations, 4),
      qualityInterval: s.qualityInterval,
      sourceIds: s.sourceIds
    }))
  };
}

export function optimize(data, hours, observationHours = 8) {
  const stages = analyze(data).stages.filter((s) => s.kind === 'production' && s.rate !== null);
  const limits = recoveryLimits(data, stages);
  return stages
    .map((s) => {
      const input = {
        datasetId: '',
        hours,
        observationHours,
        interventions: [
          {
            stageId: s.id,
            recoverMinutes: limits.find((limit) => limit.stageId === s.id).maxMinutes,
            defectPct: Math.min(s.defectPct ?? 0, data.targets.maxDefectPct)
          }
        ]
      };
      const result = simulate(data, input);
      return {
        name: `${s.name}: сократить потери`,
        stageId: s.id,
        input,
        delta: result.delta,
        output: result.scenario.output,
        detail:
          'Условно восстановить доступный простой после исключения планового ТО и довести брак до порога. Допустимость восстановления и влияние на линию должен проверить инженер.'
      };
    })
    .sort((a, b) => b.delta - a.delta);
}

export function planTarget(data, request) {
  const input = parse(targetPlanSchema, request);
  parse(datasetSchema, data);
  const stages = analyze(data).stages.filter((s) => s.kind === 'production');
  if (
    !stages.length ||
    stages.some((s) => !s.observations || s.rate === null || s.defectPct === null)
  )
    fail(
      422,
      'Для обратного планирования нужны наблюдения выпуска, времени работы и качества каждого производственного участка.'
    );
  const periodMinutes = input.observationHours * 60;
  let downstreamYield = 1;
  const limits = recoveryLimits(data, stages);
  const constraints = stages.map((s) => {
    const limit = limits.find((item) => item.stageId === s.id);
    return {
      stageId: s.id,
      name: s.name,
      rate: s.rate,
      defectPct: s.defectPct,
      observedMinutes: limit.observedMinutes,
      availableMinutes: limit.maxMinutes,
      excludedPlannedMinutes: limit.excludedPlannedMinutes,
      sourceIds: s.sourceIds,
      excludedSourceIds: limit.excludedSourceIds
    };
  });
  for (let i = constraints.length - 1; i >= 0; i--) {
    downstreamYield *= 1 - constraints[i].defectPct / 100;
    constraints[i].downstreamYield = downstreamYield;
  }
  const stageOutputLimit = (stage, recovery) =>
    stage.rate *
    input.hours *
    Math.max(0, 1 - (stage.observedMinutes - recovery) / periodMinutes) *
    stage.downstreamYield;
  const baselineGoodOutput = Math.min(...constraints.map((s) => stageOutputLimit(s, 0)));
  const maxGoodOutput = Math.min(
    ...constraints.map((s) => stageOutputLimit(s, s.availableMinutes))
  );
  const simulationInput = {
    datasetId: input.datasetId,
    hours: input.hours,
    observationHours: input.observationHours,
    interventions: []
  };
  const baselineResult = simulate(data, simulationInput);
  const tolerance = 1e-9 * input.targetGoodOutput;
  const achievable = input.targetGoodOutput <= maxGoodOutput + tolerance;
  const alreadyMet = input.targetGoodOutput <= baselineGoodOutput + tolerance;
  const evidence = constraints.map((s) => ({
    ...s,
    baselineOutputLimit: stageOutputLimit(s, 0),
    maximumOutputLimit: stageOutputLimit(s, s.availableMinutes)
  }));
  const interventions =
    achievable && !alreadyMet
      ? constraints
          .map((s) => {
            // Final output is min(capacity_i * downstreamYield_i); each recovery has its own independent lower bound.
            const required =
              s.observedMinutes -
              periodMinutes +
              (input.targetGoodOutput * periodMinutes) / (s.rate * input.hours * s.downstreamYield);
            return {
              stageId: s.stageId,
              name: s.name,
              recoverMinutes: Math.min(s.availableMinutes, Math.max(0, required)),
              availableMinutes: s.availableMinutes,
              excludedPlannedMinutes: s.excludedPlannedMinutes,
              sourceIds: s.sourceIds
            };
          })
          .filter((s) => s.recoverMinutes > 0)
      : [];
  simulationInput.interventions = interventions.map((s) => ({
    stageId: s.stageId,
    recoverMinutes: s.recoverMinutes,
    defectPct: null
  }));
  return {
    model: 'Обратное планирование потока v1',
    objective:
      'Покомпонентный минимум восстановленных минут на исходный период при фиксированных скорости и доле брака.',
    targetGoodOutput: input.targetGoodOutput,
    achievable,
    reasonCode: !achievable ? 'beyond_capacity' : alreadyMet ? 'already_met' : 'achievable',
    reason: !achievable
      ? 'Цель недостижима при доступном восстановлении времени и неизменном качестве. Нужны другие меры или пересмотр цели.'
      : alreadyMet
        ? 'Базовый расчёт уже достигает цели. Восстанавливать время для неё не требуется.'
        : 'Найден минимальный набор восстановления времени в рамках последовательной модели. Реализуемость должен подтвердить инженер.',
    baseline: baselineResult.baseline,
    baselineGoodOutput,
    maxGoodOutput,
    shortfall: Math.max(0, input.targetGoodOutput - maxGoodOutput),
    totalRecoverMinutes: sum(interventions, 'recoverMinutes'),
    input: achievable ? simulationInput : null,
    result: achievable ? simulate(data, simulationInput) : null,
    interventions,
    evidence,
    assumptions: [
      'Минимум доказан только для этой последовательной модели: выпуск равен минимуму ёмкостей участков, умноженных на выход годных всех последующих операций. Каждый участок должен независимо обеспечить цель; снижение любой положительной найденной компоненты нарушит её.',
      'Время измеряется в минутах на один исходный период, а не суммарных минутах всех машин за горизонт. Скорость и историческая доля брака не изменяются.',
      'Строки с явно указанной причиной «Плановое ТО» исключены из доступного восстановления. Другие причины не имеют надёжной классификации плановости и считаются условно доступными только для расчёта; требуется инженерное подтверждение.',
      'На один участок допускается не более 480 минут восстановления на исходный период, как и в лаборатории сценариев. Дополнительные ограничения оборудования и стоимость работ не заданы.',
      'Это математический план для проверки, а не расписание работ или команда оборудованию. Плановое обслуживание не отменяется. Неопределённость качества и пересечение остановок могут сделать фактический результат иным.',
      ...baselineResult.assumptions
    ]
  };
}

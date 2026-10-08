import { z } from 'zod';
import { analyze, round, simulate } from './analytics.js';
import { classifyDowntime, modelInputIssues, selectModelData } from './model-input.js';
import { datasetSchema, dateSchema, fail, parse } from './schema.js';

const text = (max) => z.string().trim().max(max).default('');
const money = z
  .number()
  .finite()
  .min(0)
  .max(1e12)
  .refine((value) => value === 0 || value >= 0.01, 'Сумма должна быть нулём или не менее 0,01.')
  .refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.001,
    'Укажите сумму с точностью до двух знаков.'
  )
  .nullable()
  .default(null);
const actionSchema = z.strictObject({
  eventId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  title: text(180),
  owner: text(80),
  dueDate: dateSchema.nullable().default(null),
  mechanism: text(1200),
  evidence: text(1200),
  validationMethod: text(1200),
  expectedRecoveredMinutes: z.number().finite().positive().max(1440),
  confidencePct: z.number().finite().min(0).max(100).default(0),
  confirmed: z.boolean().default(false),
  oneOffCost: money,
  recurringCostPerPeriod: money
});

export const actionPlanSchema = z
  .strictObject({
    datasetId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    expectedDatasetVersion: z.number().int().positive(),
    date: dateSchema.optional(),
    hours: z.number().finite().min(1).max(744),
    observationHours: z.number().finite().min(1).max(24),
    status: z.enum(['draft', 'ready']).default('draft'),
    targetGoodOutput: z.number().finite().positive().max(1e6).nullable().default(null),
    actions: z.array(actionSchema).max(30).default([]),
    realizationPct: z.number().finite().min(0).max(100).default(100),
    periods: z.number().int().min(1).max(366).default(1),
    unitContribution: money,
    maxAdditionalSalesPerPeriod: z.number().finite().min(0).max(1e6).nullable().default(null),
    economicEvidence: text(1200)
  })
  .superRefine((input, ctx) => {
    const ids = new Set();
    input.actions.forEach((action, index) => {
      if (ids.has(action.eventId))
        ctx.addIssue({
          code: 'custom',
          path: ['actions', index, 'eventId'],
          message:
            'Один простой можно учитывать только в одном мероприятии. Объедините связанные работы.'
        });
      ids.add(action.eventId);
    });
  });

export function evaluateActionPlan(data, request) {
  data = parse(datasetSchema, data);
  const input = parse(actionPlanSchema, request);
  const scoped = selectModelData(data, input.date);
  const analysis = analyze(scoped);
  const modelBlockers = modelInputIssues(scoped, input.observationHours).map(
    (issue) => issue.detail
  );
  const candidates = data.downtime.map((event) => {
    const classification = classifyDowntime(event);
    const stage = analysis.stages.find((item) => item.id === event.stageId);
    const eligible =
      classification.kind === 'unplanned' && stage?.kind === 'production' && stage.observations > 0;
    return {
      ...event,
      stageName: stage?.name || event.stageId,
      classification: classification.kind,
      classificationBasis: classification.basis,
      eligible,
      exclusionReason: eligible
        ? null
        : classification.kind === 'planned'
          ? 'Плановое обслуживание защищено от сокращения.'
          : classification.kind === 'unknown'
            ? 'Сначала уточните классификацию остановки в исходных данных.'
            : 'Для этого участка нет производственной модели.',
      observations: stage?.observations ?? 0
    };
  });
  const blockers = [...modelBlockers];
  if (!input.actions.length)
    blockers.push('Добавьте хотя бы одно мероприятие по зарегистрированной остановке.');
  const actions = input.actions.map((action, index) => {
    const event = candidates.find((item) => item.id === action.eventId);
    if (!event || (input.date && event.date !== input.date))
      fail(422, `Остановка ${action.eventId} не найдена в выбранном периоде.`);
    if (!event.eligible) fail(422, `${action.eventId}: ${event.exclusionReason}`);
    if (action.expectedRecoveredMinutes > event.minutes + 1e-9)
      fail(
        422,
        `${action.eventId}: восстановление превышает зарегистрированные ${event.minutes} минут.`
      );
    const required = {
      title: 'название работы',
      owner: 'ответственного',
      dueDate: 'срок',
      mechanism: 'объяснение, как работа устраняет причину',
      evidence: 'подтверждение оценки минут',
      validationMethod: 'способ измерить результат после выполнения'
    };
    for (const [field, label] of Object.entries(required)) {
      if (!action[field]) blockers.push(`Мероприятие ${index + 1}: укажите ${label}.`);
    }
    if (!action.confirmed)
      blockers.push(`Мероприятие ${index + 1}: инженер не подтвердил выполнимость.`);
    if (action.confidencePct === 0)
      blockers.push(`Мероприятие ${index + 1}: оцените уверенность инженера.`);
    if (action.oneOffCost === null || action.recurringCostPerPeriod === null)
      blockers.push(
        `Мероприятие ${index + 1}: уточните разовые и повторяющиеся расходы; отсутствие затрат укажите нулём.`
      );
    return {
      ...action,
      stageId: event.stageId,
      stageName: event.stageName,
      equipment: event.equipment,
      reason: event.reason,
      eventMinutes: event.minutes,
      eventDate: event.date,
      sourceIds: [event.id],
      observations: event.observations,
      normalizedRecoveredMinutes: action.expectedRecoveredMinutes / event.observations
    };
  });
  if (input.status === 'ready' && blockers.length) fail(422, blockers.slice(0, 5).join(' '));
  const byStage = new Map();
  for (const action of actions)
    byStage.set(
      action.stageId,
      (byStage.get(action.stageId) || 0) + action.normalizedRecoveredMinutes
    );
  const simulationInput = {
    datasetId: input.datasetId,
    hours: input.hours,
    observationHours: input.observationHours,
    ...(input.date ? { date: input.date } : {}),
    interventions: [...byStage].map(([stageId, recoverMinutes]) => ({
      stageId,
      recoverMinutes,
      defectPct: null
    }))
  };
  const planned = modelBlockers.length ? null : simulate(data, simulationInput);
  const calculate = (pct) =>
    !planned || pct === 100
      ? planned
      : simulate(data, {
          ...simulationInput,
          interventions: simulationInput.interventions.map((item) => ({
            ...item,
            recoverMinutes: (item.recoverMinutes * pct) / 100
          }))
        });
  const partial = calculate(input.realizationPct);
  const oneOffCost = actions.reduce((sum, action) => sum + (action.oneOffCost ?? 0), 0);
  const recurringCostPerPeriod = actions.reduce(
    (sum, action) => sum + (action.recurringCostPerPeriod ?? 0),
    0
  );
  const unknownCostCount = actions.filter(
    (action) => action.oneOffCost === null || action.recurringCostPerPeriod === null
  ).length;
  const knownTotalCost = oneOffCost + recurringCostPerPeriod * input.periods;
  const missingEconomicInputs = [];
  if (input.unitContribution === null)
    missingEconomicInputs.push('Маржинальный доход на дополнительную проданную машину');
  if (input.maxAdditionalSalesPerPeriod === null)
    missingEconomicInputs.push('Подтверждённый дополнительный спрос за период');
  if (!input.economicEvidence) missingEconomicInputs.push('Источник маржи и спроса');
  if (unknownCostCount) missingEconomicInputs.push('Затраты каждого мероприятия');
  if (!planned) missingEconomicInputs.push('Сопоставимые исходные данные для расчёта выпуска');
  const economicsAt = (result) => {
    if (!result)
      return {
        additionalUnits: null,
        soldUnits: null,
        unsoldUnits: null,
        grossContribution: null,
        netContribution: null
      };
    const additionalUnits =
      Math.max(0, result.scenario.rawOutput - planned.baseline.rawOutput) * input.periods;
    const soldUnits =
      input.maxAdditionalSalesPerPeriod === null
        ? null
        : Math.min(additionalUnits, input.maxAdditionalSalesPerPeriod * input.periods);
    const complete = !missingEconomicInputs.length;
    const contribution = complete ? soldUnits * input.unitContribution : null;
    return {
      additionalUnits: round(additionalUnits, 4),
      soldUnits: soldUnits === null ? null : round(soldUnits, 4),
      unsoldUnits: soldUnits === null ? null : round(additionalUnits - soldUnits, 4),
      grossContribution: contribution === null ? null : round(contribution),
      netContribution: contribution === null ? null : round(contribution - knownTotalCost)
    };
  };
  const sensitivity = planned
    ? [...new Set([0, 50, input.realizationPct, 100])]
        .sort((a, b) => a - b)
        .map((pct) => {
          const result = calculate(pct);
          return { realizationPct: pct, output: result.scenario.output, ...economicsAt(result) };
        })
    : [];
  return {
    modelVersion: 'Engineering action plan v1',
    input,
    readiness: { status: blockers.length ? 'draft' : 'ready', blockers },
    modelReadiness: {
      status: planned ? 'available' : 'unavailable',
      blockers: modelBlockers
    },
    actions,
    candidates,
    baselineOutput: planned?.baseline.output ?? null,
    plannedOutput: planned?.scenario.output ?? null,
    partialOutput: partial?.scenario.output ?? null,
    targetGoodOutput: input.targetGoodOutput,
    targetGap:
      input.targetGoodOutput === null || !partial
        ? null
        : round(Math.max(0, input.targetGoodOutput - partial.scenario.rawOutput), 4),
    targetMet:
      input.targetGoodOutput === null || !partial
        ? null
        : partial.scenario.rawOutput + 1e-9 >= input.targetGoodOutput,
    realizationPct: input.realizationPct,
    recoveredEventMinutes: round(
      actions.reduce((sum, action) => sum + action.expectedRecoveredMinutes, 0),
      4
    ),
    recoveredMinutesPerObservation: round(
      [...byStage.values()].reduce((sum, value) => sum + value, 0),
      4
    ),
    simulationInput,
    sensitivity,
    economics: {
      status: missingEconomicInputs.length ? 'missing_inputs' : 'conditional_estimate',
      unitContribution: input.unitContribution,
      maxAdditionalSalesPerPeriod: input.maxAdditionalSalesPerPeriod,
      evidence: input.economicEvidence,
      periods: input.periods,
      oneOffCost: round(oneOffCost),
      recurringCostPerPeriod: round(recurringCostPerPeriod),
      knownTotalCost: round(knownTotalCost),
      unknownCostCount,
      missingInputs: missingEconomicInputs,
      ...economicsAt(partial)
    },
    sourceIds: [
      ...new Set([
        ...actions.flatMap((action) => action.sourceIds),
        ...analysis.stages.flatMap((stage) => stage.sourceIds)
      ])
    ],
    assumptions: [
      'Работы, ответственных, расходы и подтверждения вводит инженер. Система не назначает ремонт по одной строке журнала.',
      'Минуты относятся к конкретному зарегистрированному событию. Для модели они делятся на число исходных наблюдений участка.',
      'Одна остановка учитывается один раз. Пересечение разных остановок без временных отметок не доказано; проверьте его перед выполнением.',
      'Процент выполнения — проверяемое условие сценария. Уверенность инженера не является вероятностью успеха или измеренной точностью модели.',
      'Подтверждённый план означает заполненную инженерную проверку. Фактический эффект устанавливается сравнением периодов до и после.',
      'Повторение эффекта и расходов предполагает сопоставимые смены. Выручка учитывается только в пределах введённого дополнительного спроса.',
      ...(planned?.assumptions ?? [
        'Расчёт выпуска и денежного эффекта недоступен до восстановления исходных данных. Сохраняются только введённые работы, расходы и их источники; передача в работу заблокирована.'
      ])
    ]
  };
}

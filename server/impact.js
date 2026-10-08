import { z } from 'zod';
import { planTarget, round } from './analytics.js';
import { parse, targetPlanSchema } from './schema.js';

const moneyValue = z
  .number()
  .finite()
  .min(0)
  .max(1e12)
  .refine((value) => value === 0 || value >= 0.01, 'Сумма должна быть нулём или не менее 0,01.')
  .refine(
    (value) => Math.abs(Math.round(value * 100) - value * 100) < 0.001,
    'Укажите сумму с точностью до двух знаков.'
  );
const money = moneyValue.nullable().default(null);
const finiteCeiling = (value) => (Number.isFinite(value) ? Math.ceil(value) : null);
export const impactSchema = targetPlanSchema
  .extend({
    expectedDatasetVersion: z.number().int().positive(),
    periods: z.number().int().min(1).max(366).default(1),
    realizationPct: z.number().min(0).max(100).default(100),
    unitContribution: money,
    implementationCost: money,
    recurringCostPerPeriod: moneyValue.default(0),
    maxAdditionalSalesPerPeriod: z.number().finite().min(0).max(1000000).nullable().default(null)
  })
  .strict();

export function evaluateImpact(data, request) {
  const input = parse(impactSchema, request);
  const plan = planTarget(data, {
    datasetId: input.datasetId,
    hours: input.hours,
    observationHours: input.observationHours,
    targetGoodOutput: input.targetGoodOutput,
    ...(input.date ? { date: input.date } : {})
  });
  const outputAt = (realizationPct) =>
    Math.min(
      ...plan.evidence.map((stage) => {
        const recovery = plan.interventions.find((row) => row.stageId === stage.stageId);
        const minutes = ((recovery?.recoverMinutes ?? 0) * realizationPct) / 100;
        return (
          stage.rate *
          input.hours *
          Math.max(0, 1 - (stage.observedMinutes - minutes) / (input.observationHours * 60)) *
          stage.downstreamYield
        );
      })
    );
  const baseline = plan.baselineGoodOutput;
  const planned = outputAt(100);
  const realized = outputAt(input.realizationPct);
  const gain = Math.max(0, realized - baseline);
  const totalGain = gain * input.periods;
  const soldPerPeriod = Math.min(gain, input.maxAdditionalSalesPerPeriod ?? gain);
  const soldTotal = soldPerPeriod * input.periods;
  const recurringCost = input.recurringCostPerPeriod * input.periods;
  const suppliedEconomics = input.unitContribution !== null && input.implementationCost !== null;
  const economicGain =
    suppliedEconomics && plan.achievable ? soldTotal * input.unitContribution : null;
  const net =
    economicGain === null ? null : economicGain - input.implementationCost - recurringCost;
  const contributionPerPeriod =
    input.unitContribution === null
      ? null
      : soldPerPeriod * input.unitContribution - input.recurringCostPerPeriod;
  const economics = {
    unitContribution: input.unitContribution,
    implementationCost: input.implementationCost,
    recurringCostPerPeriod: input.recurringCostPerPeriod,
    recurringCost: round(recurringCost),
    maxAdditionalSalesPerPeriod: input.maxAdditionalSalesPerPeriod,
    soldAdditionalUnits: round(soldTotal, 4),
    unsoldAdditionalUnits: round(totalGain - soldTotal, 4),
    currency: 'KZT',
    grossContribution: economicGain === null ? null : round(economicGain),
    netContribution: net === null ? null : round(net),
    breakEvenUnits:
      !suppliedEconomics || !plan.achievable
        ? null
        : input.implementationCost === 0 && recurringCost === 0
          ? 0
          : input.unitContribution > 0
            ? round((input.implementationCost + recurringCost) / input.unitContribution, 4)
            : null,
    breakEvenPeriods:
      !suppliedEconomics || !plan.achievable
        ? null
        : input.implementationCost === 0 && contributionPerPeriod >= 0
          ? 0
          : contributionPerPeriod > 0
            ? finiteCeiling(input.implementationCost / contributionPerPeriod)
            : null,
    roiPct:
      net !== null && input.implementationCost + recurringCost > 0
        ? round((net / (input.implementationCost + recurringCost)) * 100)
        : null,
    status: !plan.achievable
      ? 'unattainable'
      : !suppliedEconomics
        ? 'missing_inputs'
        : gain <= 1e-9
          ? 'no_gain'
          : Math.abs(net) < 0.005
            ? 'break_even'
            : net > 0
              ? 'positive'
              : 'negative'
  };
  const bottleneck = plan.evidence.reduce(
    (lowest, stage) =>
      !lowest || stage.baselineOutputLimit < lowest.baselineOutputLimit ? stage : lowest,
    null
  );
  return {
    datasetId: input.datasetId,
    modelVersion: 'impact-v2',
    baselineOutput: round(baseline, 4),
    targetOutput: input.targetGoodOutput,
    achievable: plan.achievable,
    reason: plan.reason,
    maxOutput: round(plan.maxGoodOutput, 4),
    plannedOutput: round(planned, 4),
    realizedOutput: round(realized, 4),
    plannedGain: round(Math.max(0, planned - baseline), 4),
    realizedGain: round(gain, 4),
    totalGain: round(totalGain, 4),
    realizationPct: input.realizationPct,
    periods: input.periods,
    hours: input.hours,
    observationHours: input.observationHours,
    simulationInput: plan.input,
    interventions: plan.interventions.map((stage) => ({
      stageId: stage.stageId,
      stageName: stage.name,
      recoverMinutes: round(stage.recoverMinutes, 4),
      realizedRecoverMinutes: round((stage.recoverMinutes * input.realizationPct) / 100, 4),
      protectedMaintenanceMinutes: round(stage.excludedPlannedMinutes, 4),
      sourceIds: stage.sourceIds
    })),
    economics,
    sensitivity: [0, 25, 50, 75, 100].map((realizationPct) => {
      const output = outputAt(realizationPct);
      const delta = Math.max(0, output - baseline);
      return {
        realizationPct,
        output: round(output, 4),
        gain: round(delta, 4),
        totalGain: round(delta * input.periods, 4),
        netContribution:
          !suppliedEconomics || !plan.achievable
            ? null
            : round(
                Math.min(delta, input.maxAdditionalSalesPerPeriod ?? delta) *
                  input.periods *
                  input.unitContribution -
                  input.implementationCost -
                  recurringCost
              )
      };
    }),
    bottleneck: bottleneck ? { stageId: bottleneck.stageId, name: bottleneck.name } : null,
    assumptions: [
      'Доля реализации — выбранная пользователем часть восстановленных минут. Это стресс-сценарий, а не вероятность успеха.',
      'Дополнительный выпуск пересчитывается по ограничениям всей цепочки. Эффект не масштабируется простым умножением готового результата.',
      'Вклад одной проданной дополнительной годной единицы учитывает переменные затраты. Отдельно учитываются разовые затраты и регулярные затраты на период. Налоги и дисконтирование не моделируются.',
      input.maxAdditionalSalesPerPeriod === null
        ? 'Предел дополнительных продаж не задан. Денежный результат условно предполагает продажу всего дополнительного выпуска; подтвердите спрос.'
        : `Денежный результат ограничен дополнительными продажами не более ${input.maxAdditionalSalesPerPeriod} единиц за период; непроданный выпуск не приносит доход.`,
      'Повторение одинакового эффекта предполагает одинаковую длительность, загрузку, качество и реализуемый спрос во всех выбранных периодах.',
      'Денежные значения вводит пользователь. Они не взяты из данных Allur. Расчётный эффект необходимо проверить на пилоте.',
      ...plan.assumptions
    ],
    sourceIds: [...new Set(plan.evidence.flatMap((stage) => stage.sourceIds))]
  };
}

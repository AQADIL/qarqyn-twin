import { z } from 'zod';
import { datasetSchema, dateSchema, parse, fail } from './schema.js';
import { observationCoverage, classifyDowntime } from './model-input.js';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const dateSelection = z.array(dateSchema).min(1).max(366);
export const pilotSchema = z
  .object({
    datasetId: identifier,
    expectedDatasetVersion: z.number().int().positive(),
    stageId: identifier,
    beforeDates: dateSelection,
    afterDates: dateSelection
  })
  .strict()
  .superRefine((input, context) => {
    for (const key of ['beforeDates', 'afterDates']) {
      if (new Set(input[key]).size !== input[key].length)
        context.addIssue({
          code: 'custom',
          path: [key],
          message: 'Даты одного периода не должны повторяться.'
        });
    }
    if (input.beforeDates.some((date) => input.afterDates.includes(date)))
      context.addIssue({
        code: 'custom',
        path: ['afterDates'],
        message: 'Периоды до и после не должны пересекаться.'
      });
    if ([...input.beforeDates].sort().at(-1) >= [...input.afterDates].sort()[0])
      context.addIssue({
        code: 'custom',
        path: ['afterDates'],
        message: 'Все даты после изменения должны следовать за датами исходного периода.'
      });
  });

const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
const distinct = (values) => [...new Set(values)];

function observedPeriod(data, stageId, selectedDates) {
  const dates = [...selectedDates].sort();
  const rowsFor = (key) =>
    data[key].filter((row) => row.stageId === stageId && dates.includes(row.date));
  const production = rowsFor('production');
  const quality = rowsFor('quality');
  const downtime = rowsFor('downtime');
  const coverage = observationCoverage(data, stageId);
  const missingProductionDates = dates.filter(
    (date) => !production.some((row) => row.date === date)
  );
  if (missingProductionDates.length)
    fail(
      422,
      `Нет производственного наблюдения выбранного участка за ${missingProductionDates.join(', ')}.`
    );
  const confirmedDowntimeDates = dates.filter((date) =>
    coverage.confirmedDowntimeDates.includes(date)
  );
  const qualityDates = dates.filter((date) => quality.some((row) => row.date === date));
  const downtimeComplete = confirmedDowntimeDates.length === dates.length;
  const registeredMinutes = downtime.length || downtimeComplete ? sum(downtime, 'minutes') : null;
  const output = sum(production, 'actual');
  const runtimeHours = sum(production, 'runtimeHours');
  const inspected = quality.length ? sum(quality, 'produced') : null;
  const defects = quality.length ? sum(quality, 'defects') : null;
  return {
    dates,
    observationCount: dates.length,
    productionRows: production.length,
    output,
    outputPerPeriod: output / dates.length,
    runtimeHours,
    outputPerRuntimeHour: output / runtimeHours,
    lines: distinct(production.map((row) => row.line)),
    periodHours: distinct(production.map((row) => row.periodHours ?? null)),
    regimes: distinct(production.map((row) => row.regime ?? null)),
    quality: {
      inspected,
      defects,
      defectPct: inspected ? (100 * defects) / inspected : null,
      observedDates: qualityDates,
      missingDates: dates.filter((date) => !qualityDates.includes(date)),
      complete: qualityDates.length === dates.length
    },
    downtime: {
      registeredMinutes,
      totalMinutes: downtimeComplete ? registeredMinutes : null,
      minutesPerPeriod: downtimeComplete ? registeredMinutes / dates.length : null,
      complete: downtimeComplete,
      confirmedDates: confirmedDowntimeDates,
      unconfirmedDates: dates.filter((date) => !confirmedDowntimeDates.includes(date)),
      eventDates: distinct(downtime.map((row) => row.date)).sort(),
      classification: ['planned', 'unplanned', 'unknown'].map((kind) => ({
        kind,
        registeredMinutes:
          registeredMinutes === null
            ? null
            : sum(
                downtime.filter((row) => classifyDowntime(row).kind === kind),
                'minutes'
              )
      }))
    },
    sourceIds: [...production, ...quality, ...downtime].map((row) => row.id),
    coverageEvidence: (data.observationCoverage ?? []).filter(
      (row) => row.stageId === stageId && dates.includes(row.date)
    )
  };
}

export function evaluatePilot(dataset, request) {
  const input = parse(pilotSchema, request);
  const data = parse(datasetSchema, dataset);
  const stage = data.stages.find((row) => row.id === input.stageId && row.kind === 'production');
  if (!stage) fail(422, 'Для сравнения выберите существующий производственный участок.');
  const before = observedPeriod(data, stage.id, input.beforeDates);
  const after = observedPeriod(data, stage.id, input.afterDates);
  const reasons = [];
  const add = (code, detail) => reasons.push({ code, detail });
  const lines = distinct([...before.lines, ...after.lines]);
  const periods = distinct([...before.periodHours, ...after.periodHours]);
  const regimes = distinct([...before.regimes, ...after.regimes]);
  if (
    lines.length !== 1 ||
    before.productionRows !== before.observationCount ||
    after.productionRows !== after.observationCount
  )
    add(
      'line_mismatch',
      'Нужна одна и та же линия с одной записью на каждую выбранную дату. Сейчас состав линий различается либо есть параллельные наблюдения.'
    );
  if (periods.includes(null))
    add(
      'period_unknown',
      'Не для всех записей задана длительность исходного периода periodHours. Сопоставимость выпуска за период не подтверждена.'
    );
  else if (periods.length !== 1)
    add(
      'period_mismatch',
      'Длительность исходных периодов различается. Сравнивать их как одинаковые смены нельзя.'
    );
  if (regimes.includes(null))
    add(
      'regime_unknown',
      'Не для всех записей указан режим regime. Инженер должен обозначить сопоставимые условия и состав продукции.'
    );
  else if (regimes.length !== 1)
    add('regime_mismatch', 'До и после указаны разные режимы производства или состав продукции.');
  const comparable = reasons.length === 0;
  const metric = (beforeValue, afterValue, unit, compatible = comparable, detail = null) => ({
    before: beforeValue,
    after: afterValue,
    delta:
      compatible && beforeValue !== null && afterValue !== null ? afterValue - beforeValue : null,
    unit,
    comparable: compatible && beforeValue !== null && afterValue !== null,
    detail
  });
  const qualityComplete = before.quality.complete && after.quality.complete;
  const downtimeComplete = before.downtime.complete && after.downtime.complete;
  return {
    version: 'pilot-review-v1',
    datasetId: input.datasetId,
    datasetVersion: input.expectedDatasetVersion,
    stageId: stage.id,
    stageName: stage.name,
    comparable,
    reasons,
    before,
    after,
    metrics: {
      outputPerPeriod: metric(before.outputPerPeriod, after.outputPerPeriod, 'шт./период'),
      outputPerRuntimeHour: metric(
        before.outputPerRuntimeHour,
        after.outputPerRuntimeHour,
        'шт./ч работы',
        comparable,
        'Суммарный выпуск делится на суммарное зарегистрированное время работы. Это производительность за рабочий час, не OEE.'
      ),
      defectPct: metric(
        before.quality.defectPct,
        after.quality.defectPct,
        'п.п.',
        comparable && qualityComplete,
        qualityComplete
          ? 'Взвешенная доля брака среди проверенных операций; положительная разница означает рост брака.'
          : 'Проверки качества есть не за все выбранные даты. Доли описывают только имеющуюся выборку, их изменение не оценивается.'
      ),
      downtimeMinutesPerPeriod: metric(
        before.downtime.minutesPerPeriod,
        after.downtime.minutesPerPeriod,
        'мин/период',
        comparable && downtimeComplete,
        downtimeComplete
          ? 'Сумма времени оборудования на период; одновременные остановки могут пересекаться.'
          : 'Полнота журнала не подтверждена для всех выбранных дат. Пропущенные события не считаются нулём.'
      )
    },
    sourceIds: distinct([...before.sourceIds, ...after.sourceIds]),
    evidenceLevel: 'descriptive',
    warnings: [
      'Это описательное сравнение зарегистрированных наблюдений до и после. Оно не доказывает, что изменение вызвало разницу; контрольная группа и причинный эксперимент здесь не заданы.',
      'Результат не подтверждает внедрение сам по себе. Даты, линия, режим, длительность периодов и полнота журналов должны соответствовать реально проведённой работе.',
      ...(Math.min(before.observationCount, after.observationCount) < 2
        ? [
            'В одном из периодов только одна дата. Межпериодная вариативность и устойчивость изменения не оценены.'
          ]
        : []),
      'Статистическая значимость и доверительный интервал эффекта не рассчитываются: зависимость смен, сезонность и внешние изменения не установлены.',
      'Одинаковая метка режима является пользовательским подтверждением сопоставимости, а не независимой проверкой условий.',
      'Денежная экономия и причинный производственный эффект автоматически не рассчитываются.'
    ]
  };
}

import { forecast } from './forecast.js';
import { datasetSchema, parse } from './schema.js';

const MIN_TRAIN = 8;
const MIN_TEST = 8;
const ROBUST_TEST = 20;
const METHODS = ['persistence', 'recent-mean', 'local-trend'];
const LABELS = {
  persistence: 'Последнее наблюдение',
  'recent-mean': 'Среднее последних трёх периодов',
  'local-trend': 'Линейный тренд последних пяти периодов'
};
const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const round = (value) => (value === null ? null : Number(value.toFixed(6)));
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const center = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[center] : (sorted[center - 1] + sorted[center]) / 2;
};

function prediction(method, values, maximum) {
  let result = values.at(-1);
  if (method === 'recent-mean') result = average(values.slice(-3));
  if (method === 'local-trend') {
    const window = values.slice(-5);
    const center = (window.length - 1) / 2;
    const mean = average(window);
    const numerator = window.reduce(
      (sum, value, index) => sum + (index - center) * (value - mean),
      0
    );
    const denominator = window.reduce((sum, _, index) => sum + (index - center) ** 2, 0);
    result = mean + (numerator / denominator) * (window.length - center);
  }
  return Math.min(maximum, Math.max(0, result));
}

function grouped(rows, valueOf) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.date)) groups.set(row.date, []);
    groups.get(row.date).push(row);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, records]) => ({
      date,
      value: valueOf(records),
      sourceIds: records.map((row) => row.id)
    }));
}

function pairedEvidence(rows) {
  const deltas = rows.map((row) => row.baselineError - row.absoluteError);
  const blocks = Array.from({ length: 4 }, (_, index) => {
    const part = rows.slice(
      Math.floor((index * rows.length) / 4),
      Math.floor(((index + 1) * rows.length) / 4)
    );
    return {
      from: part[0].date,
      through: part.at(-1).date,
      count: part.length,
      meanGain: round(average(part.map((row) => row.baselineError - row.absoluteError)))
    };
  });
  let interval = null;
  if (rows.length >= ROBUST_TEST) {
    const blockLength = Math.ceil(Math.cbrt(rows.length));
    const resamples = 500;
    let state = 2463534242;
    const random = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 4294967296;
    };
    const means = [];
    // Resample adjacent error pairs together to retain short-range time dependence.
    for (let sample = 0; sample < resamples; sample++) {
      let sum = 0;
      let count = 0;
      while (count < deltas.length) {
        const start = Math.floor(random() * (deltas.length - blockLength + 1));
        for (let offset = 0; offset < blockLength && count < deltas.length; offset++, count++)
          sum += deltas[start + offset];
      }
      means.push(sum / deltas.length);
    }
    means.sort((a, b) => a - b);
    interval = {
      low: round(means[Math.floor(resamples * 0.05)]),
      high: round(means[Math.ceil(resamples * 0.95) - 1]),
      blockLength,
      resamples,
      method: 'moving-block-bootstrap',
      label:
        '5–95-й процентили блочной перепроверки разницы ошибок; исследовательская оценка устойчивости, не вероятность будущего успеха'
    };
  }
  return {
    wins: deltas.filter((value) => value > 1e-9).length,
    ties: deltas.filter((value) => Math.abs(value) <= 1e-9).length,
    losses: deltas.filter((value) => value < -1e-9).length,
    medianGain: round(median(deltas)),
    meanGain: round(average(deltas)),
    positiveBlocks: blocks.filter((block) => block.meanGain > 0).length,
    blocks,
    interval
  };
}

function validateSeries(points, info, stage, expectedDates) {
  const dates = new Set(points.map((point) => point.date));
  const missingDates = expectedDates.filter((date) => !dates.has(date));
  const gaps = points
    .slice(1)
    .map((point, index) => (Date.parse(point.date) - Date.parse(points[index].date)) / 86400000);
  const blockers = [];
  if (!stage.regime.durationDeclared)
    blockers.push(
      'Не указана длительность всех исходных периодов. Заполните periodHours в производственных записях.'
    );
  if (missingDates.length)
    blockers.push(
      `Не хватает наблюдений показателя за ${missingDates.length} производственных периодов.`
    );
  if (new Set(gaps).size > 1)
    blockers.push(
      'Интервалы между наблюдениями различаются. Подготовьте историю сопоставимых периодов без неизвестных пропусков.'
    );
  if (
    info.key === 'downtime' &&
    !expectedDates.every((date) => stage.coverage.confirmedDowntimeDates.includes(date))
  )
    blockers.push(
      'Для сравнения простоев подтвердите полноту журнала за каждую дату, включая периоды без событий.'
    );
  const needed = Math.max(0, MIN_TRAIN + MIN_TEST - points.length);
  if (needed)
    blockers.unshift(
      `Добавьте ещё минимум ${needed} сопоставимых наблюдений этого показателя для отделения обучения от проверки.`
    );
  const result = {
    key: info.key,
    label: info.label,
    unit: info.unit,
    scope: info.scope,
    observations: points.length,
    status: 'insufficient',
    verdict: 'Недостаточно данных для независимой проверки',
    selectedMethod: null,
    selectedMethodLabel: null,
    nextEstimate: null,
    training: null,
    holdout: null,
    metrics: null,
    pairedEvidence: null,
    rows: [],
    readiness: {
      additionalObservations: needed,
      minimumObservations: MIN_TRAIN + MIN_TEST,
      missingDates,
      durationDeclared: stage.regime.durationDeclared,
      completeCoverage:
        missingDates.length === 0 &&
        (info.key !== 'downtime' ||
          expectedDates.every((date) => stage.coverage.confirmedDowntimeDates.includes(date))),
      excludedPriorRegimeDates: stage.regime.excludedObservationCount,
      blockers
    }
  };
  if (needed) return result;
  const testCount = Math.max(MIN_TEST, Math.ceil(points.length * 0.25));
  const trainCount = points.length - testCount;
  const values = points.map((point) => point.value);
  const candidates = METHODS.map((method) => {
    const errors = [];
    for (let index = 3; index < trainCount; index++)
      errors.push(
        Math.abs(
          values[index] -
            prediction(method, values.slice(Math.max(0, index - 5), index), info.maximum)
        )
      );
    return { method, label: LABELS[method], selectionMae: average(errors), folds: errors.length };
  });
  const selected = candidates.reduce((best, item) =>
    item.selectionMae < best.selectionMae - 1e-9 ? item : best
  );
  const rows = [];
  for (let index = trainCount; index < points.length; index++) {
    const previous = values.slice(Math.max(0, index - 5), index);
    const estimate = prediction(selected.method, previous, info.maximum);
    const baseline = prediction('persistence', previous, info.maximum);
    rows.push({
      date: points[index].date,
      knownThrough: points[index - 1].date,
      methodSelectedThrough: points[trainCount - 1].date,
      actual: values[index],
      predicted: estimate,
      baseline,
      absoluteError: Math.abs(values[index] - estimate),
      baselineError: Math.abs(values[index] - baseline),
      sourceIds: points[index].sourceIds,
      ...(points[index].coverageEvidence
        ? { coverageEvidence: points[index].coverageEvidence }
        : {})
    });
  }
  const mae = average(rows.map((row) => row.absoluteError));
  const baselineMae = average(rows.map((row) => row.baselineError));
  const evidence = pairedEvidence(rows);
  const gainPct = baselineMae > 1e-9 ? (100 * (baselineMae - mae)) / baselineMae : null;
  const stableGain = gainPct >= 5 && evidence.interval?.low > 0 && evidence.positiveBlocks >= 3;
  const status = blockers.length ? 'insufficient' : stableGain ? 'better' : 'baseline';
  const verdict = blockers.length
    ? 'Ошибки измерены; сопоставимость периодов ещё не подтверждена'
    : stableGain
      ? 'Устойчивое преимущество на отложенной истории'
      : selected.method === 'persistence'
        ? 'Простая база осталась лучшим выбором'
        : testCount < ROBUST_TEST
          ? 'Первое сравнение есть; для вывода об устойчивости нужна более длинная проверка'
          : 'Устойчивое преимущество над простой базой не выявлено';
  return {
    ...result,
    status,
    verdict,
    selectedMethod: selected.method,
    selectedMethodLabel: selected.label,
    nextEstimate: round(prediction(selected.method, values.slice(-5), info.maximum)),
    training: {
      from: points[0].date,
      through: points[trainCount - 1].date,
      observations: trainCount,
      candidates: candidates.map((item) => ({ ...item, selectionMae: round(item.selectionMae) }))
    },
    holdout: {
      from: points[trainCount].date,
      through: points.at(-1).date,
      observations: testCount,
      additionalForStability: Math.max(0, ROBUST_TEST - testCount)
    },
    metrics: {
      mae: round(mae),
      baselineMae: round(baselineMae),
      rmse: round(Math.sqrt(average(rows.map((row) => row.absoluteError ** 2)))),
      baselineRmse: round(Math.sqrt(average(rows.map((row) => row.baselineError ** 2)))),
      improvementPct: round(gainPct)
    },
    pairedEvidence: evidence,
    rows: rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          typeof value === 'number' ? round(value) : value
        ])
      )
    )
  };
}

export function validateForecast(input) {
  const data = parse(datasetSchema, input);
  const existing = forecast(data);
  const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
  const stages = existing.stages
    .filter((stage) => stage.kind === 'production')
    .map((stage) => {
      const active = new Set(stage.regime.dates);
      const records = (key) =>
        data[key].filter((row) => row.stageId === stage.stageId && active.has(row.date));
      const output = grouped(records('production'), (rows) => sum(rows, 'actual'));
      const quality = grouped(
        records('quality'),
        (rows) => (100 * sum(rows, 'defects')) / sum(rows, 'produced')
      );
      const downtime = grouped(records('downtime'), (rows) => sum(rows, 'minutes'));
      for (const date of stage.regime.dates)
        if (
          stage.coverage.confirmedDowntimeDates.includes(date) &&
          !downtime.some((point) => point.date === date)
        )
          downtime.push({
            date,
            value: 0,
            sourceIds: [],
            coverageEvidence: { stageId: stage.stageId, date, downtimeComplete: true }
          });
      downtime.sort((a, b) => a.date.localeCompare(b.date));
      const series = { output, quality, downtime };
      return {
        stageId: stage.stageId,
        name: stage.name,
        regimeSince: stage.regime.since,
        metrics: ['output', 'quality', 'downtime'].map((key) =>
          validateSeries(
            series[key],
            {
              key,
              label: stage[key].label,
              unit: stage[key].unit,
              scope: stage[key].scope,
              maximum: key === 'quality' ? 100 : Infinity
            },
            stage,
            key === 'output'
              ? existing.observedDates.filter((date) => date >= stage.regime.since)
              : stage.regime.dates
          )
        )
      };
    });
  const metrics = stages.flatMap((stage) => stage.metrics);
  return {
    version: 'forecast-validation-v1',
    source: data.source,
    summary: {
      totalMetrics: metrics.length,
      evaluated: metrics.filter((metric) => metric.metrics).length,
      better: metrics.filter((metric) => metric.status === 'better').length,
      baseline: metrics.filter((metric) => metric.status === 'baseline').length,
      insufficient: metrics.filter((metric) => metric.status === 'insufficient').length
    },
    protocol: {
      minimumTraining: MIN_TRAIN,
      minimumHoldout: MIN_TEST,
      minimumStabilityHoldout: ROBUST_TEST,
      holdoutFraction: 0.25,
      horizon: 1,
      label:
        'Последние 25% наблюдений, но не менее восьми, отложены. Метод выбирается на более ранней истории и фиксируется до начала проверки.',
      updateRule:
        'На каждом шаге доступны уже полученные фактические значения. Выбор метода не меняется по результатам контрольного отрезка.',
      successRule:
        'Не менее 20 контрольных периодов, снижение MAE минимум на 5%, положительный выигрыш в трёх из четырёх временных блоков и нижний 5-й процентиль блочной перепроверки выше нуля. Это внутреннее правило допуска к пилоту, не доказательство будущего эффекта.',
      limitations:
        'Проверяется величина показателя на следующий сопоставимый период. Вероятность отказа, конкретная причина простоя и переносимость на другую линию не проверяются. При обновлении набора граница отложенного отрезка пересчитывается; экспорт сохраняет воспроизводимый снимок проверки. Множественные сравнения показателей не дают общего статистического доказательства.',
      references: ['https://otexts.com/fpp3/tscv.html', 'https://otexts.com/fpp3/accuracy.html']
    },
    stages
  };
}

import { datasetSchema, parse } from './schema.js';
import { observationCoverage } from './model-input.js';

const MIN_TRAINING = 3;
const MIN_SELECTION_FOLDS = 5;
const MIN_EMPIRICAL_FOLDS = 20;
const DISPLAYED_POINTS = 180;
const DISPLAYED_BACKTEST_FOLDS = 80;
const METHODS = ['persistence', 'recent-mean', 'local-trend'];
const LABELS = {
  persistence: 'Последнее наблюдение',
  'recent-mean': 'Среднее последних трёх периодов',
  'local-trend': 'Линейный тренд последних пяти периодов'
};
const rounded = (value) => Number(value.toFixed(4));
const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const unique = (values) => [...new Set(values)];
const bound = (value, maximum) => Math.max(0, Math.min(maximum, value));

function predict(method, values, maximum) {
  if (method === 'persistence') return bound(values.at(-1), maximum);
  if (method === 'recent-mean') return bound(average(values.slice(-3)), maximum);
  const window = values.slice(-5);
  const centerX = (window.length - 1) / 2;
  const centerY = average(window);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < window.length; i++) {
    numerator += (i - centerX) * (window[i] - centerY);
    denominator += (i - centerX) ** 2;
  }
  return bound(centerY + (numerator / denominator) * (window.length - centerX), maximum);
}

function selectMethod(errors, folds) {
  if (folds < MIN_SELECTION_FOLDS) return 'persistence';
  return METHODS.reduce((best, method) => (errors[method] < errors[best] ? method : best));
}

function series(rows, valueOf) {
  const groups = new Map();
  for (const row of rows) {
    const group = groups.get(row.date) || [];
    group.push(row);
    groups.set(row.date, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, records]) => ({
      date,
      value: valueOf(records),
      sourceIds: records.map((row) => row.id)
    }));
}

function currentRegime(rows) {
  const dates = [...new Set(rows.map((row) => row.date))].sort();
  const signatures = dates.map((date) =>
    JSON.stringify(
      rows
        .filter((row) => row.date === date)
        .map((row) => [row.line, row.periodHours ?? null, row.regime ?? null])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    )
  );
  let start = dates.length - 1;
  while (start > 0 && signatures[start - 1] === signatures.at(-1)) start--;
  const keptDates = dates.slice(Math.max(0, start));
  return {
    dates: keptDates,
    since: keptDates[0] ?? null,
    excludedObservationCount: Math.max(0, start),
    changes: signatures.filter((value, index) => index > 0 && value !== signatures[index - 1])
      .length,
    durationDeclared:
      keptDates.length > 0 &&
      rows
        .filter((row) => keptDates.includes(row.date))
        .every((row) => row.periodHours !== undefined),
    label:
      rows
        .filter((row) => row.date === dates.at(-1))
        .map((row) => row.regime)
        .filter(Boolean)
        .join(' / ') || null
  };
}

function metric(points, observedDates, { label, unit, scope, maximum = Infinity }) {
  const values = points.map((point) => point.value);
  const errorSums = Object.fromEntries(METHODS.map((method) => [method, 0]));
  const backtest = [];
  const orderedPastErrors = [];
  const missingDates = observedDates.filter((date) => !points.some((point) => point.date === date));
  for (let i = MIN_TRAINING; i < points.length; i++) {
    const earlier = values.slice(Math.max(0, i - 5), i);
    const selected = selectMethod(errorSums, backtest.length);
    const predictions = Object.fromEntries(
      METHODS.map((method) => [method, predict(method, earlier, maximum)])
    );
    const predicted = predictions[selected];
    const radius =
      orderedPastErrors.length >= MIN_EMPIRICAL_FOLDS
        ? orderedPastErrors[Math.ceil(orderedPastErrors.length * 0.9) - 1]
        : null;
    const intervalLow = radius === null ? null : bound(predicted - radius, maximum);
    const intervalHigh = radius === null ? null : bound(predicted + radius, maximum);
    backtest.push({
      date: points[i].date,
      trainThrough: points[i - 1].date,
      trainingObservations: i,
      selectionFolds: backtest.length,
      method: selected,
      actual: values[i],
      predicted,
      baseline: predictions.persistence,
      absoluteError: Math.abs(values[i] - predicted),
      baselineAbsoluteError: Math.abs(values[i] - predictions.persistence),
      intervalLow,
      intervalHigh,
      intervalCovered:
        radius === null ? null : values[i] >= intervalLow && values[i] <= intervalHigh
    });
    // The held-out observation can update selection only after its prediction is recorded.
    for (const method of METHODS) errorSums[method] += Math.abs(values[i] - predictions[method]);
    const currentError = Math.abs(values[i] - predicted);
    let errorIndex = 0;
    while (errorIndex < orderedPastErrors.length && orderedPastErrors[errorIndex] <= currentError)
      errorIndex++;
    orderedPastErrors.splice(errorIndex, 0, currentError);
  }
  const method = values.length ? selectMethod(errorSums, backtest.length) : null;
  const estimate = method ? predict(method, values, maximum) : null;
  const sufficient = backtest.length >= MIN_SELECTION_FOLDS;
  const mae = sufficient ? average(backtest.map((fold) => fold.absoluteError)) : null;
  const baselineMae = sufficient
    ? average(backtest.map((fold) => fold.baselineAbsoluteError))
    : null;
  const coveredFolds = backtest.filter((fold) => fold.intervalCovered !== null);
  const recentMae =
    backtest.length >= 10 ? average(backtest.slice(-5).map((fold) => fold.absoluteError)) : null;
  const previousMae =
    backtest.length >= 10
      ? average(backtest.slice(-10, -5).map((fold) => fold.absoluteError))
      : null;
  const gaps = points
    .slice(1)
    .map((point, index) => (Date.parse(point.date) - Date.parse(points[index].date)) / 86400000);
  let range = values.length
    ? {
        low: rounded(Math.min(...values)),
        high: rounded(Math.max(...values)),
        kind: 'observed',
        label: 'Минимум и максимум наблюдений, не интервал прогноза',
        probability: null
      }
    : null;
  if (backtest.length >= MIN_EMPIRICAL_FOLDS) {
    const errors = backtest.map((fold) => fold.absoluteError).sort((a, b) => a - b);
    const radius = errors[Math.ceil(errors.length * 0.9) - 1];
    range = {
      low: rounded(bound(estimate - radius, maximum)),
      high: rounded(bound(estimate + radius, maximum)),
      kind: 'empirical',
      label: 'Диапазон по 90-му процентилю прошлых ошибок; покрытие будущего не гарантируется',
      probability: null,
      errorQuantile: 0.9,
      calibrationObservations: errors.length
    };
  }
  return {
    label,
    unit,
    scope,
    estimate: estimate === null ? null : rounded(estimate),
    method,
    methodLabel: method ? LABELS[method] : 'Нет наблюдений',
    observationCount: points.length,
    points: points
      .slice(-DISPLAYED_POINTS)
      .map((point) => ({ ...point, value: rounded(point.value) })),
    historyTruncated: points.length > DISPLAYED_POINTS,
    displayedPoints: Math.min(points.length, DISPLAYED_POINTS),
    missingDates,
    range,
    validation: {
      status: sufficient ? 'backtested' : 'insufficient',
      folds: backtest.length,
      mae: mae === null ? null : rounded(mae),
      baselineMae: baselineMae === null ? null : rounded(baselineMae),
      improvementPct: baselineMae > 0 ? rounded(((baselineMae - mae) / baselineMae) * 100) : null,
      selectionFolds: backtest.length,
      evaluationLabel:
        'Последовательный выбор модели только по прошлым ошибкам; MAE на будущих для каждого шага наблюдениях',
      candidates: sufficient
        ? METHODS.map((candidate) => ({
            method: candidate,
            label: LABELS[candidate],
            selectionMae: rounded(errorSums[candidate] / backtest.length)
          }))
        : [],
      backtestTruncated: backtest.length > DISPLAYED_BACKTEST_FOLDS,
      backtestDisplayed: Math.min(backtest.length, DISPLAYED_BACKTEST_FOLDS),
      backtest: backtest.slice(-DISPLAYED_BACKTEST_FOLDS).map((fold) => ({
        ...fold,
        actual: rounded(fold.actual),
        predicted: rounded(fold.predicted),
        baseline: rounded(fold.baseline),
        absoluteError: rounded(fold.absoluteError),
        baselineAbsoluteError: rounded(fold.baselineAbsoluteError)
      }))
    },
    sourceIds: unique(points.flatMap((point) => point.sourceIds)),
    diagnostics: {
      lastObservedDate: points.at(-1)?.date ?? null,
      expectedDates: observedDates.length,
      missingDates: missingDates.length,
      observedCoveragePct: observedDates.length
        ? rounded((100 * (observedDates.length - missingDates.length)) / observedDates.length)
        : null,
      irregularSpacing: new Set(gaps).size > 1,
      maxCalendarGapDays: gaps.length ? Math.max(...gaps) : null,
      spacingNote:
        'Календарные разрывы не доказывают пропуски рабочих смен; производственный календарь неизвестен.',
      drift: {
        status:
          recentMae === null
            ? 'insufficient'
            : recentMae > Math.max(previousMae * 1.5, 1e-9)
              ? 'watch'
              : 'no_signal',
        recentMae: recentMae === null ? null : rounded(recentMae),
        previousMae: previousMae === null ? null : rounded(previousMae),
        label:
          'Сравнение MAE последних пяти проверок с предыдущими пятью; рост более 1,5 раза — эвристический сигнал для проверки, не статистическое доказательство дрейфа.'
      },
      intervalCoverage: {
        evaluatedFolds: coveredFolds.length,
        coveredFolds: coveredFolds.filter((fold) => fold.intervalCovered).length,
        empiricalCoveragePct: coveredFolds.length
          ? rounded(
              (100 * coveredFolds.filter((fold) => fold.intervalCovered).length) /
                coveredFolds.length
            )
          : null,
        label:
          'Проверка покрытия: границы каждого шага построены только по ещё более ранним ошибкам. Это наблюдаемое прошлое покрытие, не гарантия будущего.'
      }
    }
  };
}

export function forecast(input) {
  const data = parse(datasetSchema, input);
  const observedDates = unique(data.production.map((row) => row.date)).sort();
  const stages = data.stages.map((stage) => {
    const allProduction = data.production.filter((row) => row.stageId === stage.id);
    const regime = currentRegime(allProduction);
    const activeDates = new Set(regime.dates);
    const production = allProduction.filter((row) => activeDates.has(row.date));
    const quality = data.quality.filter(
      (row) => row.stageId === stage.id && activeDates.has(row.date)
    );
    const downtime = data.downtime.filter(
      (row) => row.stageId === stage.id && activeDates.has(row.date)
    );
    const stageDates = unique(production.map((row) => row.date)).sort();
    const sumOf = (key) => (rows) => rows.reduce((total, row) => total + row[key], 0);
    const output = metric(
      series(production, sumOf('actual')),
      regime.since ? observedDates.filter((date) => date >= regime.since) : observedDates,
      {
        label: 'Выпуск',
        unit: 'шт.',
        scope: 'Сумма выпуска участка за дату; следующий сопоставимый период с наблюдением'
      }
    );
    const qualityMetric = metric(
      series(quality, (rows) => (100 * sumOf('defects')(rows)) / sumOf('produced')(rows)),
      stageDates,
      {
        label: 'Доля брака',
        unit: '%',
        maximum: 100,
        scope: 'Доля брака в проверенных операциях за дату, взвешенная по объёму проверок'
      }
    );
    const coverage = observationCoverage(data, stage.id);
    const downtimePoints = series(downtime, sumOf('minutes'));
    for (const date of stageDates) {
      if (
        coverage.confirmedDowntimeDates.includes(date) &&
        !downtimePoints.some((point) => point.date === date)
      )
        downtimePoints.push({
          date,
          value: 0,
          sourceIds: [],
          coverageEvidence: { stageId: stage.id, date, downtimeComplete: true }
        });
    }
    downtimePoints.sort((left, right) => left.date.localeCompare(right.date));
    const downtimeMetric = metric(downtimePoints, stageDates, {
      label: 'Зарегистрированный простой',
      unit: 'мин',
      scope:
        'Сумма по оборудованию, включая ТО. Ноль допустим только при явном подтверждении полного журнала за дату. Отсутствие записи не означает ноль'
    });
    const equipment = unique(downtime.map((row) => row.equipment)).map((name) => {
      const value = metric(
        series(
          downtime.filter((row) => row.equipment === name),
          sumOf('minutes')
        ),
        stageDates,
        {
          label: `Простой ${name}`,
          unit: 'мин',
          scope:
            'Условно на период с зарегистрированным событием; частота возникновения событий неизвестна'
        }
      );
      return { name, nextDowntimeMinutes: value.estimate, metric: value };
    });
    const risks = [];
    if (qualityMetric.estimate !== null && qualityMetric.estimate > data.targets.maxDefectPct) {
      risks.push({
        kind: 'quality',
        severity: 'high',
        title: 'Риск сохранения повышенного брака',
        detail: `Оценка ${qualityMetric.estimate}% выше заданного порога ${data.targets.maxDefectPct}%. Проверить причины до следующего периода; вероятность превышения не оценивалась.`,
        sourceIds: qualityMetric.sourceIds
      });
    }
    const lastPlanDate = stageDates.at(-1);
    const referencePlan = lastPlanDate
      ? sumOf('plan')(production.filter((row) => row.date === lastPlanDate))
      : null;
    if (output.estimate !== null && referencePlan !== null && output.estimate < referencePlan) {
      risks.push({
        kind: 'output',
        severity: 'normal',
        title: 'Риск повторения отставания',
        detail: `Оценка ${output.estimate} шт. ниже последнего известного плана ${referencePlan} шт. за ${lastPlanDate}. План следующего периода ещё не задан.`,
        sourceIds: output.sourceIds
      });
    }
    for (const item of equipment) {
      if (item.nextDowntimeMinutes > data.targets.maxDowntimeMinutes) {
        risks.push({
          kind: 'downtime',
          severity: 'high',
          title: `${item.name}: риск длительного события`,
          detail: `При наличии события оценка ${item.nextDowntimeMinutes} мин выше порога ${data.targets.maxDowntimeMinutes} мин. Это не вероятность отказа и не рекомендация отменить ТО.`,
          sourceIds: item.metric.sourceIds
        });
      }
    }
    return {
      stageId: stage.id,
      name: stage.name,
      kind: stage.kind,
      regime,
      coverage,
      nextOutput: output.estimate,
      nextDowntimeMinutes: downtimeMetric.estimate,
      nextDefectPct: qualityMetric.estimate,
      referencePlan,
      referencePlanDate: lastPlanDate ?? null,
      output,
      downtime: downtimeMetric,
      quality: qualityMetric,
      equipment,
      risks,
      sourceIds: unique([
        ...output.sourceIds,
        ...qualityMetric.sourceIds,
        ...downtimeMetric.sourceIds
      ])
    };
  });
  const measured = stages.filter((stage) => stage.nextOutput !== null);
  const metrics = measured.flatMap((stage) => [stage.output, stage.quality, stage.downtime]);
  const backtestedMetrics = metrics.filter(
    (value) => value.validation.status === 'backtested'
  ).length;
  const bottleneck = measured.reduce(
    (lowest, stage) => (!lowest || stage.nextOutput < lowest.nextOutput ? stage : lowest),
    null
  );
  const ready =
    metrics.length > 0 && metrics.every((value) => value.validation.status === 'backtested');
  const missingQualityDates = measured.reduce(
    (count, stage) => count + stage.quality.missingDates.length,
    0
  );
  const dataPriorities = [];
  const changedRegimes = measured.filter((stage) => stage.regime.excludedObservationCount > 0);
  if (changedRegimes.length) {
    dataPriorities.push({
      id: 'regime-change',
      priority: 'high',
      title: 'Проверить смену условий производства',
      detail: `${changedRegimes.map((stage) => `${stage.name}: с ${stage.regime.since}`).join('; ')}. История до последней смены состава линий, длительности периода или заданного режима исключена из текущего прогноза и проверки. Неуказанные изменения обнаружить нельзя.`
    });
  }
  if (backtestedMetrics < metrics.length) {
    dataPriorities.push({
      id: 'history',
      priority: 'high',
      title: 'Пополнить историю сопоставимых периодов',
      detail: `Сейчас ${observedDates.length} дат выпуска. Для первого сравнения методов нужно минимум ${MIN_TRAINING + MIN_SELECTION_FOLDS} наблюдений каждого показателя; это технический минимум, а не доказательство надёжности.`
    });
  }
  if (measured.some((stage) => !stage.coverage.downtimeComplete))
    dataPriorities.push({
      id: 'event-coverage',
      priority: 'high',
      title: 'Подтвердить периоды без простоев',
      detail:
        'Полнота журнала подтверждена не для всех периодов. Подтвердите даты без событий отдельно; добавьте границы смен и время начала и конца остановок для оценки простоя всей линии.'
    });
  if (missingQualityDates) {
    dataPriorities.push({
      id: 'quality-coverage',
      priority: 'high',
      title: 'Восстановить отсутствующие проверки качества',
      detail: `Для ${missingQualityDates} пар «участок–дата выпуска» нет записи качества. Пропуски не заменяются нулевым браком.`
    });
  }
  dataPriorities.push({
    id: 'comparable-periods',
    priority: 'normal',
    title: 'Уточнить режим, модели автомобилей и маршрут',
    detail:
      'Подтвердить одинаковую длительность наблюдений и состав линий, разделить плановое ТО и аварии, добавить сменный план и незавершённое производство для проверки ограничений потока.'
  });
  return {
    version: 'forecast-v2',
    observationCount: observedDates.length,
    observedDates,
    periodLabel: 'Следующий сопоставимый период наблюдения',
    readiness: {
      status: ready ? 'backtested' : 'provisional',
      label: ready ? 'Есть проверка на истории' : 'Предварительная оценка',
      detail: ready
        ? 'Ошибки измерены на последовательных отложенных наблюдениях; перенос на завод и будущие режимы требует пилота.'
        : 'Короткая или неполная история: доступные показатели экстраполируются, достаточная проверка точности есть не для всех рядов.'
    },
    summary: {
      text: bottleneck
        ? `${bottleneck.name}: наименьшая оценка выпуска среди наблюдаемых участков — ${bottleneck.nextOutput} шт. Это кандидат на проверку ограничения, а не доказанное узкое место линии.`
        : 'Нет производственных наблюдений для оценки выпуска.',
      measuredStages: measured.length,
      backtestedMetrics,
      totalMetrics: metrics.length,
      bottleneckStageId: bottleneck?.stageId ?? null
    },
    stages,
    validation: {
      method: 'rolling-origin',
      minimumTrainingObservations: MIN_TRAINING,
      minimumSelectionFolds: MIN_SELECTION_FOLDS,
      minimumEmpiricalRangeFolds: MIN_EMPIRICAL_FOLDS,
      label:
        'На каждом шаге доступны только более ранние наблюдения; выбор модели проверяется вместе с прогнозом. База сравнения — последнее значение.',
      references: [
        'https://otexts.com/fpp3/simple-methods.html',
        'https://otexts.com/fpp3/tscv.html',
        'https://otexts.com/fpp3/prediction-intervals.html'
      ]
    },
    dataPriorities,
    limitations: [
      'Это статистическая оценка следующего сопоставимого периода, не обученная диагностика отказов оборудования и не подтверждённый эффект внедрения.',
      'При недостаточной истории используется последнее наблюдение. Отсутствие измерения остаётся неизвестным. Нулевой простой допустим только при явном подтверждении полноты журнала за дату.',
      'Ряды сгруппированы по датам. Пропущенные даты не интерполируются; прогноз относится к следующему наблюдаемому периоду, а не обязательно к завтрашнему дню.',
      'Без подтверждённых периодов без событий прогноз простоя условен на наличие записи. Вероятность отказа не рассчитывается; пересечение событий и реальное время остановки линии неизвестны.',
      'История до последней заданной смены длительности периода, состава линий или режима исключается. Незаданные изменения обнаружить нельзя. Сезонность и производственный календарь не моделируются.',
      'Границы по прошлым ошибкам не гарантируют вероятность покрытия будущих значений. При короткой истории показан только диапазон наблюдений.',
      'Минимальный выпуск участка не доказывает узкое место: нужны данные о запасах между участками, параллельных линиях и маршрутах.'
    ]
  };
}

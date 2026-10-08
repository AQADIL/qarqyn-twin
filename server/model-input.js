export function classifyDowntime(row) {
  if (row.classification) return { kind: row.classification, basis: 'explicit' };
  const reason = row.reason.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU');
  if (/^(?:внепланов|авари|поломк|неисправност|ошибка датчика|обрыв цепи)/u.test(reason))
    return { kind: 'unplanned', basis: 'legacy-label' };
  if (/^(?:планов|техническое обслуживание|профилакти|регламент|то(?:\s|$))/u.test(reason))
    return { kind: 'planned', basis: 'legacy-label' };
  return { kind: 'unknown', basis: 'unclassified' };
}

export function selectModelData(data, date) {
  if (!date) return data;
  return {
    ...data,
    production: data.production.filter((row) => row.date === date),
    quality: data.quality.filter((row) => row.date === date),
    downtime: data.downtime.filter((row) => row.date === date),
    ...(data.observationCoverage
      ? { observationCoverage: data.observationCoverage.filter((row) => row.date === date) }
      : {})
  };
}

export function observationCoverage(data, stageId, date = null) {
  const production = data.production.filter(
    (row) => row.stageId === stageId && (!date || row.date === date)
  );
  const dates = [...new Set(production.map((row) => row.date))].sort();
  const qualityDates = new Set(
    data.quality.filter((row) => row.stageId === stageId).map((row) => row.date)
  );
  const downtimeDates = new Set(
    data.downtime.filter((row) => row.stageId === stageId).map((row) => row.date)
  );
  const confirmed = new Set(
    (data.observationCoverage ?? [])
      .filter((row) => row.stageId === stageId && row.downtimeComplete)
      .map((row) => row.date)
  );
  return {
    dates,
    missingQualityDates: dates.filter((value) => !qualityDates.has(value)),
    missingDowntimeDates: dates.filter(
      (value) => !downtimeDates.has(value) && !confirmed.has(value)
    ),
    confirmedDowntimeDates: dates.filter((value) => confirmed.has(value)),
    downtimeComplete: dates.length > 0 && dates.every((value) => confirmed.has(value))
  };
}

export function modelInputIssues(data, observationHours) {
  const issues = [];
  const add = (stageId, code, detail) => issues.push({ stageId, code, detail });
  const allDates = [...new Set(data.production.map((row) => row.date))].sort();
  for (const stage of data.stages.filter((row) => row.kind === 'production')) {
    const rows = data.production.filter((row) => row.stageId === stage.id);
    const coverage = observationCoverage(data, stage.id);
    if (coverage.dates.length !== allDates.length)
      add(
        stage.id,
        'incomplete_production',
        `${stage.name}: участки должны покрывать одинаковые даты производства.`
      );
    if (coverage.missingQualityDates.length)
      add(
        stage.id,
        'incomplete_quality',
        `${stage.name}: нет проверки качества за ${coverage.missingQualityDates.join(', ')}.`
      );
    const lines = new Set(rows.map((row) => row.line));
    if (lines.size > 1 || rows.length !== coverage.dates.length)
      add(
        stage.id,
        'parallel_or_duplicate_period',
        `${stage.name}: модель требует одну линию и одну запись на дату. Параллельные линии или смены нужно разделить в сопоставимую выборку.`
      );
    if (new Set(rows.map((row) => row.regime ?? '')).size > 1)
      add(
        stage.id,
        'mixed_regimes',
        `${stage.name}: смешаны режимы производства; выберите один сопоставимый режим.`
      );
    const knownPeriods = rows.filter((row) => row.periodHours !== undefined);
    if (
      knownPeriods.length &&
      (knownPeriods.length !== rows.length ||
        knownPeriods.some((row) => row.periodHours !== observationHours))
    )
      add(
        stage.id,
        'period_mismatch',
        `${stage.name}: длительность исходного периода не совпадает с выбранными ${observationHours} ч или указана не у всех строк.`
      );
    if (rows.some((row) => row.runtimeHours > observationHours))
      add(
        stage.id,
        'runtime_exceeds_period',
        `${stage.name}: рабочее время превышает выбранную длительность исходного периода.`
      );
    const events = data.downtime.filter((row) => row.stageId === stage.id);
    if (!events.length && !coverage.downtimeComplete)
      add(
        stage.id,
        'unknown_downtime',
        `${stage.name}: отсутствует журнал простоев и подтверждение периодов без остановок.`
      );
  }
  return issues;
}

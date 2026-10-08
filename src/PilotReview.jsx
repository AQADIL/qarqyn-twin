import { useEffect, useRef, useState } from 'react';
import { api, downloadJson, format } from './api.js';
import { Button, ErrorBox, Field } from './ui.jsx';

const metricLabels = {
  outputPerPeriod: 'Выпуск за период',
  outputPerRuntimeHour: 'Выпуск за час работы',
  defectPct: 'Доля брака в проверенной выборке',
  downtimeMinutesPerPeriod: 'Простой оборудования за период'
};

export default function PilotReview({ dataset, onEvidence }) {
  const stages = dataset.stages.filter((stage) => stage.kind === 'production');
  const [stageId, setStageId] = useState(stages.at(-1)?.id || '');
  const dates = [
    ...new Set(dataset.production.filter((row) => row.stageId === stageId).map((row) => row.date))
  ].sort();
  const [beforeDates, setBeforeDates] = useState(dates.length > 1 ? [dates[0]] : []);
  const [afterDates, setAfterDates] = useState(dates.length > 1 ? [dates.at(-1)] : []);
  const [result, setResult] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const controller = useRef(null);
  const invalidDates =
    beforeDates.length &&
    afterDates.length &&
    [...beforeDates].sort().at(-1) >= [...afterDates].sort()[0];
  useEffect(() => () => controller.current?.abort(), []);
  function selectStage(id) {
    const next = [
      ...new Set(dataset.production.filter((row) => row.stageId === id).map((row) => row.date))
    ].sort();
    setStageId(id);
    setBeforeDates(next.length > 1 ? [next[0]] : []);
    setAfterDates(next.length > 1 ? [next.at(-1)] : []);
    setResult(null);
  }
  async function compare(event) {
    event.preventDefault();
    if (invalidDates || !beforeDates.length || !afterDates.length) return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const response = await api(
        '/pilot',
        'POST',
        {
          datasetId: dataset.id,
          expectedDatasetVersion: dataset.version,
          stageId,
          beforeDates,
          afterDates
        },
        request.signal
      );
      if (!request.signal.aborted) setResult(response);
    } catch (failure) {
      if (!request.signal.aborted) setError(failure.message);
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  }
  const metrics = result
    ? Array.isArray(result.metrics)
      ? result.metrics
      : Object.entries(result.metrics || {}).map(([id, value]) => ({ id, ...value }))
    : [];
  return (
    <section className="pilot-review">
      <h3>Сравнение фактических периодов</h3>
      <p>
        Сравните фактические наблюдения до и после изменения процесса. Разница показателей сама по
        себе не доказывает причину улучшения.
      </p>
      <form onSubmit={compare} className="pilot-form">
        <Field label="Участок">
          <select
            value={stageId}
            onChange={(event) => selectStage(event.target.value)}
            disabled={busy}
          >
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="pilot-periods">
          {[
            ['before', 'До изменения', beforeDates, setBeforeDates],
            ['after', 'После изменения', afterDates, setAfterDates]
          ].map(([id, label, selected, setSelected]) => (
            <fieldset key={id} disabled={busy}>
              <legend>{label}</legend>
              {dates.length ? (
                <div className="pilot-date-list">
                  {dates.map((date) => (
                    <label key={date}>
                      <input
                        type="checkbox"
                        checked={selected.includes(date)}
                        onChange={(event) => {
                          setSelected(
                            event.target.checked
                              ? [...selected, date].sort()
                              : selected.filter((item) => item !== date)
                          );
                          setResult(null);
                        }}
                      />
                      <span>{new Date(`${date}T12:00:00`).toLocaleDateString('ru-RU')}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <p>Наблюдений нет.</p>
              )}
            </fieldset>
          ))}
        </div>
        <ErrorBox>{error}</ErrorBox>
        {invalidDates && (
          <p role="status">
            Все даты «после» должны быть позднее всех дат «до». Периоды не могут пересекаться.
          </p>
        )}
        <Button
          tone="primary"
          disabled={busy || !beforeDates.length || !afterDates.length || invalidDates}
        >
          {busy ? 'Сопоставляем наблюдения…' : 'Сравнить фактические результаты'}
        </Button>
      </form>
      {dates.length < 2 && (
        <p className="notice">
          Нужны наблюдения как минимум за две разные даты выбранного участка.
        </p>
      )}
      {result && (
        <div className="pilot-results">
          <div className="section-head">
            <h3>
              {result.comparable
                ? 'Условия сопоставимы по заполненным данным'
                : 'Нужна проверка сопоставимости'}
            </h3>
            <Button
              icon="download"
              onClick={() =>
                downloadJson(
                  {
                    datasetId: dataset.id,
                    datasetVersion: dataset.version,
                    stageId,
                    beforeDates,
                    afterDates,
                    result
                  },
                  'qarqyn-observed-effect.json'
                )
              }
            >
              Скачать сравнение
            </Button>
          </div>
          {(result.reasons || []).map((reason, i) => (
            <p className="notice" key={i}>
              {typeof reason === 'string' ? reason : reason.detail}
            </p>
          ))}
          <p>
            Участок: {result.stageName}. Дат до: {result.before.observationCount}; после:{' '}
            {result.after.observationCount}. Проверено операций качества:{' '}
            {format(result.before.quality.inspected)} → {format(result.after.quality.inspected)}.
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Показатель</th>
                  <th>До</th>
                  <th>После</th>
                  <th>Разница</th>
                </tr>
              </thead>
              <tbody>
                {metrics.map((metric) => (
                  <tr key={metric.id || metric.label}>
                    <th>{metricLabels[metric.id] || metric.label || metric.id}</th>
                    <td>
                      {format(metric.before, 2)} {metric.id === 'defectPct' ? '%' : metric.unit}
                    </td>
                    <td>
                      {format(metric.after, 2)} {metric.id === 'defectPct' ? '%' : metric.unit}
                    </td>
                    <td>
                      {metric.delta === null || metric.delta === undefined
                        ? 'Не определена'
                        : `${metric.delta > 0 ? '+' : ''}${format(metric.delta, 2)} ${metric.unit}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row-actions">
            <Button onClick={() => onEvidence(result.sourceIds)}>Проверить исходные записи</Button>
            <span>Версия данных {dataset.version}</span>
          </div>
          <details className="decision-details" open>
            <summary>Как трактовать результат</summary>
            {metrics
              .filter((metric) => metric.detail)
              .map((metric) => (
                <p key={metric.id}>
                  <strong>{metricLabels[metric.id]}: </strong>
                  {metric.detail}
                </p>
              ))}
            {(result.warnings || result.limitations || []).map((item, i) => (
              <p key={i}>{item}</p>
            ))}
          </details>
        </div>
      )}
    </section>
  );
}

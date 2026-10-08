import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api, downloadJson, format } from './api.js';
import { Button, ErrorBox, Field, Loading, useResource } from './ui.jsx';
import { Icon } from './icons.jsx';
import './decision-center.css';
import { openWorkflow, takeWorkflow, consumeWorkflow } from './workflow.js';
import PilotReview from './PilotReview.jsx';
const ForecastValidation = lazy(() => import('./ForecastValidation.jsx'));

const views = [
  { id: 'forecast', name: 'Прогноз' },
  { id: 'validation', name: 'Проверка прогноза' },
  { id: 'impact', name: 'Эффект решения' },
  { id: 'pilot', name: 'Проверка результата' }
];
const metrics = [
  { id: 'output', name: 'Выпуск', unit: 'шт.' },
  { id: 'quality', name: 'Доля брака', unit: '%' },
  { id: 'downtime', name: 'Простой оборудования', unit: 'мин' }
];

export default function DecisionCenter({ dataset, notify, onEvidence, selectedDate, canWrite }) {
  const normalizedDataset = {
    ...dataset.data,
    id: dataset.id,
    version: dataset.version,
    seed: dataset.seed
  };
  return (
    <DecisionWorkspace
      key={`${dataset.id}:${dataset.version}`}
      dataset={normalizedDataset}
      notify={notify}
      onEvidence={onEvidence}
      selectedDate={selectedDate}
      canWrite={canWrite}
    />
  );
}

function DecisionWorkspace({ dataset, notify, onEvidence, selectedDate, canWrite }) {
  const [handoff] = useState(() => takeWorkflow('decisions', dataset.id));
  useEffect(() => consumeWorkflow('decisions', handoff), [handoff]);
  const [view, setView] = useState(handoff?.view || 'forecast');
  const tabList = useRef(null);
  function moveTab(event) {
    const position = views.findIndex((item) => item.id === view);
    const index =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? views.length - 1
          : event.key === 'ArrowRight'
            ? (position + 1) % views.length
            : event.key === 'ArrowLeft'
              ? (position + views.length - 1) % views.length
              : null;
    if (index === null) return;
    event.preventDefault();
    setView(views[index].id);
    tabList.current?.querySelectorAll('[role="tab"]')[index]?.focus();
  }
  return (
    <div className="decision-center">
      <header className="page-intro decision-intro">
        <div>
          <h2>Проверьте решение до внедрения.</h2>
          <p>Прогноз, резерв выпуска и проверяемая экономика.</p>
        </div>
        <span className="decision-version">Версия данных {dataset.version}</span>
      </header>
      <div
        className="decision-tabs"
        role="tablist"
        aria-label="Риски и эффект"
        ref={tabList}
        onKeyDown={moveTab}
      >
        {views.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`decision-tab-${item.id}`}
            aria-controls={`decision-panel-${item.id}`}
            aria-selected={view === item.id}
            tabIndex={view === item.id ? 0 : -1}
            onClick={() => setView(item.id)}
          >
            {item.name}
          </button>
        ))}
      </div>
      <section
        id="decision-panel-forecast"
        role="tabpanel"
        aria-labelledby="decision-tab-forecast"
        hidden={view !== 'forecast'}
        tabIndex={0}
      >
        <ForecastPanel dataset={dataset} onEvidence={onEvidence} canWrite={canWrite} />
      </section>
      <section
        id="decision-panel-validation"
        role="tabpanel"
        aria-labelledby="decision-tab-validation"
        hidden={view !== 'validation'}
        tabIndex={0}
      >
        {view === 'validation' && (
          <Suspense fallback={<Loading />}>
            <ForecastValidation dataset={dataset} />
          </Suspense>
        )}
      </section>
      <section
        id="decision-panel-impact"
        role="tabpanel"
        aria-labelledby="decision-tab-impact"
        hidden={view !== 'impact'}
        tabIndex={0}
      >
        <ImpactPanel
          dataset={dataset}
          notify={notify}
          onEvidence={onEvidence}
          handoff={handoff}
          selectedDate={selectedDate}
          canWrite={canWrite}
        />
      </section>
      <section
        id="decision-panel-pilot"
        role="tabpanel"
        aria-labelledby="decision-tab-pilot"
        hidden={view !== 'pilot'}
        tabIndex={0}
      >
        <PilotReview dataset={dataset} onEvidence={onEvidence} />
      </section>
    </div>
  );
}

function ForecastPanel({ dataset, onEvidence, canWrite }) {
  const [revision, revise] = useState(0);
  const resource = useResource(
    `/forecast/${encodeURIComponent(dataset.id)}`,
    `${dataset.version}:${revision}`
  );
  const [selectedStage, selectStage] = useState('');
  const [metricId, selectMetric] = useState('output');
  const forecast = resource.data;
  const measuredStages =
    forecast?.stages.filter((item) =>
      metrics.some((entry) => item[entry.id].observationCount > 0)
    ) || [];
  const stage =
    measuredStages.find((item) => item.stageId === selectedStage) ||
    measuredStages.find((item) => item.stageId === forecast?.summary.bottleneckStageId) ||
    measuredStages[0];
  const metric = stage?.[metricId];
  const metricInfo = metrics.find((item) => item.id === metricId);
  if (resource.loading) return <Loading label="Проверяем историю и прогнозы по участкам…" />;
  if (!forecast)
    return (
      <div className="decision-unavailable">
        <ErrorBox>{resource.error}</ErrorBox>
        <Button onClick={() => revise((value) => value + 1)}>Повторить загрузку</Button>
      </div>
    );
  if (forecast.datasetVersion !== dataset.version)
    return <Loading label="Данные изменились. Синхронизируем прогноз с новой версией…" />;
  return (
    <>
      <ErrorBox>{resource.error}</ErrorBox>
      <div className="decision-readiness">
        <div className={`decision-state ${forecast.readiness.status}`}>
          <Icon name={forecast.readiness.status === 'backtested' ? 'check' : 'source'} size={20} />
          <strong>{forecast.readiness.label}</strong>
        </div>
        <span>Дат наблюдения: {format(forecast.observationCount)}</span>
        <details className="decision-readiness-details">
          <summary>Основание оценки</summary>
          <p>{forecast.readiness.detail}</p>
        </details>
      </div>
      {stage ? (
        <div className="decision-forecast-layout">
          <nav className="decision-stage-list" aria-label="Участок для прогноза">
            {measuredStages.map((item) => (
              <button
                type="button"
                key={item.stageId}
                aria-pressed={stage.stageId === item.stageId}
                onClick={() => selectStage(item.stageId)}
              >
                <span className="decision-stage-name">{item.name}</span>
                <span className="decision-stage-reading">
                  {format(item.nextOutput, 1)} <small>шт.</small>
                </span>
                <span className="decision-stage-caption">Ориентир выпуска</span>
                {item.risks.length > 0 && (
                  <span className="decision-stage-risk">
                    Сигналов для проверки: {item.risks.length}
                  </span>
                )}
                <Icon name="arrow" size={17} />
              </button>
            ))}
          </nav>
          <div className="decision-forecast-detail">
            <div className="decision-section-heading">
              <div>
                <h3>{stage.name}</h3>
                <p>{forecast.periodLabel}</p>
              </div>
              <button
                type="button"
                className="text-button"
                onClick={() => onEvidence(stage.sourceIds)}
              >
                Исходные записи <Icon name="source" size={16} />
              </button>
            </div>
            <div className="decision-metric-switch" aria-label="Показатель прогноза">
              {metrics.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={metricId === item.id}
                  onClick={() => selectMetric(item.id)}
                >
                  <span>{item.name}</span>
                  <strong>
                    {format(stage[item.id]?.estimate, item.id === 'quality' ? 2 : 1)}{' '}
                    <small>{item.unit}</small>
                  </strong>
                </button>
              ))}
            </div>
            {metric && (
              <>
                <ForecastChart
                  metric={metric}
                  title={`${stage.name}: ${metricInfo.name}`}
                  unit={metricInfo.unit}
                />
                <div className="decision-chart-key">
                  <span className="observed">Записи в наборе</span>
                  {metric.validation.backtest.length > 0 && (
                    <span className="backtested">Проверочные прогнозы</span>
                  )}
                  <span className="estimated">Ориентир следующего периода</span>
                </div>
                <p className="decision-scope">{metric.scope}</p>
                {stage.regime?.label && <p className="decision-scope">{stage.regime.label}</p>}
                {metric.diagnostics && (
                  <details className="decision-details">
                    <summary>Полнота и устойчивость наблюдений</summary>
                    <p>
                      Покрытие ожидаемых дат: {format(metric.diagnostics.observedCoveragePct, 1)}%.
                      Последнее наблюдение:{' '}
                      {metric.diagnostics.lastObservedDate
                        ? shortDate(metric.diagnostics.lastObservedDate)
                        : '—'}
                      .
                    </p>
                    {metric.diagnostics.irregularSpacing && (
                      <p>
                        Интервалы между записями неодинаковы. Максимальный разрыв:{' '}
                        {metric.diagnostics.maxCalendarGapDays} дн.
                      </p>
                    )}
                    <p>{metric.diagnostics.drift?.label}</p>
                    <p>{metric.diagnostics.intervalCoverage?.label}</p>
                  </details>
                )}
                <div className="decision-validation">
                  <div>
                    <span>Метод</span>
                    <strong>{metric.methodLabel}</strong>
                  </div>
                  <div>
                    <span>Проверки на прошлых периодах</span>
                    <strong>{format(metric.validation.folds)}</strong>
                  </div>
                  <div>
                    <span>Средняя абсолютная ошибка</span>
                    <strong>
                      {metric.validation.mae === null
                        ? 'Пока не оценена'
                        : `${format(metric.validation.mae, 2)} ${metricInfo.unit}`}
                    </strong>
                  </div>
                </div>
                <details className="decision-details">
                  <summary>Как проверяется прогноз</summary>
                  <p>{forecast.validation.label}</p>
                  <p>
                    Каждый проверочный прогноз использует только предшествующие записи. Будущие
                    значения не участвуют в его расчёте.
                  </p>
                  {metric.validation.baselineMae !== null && (
                    <p>
                      Ошибка простого ориентира по предыдущему периоду:{' '}
                      {format(metric.validation.baselineMae, 2)} {metricInfo.unit}.
                    </p>
                  )}
                  {metric.validation.improvementPct !== null && (
                    <p>
                      Снижение ошибки относительно этого ориентира:{' '}
                      {format(metric.validation.improvementPct, 1)}%. Отрицательное значение
                      означает большую ошибку.
                    </p>
                  )}
                  {metric.range && (
                    <p>
                      {metric.range.label}: {format(metric.range.low, 2)}–
                      {format(metric.range.high, 2)} {metricInfo.unit}.
                    </p>
                  )}
                  {metric.missingDates.length > 0 && (
                    <p>
                      Без записи этого показателя: {metric.missingDates.length} дат. Пропуски не
                      заменяются нулями.
                    </p>
                  )}
                  {metric.validation.backtest.length > 0 && (
                    <div className="decision-table-scroll">
                      <table>
                        <caption>Последние проверки на истории</caption>
                        <thead>
                          <tr>
                            <th scope="col">Дата</th>
                            <th scope="col">Факт</th>
                            <th scope="col">Прогноз</th>
                            <th scope="col">Ошибка</th>
                          </tr>
                        </thead>
                        <tbody>
                          {metric.validation.backtest.slice(-5).map((item) => (
                            <tr key={item.date}>
                              <th scope="row">{shortDate(item.date)}</th>
                              <td>{format(item.actual, 2)}</td>
                              <td>{format(item.predicted, 2)}</td>
                              <td>{format(item.absoluteError, 2)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => onEvidence(metric.sourceIds)}
                  >
                    Проверить записи показателя <Icon name="arrow" size={14} />
                  </button>
                </details>
              </>
            )}
            {stage.risks.length > 0 && (
              <section className="decision-signals" aria-label="Сигналы участка">
                {stage.risks.map((risk, index) => (
                  <article key={`${risk.kind}:${index}`}>
                    <Icon name="incident" size={19} />
                    <div>
                      <h4>{risk.title}</h4>
                      <p>{risk.detail}</p>
                      <div className="row-actions">
                        <Button
                          onClick={() =>
                            openWorkflow('target', {
                              datasetId: dataset.id,
                              datasetVersion: dataset.version,
                              stageId: stage.stageId
                            })
                          }
                        >
                          Найти план
                        </Button>
                        <Button
                          disabled={!canWrite}
                          onClick={() =>
                            openWorkflow('incidents', {
                              datasetId: dataset.id,
                              stageId: stage.stageId,
                              title: risk.title,
                              description: `${risk.detail} Источники: ${risk.sourceIds.join(', ')}`
                            })
                          }
                        >
                          Создать задачу
                        </Button>
                      </div>
                      {risk.sourceIds.length > 0 && (
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => onEvidence(risk.sourceIds)}
                        >
                          Проверить основание
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </section>
            )}
            {stage.equipment.length > 0 && (
              <details className="decision-details">
                <summary>Простои по оборудованию · {stage.equipment.length}</summary>
                <p>
                  Условный ориентир на период с зарегистрированным простоем. Отсутствие события не
                  подтверждает безотказную работу.
                </p>
                <div className="decision-equipment-list">
                  {stage.equipment.map((item) => (
                    <button
                      key={item.name}
                      type="button"
                      onClick={() => onEvidence(item.metric.sourceIds)}
                    >
                      <span>{item.name}</span>
                      <strong>{format(item.nextDowntimeMinutes, 1)} мин</strong>
                      <Icon name="source" size={16} />
                    </button>
                  ))}
                </div>
              </details>
            )}
          </div>
        </div>
      ) : (
        <div className="decision-unavailable">
          <h3>Нужны производственные записи</h3>
          <p>Добавьте даты, участки и фактический выпуск в разделе «Данные».</p>
          <a className="button" href="#/app/data">
            Открыть данные
          </a>
        </div>
      )}
      <section className="decision-evidence-gaps">
        <div>
          <h3>Следующий шаг к пилоту</h3>
          <p>{forecast.summary.text}</p>
        </div>
        <ol>
          {forecast.dataPriorities.map((item) => (
            <li key={item.id}>
              <h4>{item.title}</h4>
              <p>{item.detail}</p>
            </li>
          ))}
        </ol>
      </section>
      <details className="decision-details decision-limitations">
        <summary>Границы прогноза</summary>
        {forecast.limitations.map((item) => (
          <p key={item}>{item}</p>
        ))}
      </details>
    </>
  );
}

function ForecastChart({ metric, title, unit }) {
  const points = metric.points.filter((point) => Number.isFinite(point.value)).slice(-16);
  const estimate = Number.isFinite(metric.estimate) ? metric.estimate : null;
  if (!points.length)
    return (
      <div className="decision-chart-empty">Нет сопоставимых записей для этого показателя.</div>
    );
  const backtestPoints = points
    .map((point, index) => ({
      index,
      value: metric.validation.backtest.find((item) => item.date === point.date)?.predicted
    }))
    .filter((point) => Number.isFinite(point.value));
  const values = points
    .map((point) => point.value)
    .concat(
      backtestPoints.map((point) => point.value),
      estimate === null ? [] : [estimate]
    );
  const top = Math.max(...values) || 1;
  const low = Math.min(...values);
  const spread = Math.max(top - low, top * 0.15, 1);
  const floor = Math.max(0, low - spread * 0.35);
  const ceiling = top + spread * 0.4;
  const x = (index) => 48 + index * (548 / Math.max(points.length, 1));
  const y = (value) => 172 - ((value - floor) / (ceiling - floor)) * 130;
  const line = points.map((point, index) => `${x(index)},${y(point.value)}`).join(' ');
  const last = points[points.length - 1];
  return (
    <figure className="decision-chart">
      <svg
        viewBox="0 0 650 216"
        role="img"
        aria-label={`${title}. ${points.length} записей; следующий ориентир ${format(estimate, 2)} ${unit}.`}
      >
        {[0, 0.5, 1].map((fraction) => {
          const value = floor + (ceiling - floor) * fraction;
          return (
            <g key={fraction}>
              <line x1="48" y1={y(value)} x2="615" y2={y(value)} className="decision-chart-grid" />
              <text x="38" y={y(value) + 4} textAnchor="end" className="decision-chart-axis">
                {format(value, 1)}
              </text>
            </g>
          );
        })}
        <polyline points={line} fill="none" className="decision-chart-history" />
        {backtestPoints.length > 0 && (
          <polyline
            points={backtestPoints.map((point) => `${x(point.index)},${y(point.value)}`).join(' ')}
            fill="none"
            className="decision-chart-backtest"
          />
        )}
        {points.map((point, index) => (
          <g key={`${point.date}:${index}`}>
            <circle cx={x(index)} cy={y(point.value)} r="4" className="decision-chart-dot">
              <title>
                {point.date}: {format(point.value, 2)} {unit}
              </title>
            </circle>
            {points.length <= 6 && (
              <text
                x={x(index)}
                y={y(point.value) - 12}
                textAnchor="middle"
                className="decision-chart-value"
              >
                {format(point.value, 1)}
              </text>
            )}
          </g>
        ))}
        {estimate !== null && (
          <>
            <line
              x1={x(points.length - 1)}
              y1={y(last.value)}
              x2={x(points.length)}
              y2={y(estimate)}
              className="decision-chart-projection"
            />
            <circle cx={x(points.length)} cy={y(estimate)} r="6" className="decision-chart-next" />
            <text
              x={x(points.length)}
              y={y(estimate) - 14}
              textAnchor="middle"
              className="decision-chart-estimate"
            >
              {format(estimate, 1)}
            </text>
            <text x={x(points.length)} y="200" textAnchor="middle" className="decision-chart-axis">
              Следующий
            </text>
          </>
        )}
        <text x="48" y="200" className="decision-chart-axis">
          {shortDate(points[0].date)}
        </text>
        {points.length > 1 && (
          <text
            x={x(points.length - 1)}
            y="200"
            textAnchor="middle"
            className="decision-chart-axis"
          >
            {shortDate(last.date)}
          </text>
        )}
      </svg>
      <figcaption>
        {metric.range?.label || metric.label}
        {metric.observationCount > points.length
          ? `. Показаны последние ${points.length} из ${metric.observationCount} наблюдений.`
          : ''}
      </figcaption>
    </figure>
  );
}

function shortDate(value) {
  const parts = String(value).split('-');
  return parts.length === 3 ? `${parts[2]}.${parts[1]}` : value;
}

function ImpactPanel({ dataset, notify, onEvidence, handoff, selectedDate, canWrite }) {
  const [calculationDate, setCalculationDate] = useState(handoff?.date || selectedDate || '');
  const [saving, setSaving] = useState(false);
  const [hours, setHours] = useState(handoff?.hours || dataset.targets?.hoursPerShift || 8);
  const [observationHours, setObservationHours] = useState(
    handoff?.observationHours || dataset.targets?.hoursPerShift || 8
  );
  const [target, setTarget] = useState('');
  const [realization, setRealization] = useState(100);
  const [periods, setPeriods] = useState('1');
  const [contribution, setContribution] = useState('');
  const [cost, setCost] = useState('');
  const [recurring, setRecurring] = useState('0'),
    [salesCap, setSalesCap] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [initialized, setInitialized] = useState(false);
  const initialHours = useRef(hours);
  const requestInput = useRef(null);
  const valid =
    Number(target) > 0 &&
    Number(target) <= 1000000 &&
    Number(periods) >= 1 &&
    Number(periods) <= 366 &&
    Number.isInteger(Number(periods)) &&
    (contribution === '' || (Number(contribution) >= 0 && Number(contribution) <= 1e12)) &&
    (cost === '' || (Number(cost) >= 0 && Number(cost) <= 1e12)) &&
    Number(recurring) >= 0 &&
    Number(recurring) <= 1e12 &&
    (salesCap === '' || (Number(salesCap) >= 0 && Number(salesCap) <= 1e6));

  useEffect(() => {
    if (initialized) return;
    const controller = new AbortController();
    let active = true;
    setBusy(true);
    setError('');
    api(
      '/impact',
      'POST',
      {
        datasetId: dataset.id,
        expectedDatasetVersion: dataset.version,
        hours,
        observationHours,
        targetGoodOutput: 1,
        ...(calculationDate ? { date: calculationDate } : {})
      },
      controller.signal
    )
      .then((response) => {
        if (!active) return;
        const possibleWholeTarget = handoff?.targetGoodOutput || Math.floor(response.maxOutput);
        setTarget(
          String(
            possibleWholeTarget > response.baselineOutput
              ? possibleWholeTarget
              : Number(response.baselineOutput.toFixed(4))
          )
        );
        setInitialized(true);
      })
      .catch((failure) => {
        if (active) {
          setError(failure.message);
          setBusy(false);
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [dataset.id, dataset.version, initialized, retry, hours, observationHours, calculationDate]);

  useEffect(() => {
    if (!initialized) return;
    if (!valid) {
      setBusy(false);
      return;
    }
    const controller = new AbortController();
    let active = true;
    setBusy(true);
    setError('');
    const input = {
      datasetId: dataset.id,
      expectedDatasetVersion: dataset.version,
      hours,
      observationHours,
      targetGoodOutput: Number(target),
      ...(calculationDate ? { date: calculationDate } : {}),
      realizationPct: realization,
      periods: Number(periods),
      unitContribution: contribution === '' ? null : Number(contribution),
      implementationCost: cost === '' ? null : Number(cost),
      recurringCostPerPeriod: Number(recurring),
      maxAdditionalSalesPerPeriod: salesCap === '' ? null : Number(salesCap)
    };
    const timer = setTimeout(() => {
      api('/impact', 'POST', input, controller.signal)
        .then((response) => {
          if (!active) return;
          requestInput.current = input;
          setResult(response);
          setBusy(false);
        })
        .catch((failure) => {
          if (active) {
            setError(failure.message);
            setBusy(false);
          }
        });
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    dataset.id,
    dataset.version,
    initialized,
    calculationDate,
    hours,
    observationHours,
    target,
    realization,
    periods,
    contribution,
    cost,
    recurring,
    salesCap,
    retry,
    valid
  ]);

  function exportCalculation() {
    if (!result || busy || !valid || error) return;
    downloadJson(
      { datasetName: dataset.name, input: requestInput.current, result },
      `qarqyn-impact-v${dataset.version}.json`
    );
    notify?.('Файл расчёта подготовлен с исходными условиями и версией данных');
  }
  return (
    <div className="decision-impact-layout">
      <form
        className="decision-impact-form"
        onSubmit={(event) => {
          event.preventDefault();
          setRetry((value) => value + 1);
        }}
      >
        <h3>Условия решения</h3>
        <Field label="Наблюдения для расчёта">
          <select
            value={calculationDate}
            onChange={(event) => setCalculationDate(event.target.value)}
          >
            <option value="">Все наблюдения</option>
            {[...new Set(dataset.production.map((row) => row.date))].sort().map((date) => (
              <option key={date} value={date}>
                {date}
              </option>
            ))}
          </select>
        </Field>
        <p>Начальная цель рассчитана из доступного резерва. Измените её под свою задачу.</p>
        <div className="decision-field-pair">
          <Field label="Горизонт расчёта">
            <select value={hours} onChange={(event) => setHours(Number(event.target.value))}>
              {[...new Set([8, 12, 16, 24, 40, 160, initialHours.current])]
                .sort((a, b) => a - b)
                .map((value) => (
                  <option key={value} value={value}>
                    {value} часов
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Период записи" hint="Допущение о длительности строки">
            <select
              value={observationHours}
              onChange={(event) => setObservationHours(Number(event.target.value))}
            >
              {[...new Set([8, 12, 16, 24, dataset.targets.hoursPerShift, observationHours])]
                .sort((a, b) => a - b)
                .map((value) => (
                  <option key={value} value={value}>
                    {value} часов
                  </option>
                ))}
            </select>
          </Field>
        </div>
        <Field label="Целевой годный выпуск, шт.">
          <input
            className="decision-target-input"
            type="number"
            min="0.0001"
            max="1000000"
            step="any"
            required
            value={target}
            disabled={!initialized}
            onChange={(event) => setTarget(event.target.value)}
          />
        </Field>
        <Field
          label={
            <span>
              Реализация плана <strong>{realization}%</strong>
            </span>
          }
          hint="Какая доля найденного сокращения простоев будет достигнута"
        >
          <input
            type="range"
            min="0"
            max="100"
            step="5"
            value={realization}
            disabled={!initialized}
            onChange={(event) => setRealization(Number(event.target.value))}
            aria-label="Реализация плана, процентов"
          />
        </Field>
        <div className="decision-range-labels">
          <span>Без изменений</span>
          <span>Полный план</span>
        </div>
        <Field
          label="Число повторений горизонта"
          hint="Одинаковые условия; сезонность не моделируется"
        >
          <input
            type="number"
            min="1"
            max="366"
            step="1"
            required
            value={periods}
            disabled={!initialized}
            onChange={(event) => setPeriods(event.target.value)}
          />
        </Field>
        <details className="decision-finance-inputs">
          <summary>Добавить экономику в тенге</summary>
          <p>Укажите согласованные значения. Без них денежный эффект не рассчитывается.</p>
          <Field
            label="Маржинальный доход с дополнительного авто, ₸"
            hint="Выручка за вычетом переменных затрат"
          >
            <input
              type="number"
              min="0"
              max="1000000000000"
              step="any"
              inputMode="decimal"
              value={contribution}
              onChange={(event) => setContribution(event.target.value)}
            />
          </Field>
          <Field label="Единовременные затраты на реализацию, ₸" hint="Разовая стоимость проекта">
            <input
              type="number"
              min="0"
              max="1000000000000"
              step="any"
              inputMode="decimal"
              value={cost}
              onChange={(event) => setCost(event.target.value)}
            />
          </Field>
          <Field
            label="Дополнительные расходы за период, ₸"
            hint="Ноль означает выбранное допущение об отсутствии новых регулярных расходов"
          >
            <input
              type="number"
              min="0"
              max="1000000000000"
              step="any"
              value={recurring}
              onChange={(event) => setRecurring(event.target.value)}
            />
          </Field>
          <Field
            label="Подтверждённый дополнительный спрос за период, шт."
            hint="Пусто: ограничение спроса не задано"
          >
            <input
              type="number"
              min="0"
              max="1000000"
              step="any"
              value={salesCap}
              onChange={(event) => setSalesCap(event.target.value)}
            />
          </Field>
        </details>
        {!valid && initialized && (
          <p className="decision-input-error" role="alert">
            Укажите положительную цель, от 1 до 366 периодов и неотрицательные суммы.
          </p>
        )}
        <Button type="submit" disabled={!initialized || !valid || busy}>
          Пересчитать
        </Button>
      </form>
      <div className="decision-impact-result" aria-busy={busy}>
        <ErrorBox>{error}</ErrorBox>
        {error && <Button onClick={() => setRetry((value) => value + 1)}>Повторить расчёт</Button>}
        {!result && busy && <Loading label="Находим резерв без отмены планового обслуживания…" />}
        {result && (
          <>
            <div className="decision-result-status" role="status">
              {busy
                ? 'Пересчитываем условия…'
                : !valid || error
                  ? 'Ниже показан предыдущий расчёт'
                  : 'Расчёт обновлён'}
            </div>
            <div className="decision-section-heading">
              <div>
                <h3>
                  {result.achievable ? 'Путь к выпуску найден' : 'Цель выше доступного резерва'}
                </h3>
                <p>
                  {result.achievable
                    ? 'Качество неизменно. Плановое обслуживание сохранено.'
                    : `При текущих ограничениях модель допускает ${format(result.maxOutput, 2)} шт. за ${result.hours} ч.`}
                </p>
              </div>
            </div>
            {result.achievable ? (
              <>
                <OutputComparison result={result} />
                <div className="decision-impact-reading">
                  <span>Дополнительный выпуск за {periodCount(result.periods)}</span>
                  <strong>
                    {result.totalGain > 0 ? '+' : ''}
                    {format(result.totalGain, 2)} <small>шт.</small>
                  </strong>
                  <p>При реализации {format(result.realizationPct)}% доступного плана.</p>
                </div>
              </>
            ) : (
              <div className="decision-unattainable">
                <Icon name="incident" size={24} />
                <div>
                  <h4>Нужны другие изменения</h4>
                  <p>{result.reason}</p>
                  <p>
                    Уменьшите цель до доступного выпуска или проверьте качество и производительность
                    в разделе «Сценарии».
                  </p>
                </div>
              </div>
            )}
            <section className="decision-interventions" aria-label="Действия по участкам">
              <h4>Что нужно изменить</h4>
              {result.interventions.length ? (
                result.interventions.map((item) => (
                  <div key={item.stageId}>
                    <span>
                      <strong>{item.stageName}</strong>
                      <small>
                        Плановое ТО сохранено: {format(item.protectedMaintenanceMinutes, 1)} мин
                      </small>
                    </span>
                    <span>
                      <strong>{format(item.realizedRecoverMinutes, 2)} мин</strong>
                      <small>из {format(item.recoverMinutes, 2)} мин по плану</small>
                    </span>
                    <button
                      type="button"
                      className="decision-source-button"
                      title={`Источники: ${item.stageName}`}
                      aria-label={`Источники: ${item.stageName}`}
                      onClick={() => onEvidence(item.sourceIds)}
                    >
                      <Icon name="source" size={18} />
                    </button>
                  </div>
                ))
              ) : (
                <p>
                  {result.achievable
                    ? 'Для этой цели сокращение простоев не требуется.'
                    : 'Достижимый план для указанной цели не найден.'}
                </p>
              )}
            </section>
            {result.achievable && <Sensitivity result={result} />}
            <Economics economics={result.economics} periods={result.periods} />
            <div className="decision-result-actions">
              <Button
                disabled={
                  !canWrite || busy || !valid || Boolean(error) || !result.simulationInput || saving
                }
                onClick={async () => {
                  setSaving(true);
                  setError('');
                  try {
                    await api('/scenarios', 'POST', {
                      name: `Выпуск ${format(result.targetOutput, 2)} за ${result.hours} ч`,
                      note: `Проверка эффекта: реализация ${result.realizationPct}%; расчёт ${result.modelVersion}.`,
                      input: {
                        ...result.simulationInput,
                        interventions: result.simulationInput.interventions.map((item) => ({
                          ...item,
                          recoverMinutes: (item.recoverMinutes * result.realizationPct) / 100
                        }))
                      },
                      expectedDatasetVersion: dataset.version
                    });
                    notify?.('Решение сохранено в сценариях');
                  } catch (failure) {
                    setError(failure.message);
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                {saving ? 'Сохраняем…' : 'Сохранить сценарий'}
              </Button>
              <Button
                disabled={!canWrite || busy || !valid || Boolean(error)}
                onClick={() =>
                  openWorkflow('incidents', {
                    datasetId: dataset.id,
                    stageId: result.bottleneck?.stageId || null,
                    title: `Проверить план выпуска ${format(result.targetOutput, 2)}`,
                    description: `Версия данных ${dataset.version}. Горизонт ${result.hours} ч; период наблюдения ${result.observationHours} ч; дата ${calculationDate || 'все'}. Условия: ${result.interventions.map((item) => `${item.stageName}: вернуть ${format(item.realizedRecoverMinutes, 2)} мин`).join('; ')}. Расчётный дополнительный выпуск ${format(result.totalGain, 2)} шт. Требуется проверка фактического результата.`
                  })
                }
              >
                Создать задачу
              </Button>
              <Button
                icon="download"
                disabled={busy || !valid || Boolean(error)}
                onClick={exportCalculation}
              >
                Скачать расчёт
              </Button>
              <button
                type="button"
                className="text-button"
                onClick={() => onEvidence(result.sourceIds)}
              >
                Исходные записи <Icon name="source" size={16} />
              </button>
            </div>
            <details className="decision-details">
              <summary>Допущения и условия внедрения</summary>
              {result.assumptions.map((item) => (
                <p key={item}>{item}</p>
              ))}
            </details>
          </>
        )}
      </div>
    </div>
  );
}

function OutputComparison({ result }) {
  const maximum = Math.max(
    result.baselineOutput,
    result.plannedOutput,
    result.realizedOutput,
    result.targetOutput,
    1
  );
  return (
    <div className="decision-output-comparison" aria-label="Сравнение выпуска">
      {[
        { name: 'Без изменений', value: result.baselineOutput, className: 'baseline' },
        { name: 'Полный план', value: result.plannedOutput, className: 'planned' },
        {
          name: `При реализации ${format(result.realizationPct)}%`,
          value: result.realizedOutput,
          className: 'realized'
        }
      ].map((item) => (
        <div key={item.className} className={item.className}>
          <span>{item.name}</span>
          <div>
            <i style={{ transform: `scaleX(${Math.max(0, item.value / maximum)})` }} />
          </div>
          <strong>
            {format(item.value, 2)} <small>шт.</small>
          </strong>
        </div>
      ))}
    </div>
  );
}

function Sensitivity({ result }) {
  return (
    <section className="decision-sensitivity">
      <h4>Если удастся меньше запланированного</h4>
      <p>Выпуск пересчитан для каждой доли восстановленного времени.</p>
      <div className="decision-table-scroll">
        <table>
          <caption className="sr-only">Чувствительность эффекта к реализации плана</caption>
          <thead>
            <tr>
              <th scope="col">Реализация</th>
              <th scope="col">Выпуск, шт.</th>
              <th scope="col">Прирост за {periodCount(result.periods)}</th>
              {result.economics.netContribution !== null && <th scope="col">Эффект, ₸</th>}
            </tr>
          </thead>
          <tbody>
            {result.sensitivity.map((item) => (
              <tr
                key={item.realizationPct}
                className={item.realizationPct === result.realizationPct ? 'selected' : ''}
              >
                <th scope="row">{format(item.realizationPct)}%</th>
                <td>{format(item.output, 2)}</td>
                <td>
                  {item.totalGain > 0 ? '+' : ''}
                  {format(item.totalGain, 2)}
                </td>
                {result.economics.netContribution !== null && (
                  <td>{format(item.netContribution)}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Economics({ economics, periods }) {
  if (economics.status === 'unattainable')
    return (
      <div className="decision-economics-empty">
        <Icon name="source" size={20} />
        <div>
          <h4>Экономика недостижимого плана не рассчитывается</h4>
          <p>Сначала выберите цель в пределах доступного резерва.</p>
        </div>
      </div>
    );
  if (economics.status === 'missing_inputs')
    return (
      <div className="decision-economics-empty">
        <Icon name="source" size={20} />
        <div>
          <h4>Денежный эффект требует ваших данных</h4>
          <p>
            Добавьте маржинальный доход и затраты в условиях решения. Производственный расчёт уже
            доступен.
          </p>
        </div>
      </div>
    );
  return (
    <section className={`decision-economics ${economics.status}`}>
      <h4>Расчётная экономика за {periodCount(periods)}</h4>
      <dl>
        <div>
          <dt>Дополнительный маржинальный доход</dt>
          <dd>{format(economics.grossContribution)} ₸</dd>
        </div>
        <div>
          <dt>Затраты на реализацию</dt>
          <dd>{format(economics.implementationCost)} ₸</dd>
        </div>
        <div>
          <dt>Регулярные расходы за все периоды</dt>
          <dd>{format(economics.recurringCost)} ₸</dd>
        </div>
        <div>
          <dt>Дополнительный выпуск, учтённый в продажах</dt>
          <dd>{format(economics.soldAdditionalUnits, 2)} шт.</dd>
        </div>
        <div className="decision-net-effect">
          <dt>Эффект после затрат</dt>
          <dd>{format(economics.netContribution)} ₸</dd>
        </div>
        <div>
          <dt>Для покрытия затрат нужно</dt>
          <dd>
            {economics.breakEvenUnits === null
              ? 'Нет положительной маржи'
              : `${format(economics.breakEvenUnits, 2)} дополнительных авто`}
          </dd>
        </div>
        <div>
          <dt>Периодов до покрытия затрат</dt>
          <dd>
            {economics.breakEvenPeriods === null
              ? 'Не определяется при текущем приросте'
              : format(economics.breakEvenPeriods, 2)}
          </dd>
        </div>
      </dl>
      <p>По введённым условиям. Расчётный выпуск не подтверждает продажи или эффект пилота.</p>
    </section>
  );
}

function periodCount(value) {
  const form = new Intl.PluralRules('ru-RU').select(value);
  const unit = form === 'one' ? 'период' : form === 'few' ? 'периода' : 'периодов';
  return `${format(value)} ${unit}`;
}

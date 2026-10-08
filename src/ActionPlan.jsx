import { useEffect, useRef, useState } from 'react';
import { api, downloadJson, format } from './api.js';
import {
  Button,
  Confirm,
  Empty,
  ErrorBox,
  Field,
  Loading,
  Pagination,
  useResource
} from './ui.jsx';
import './action-plan.css';
import { consumeWorkflow, takeWorkflow } from './workflow.js';

const optionalNumber = (value) => (value === '' || value === null ? null : Number(value));

function initialInput(dataset, selectedDate, handoff) {
  const context = handoff?.datasetId === dataset.id ? handoff : null;
  return {
    datasetId: dataset.id,
    expectedDatasetVersion: dataset.version,
    hours: context?.hours || dataset.data.targets.hoursPerShift,
    observationHours: context?.observationHours || dataset.data.targets.hoursPerShift,
    ...(context?.date || selectedDate ? { date: context?.date || selectedDate } : {}),
    status: 'draft',
    targetGoodOutput: context?.requestedTarget || null,
    actions: [],
    realizationPct: 100,
    periods: 1,
    unitContribution: null,
    maxAdditionalSalesPerPeriod: null,
    economicEvidence: ''
  };
}

function toRequest(input) {
  return {
    ...input,
    hours: Number(input.hours),
    observationHours: Number(input.observationHours),
    realizationPct: Number(input.realizationPct),
    periods: Number(input.periods),
    unitContribution: optionalNumber(input.unitContribution),
    maxAdditionalSalesPerPeriod: optionalNumber(input.maxAdditionalSalesPerPeriod),
    targetGoodOutput: optionalNumber(input.targetGoodOutput),
    actions: input.actions.map((action) => ({
      ...action,
      dueDate: action.dueDate || null,
      expectedRecoveredMinutes: Number(action.expectedRecoveredMinutes),
      confidencePct: Number(action.confidencePct),
      oneOffCost: optionalNumber(action.oneOffCost),
      recurringCostPerPeriod: optionalNumber(action.recurringCostPerPeriod)
    }))
  };
}

export default function ActionPlan({ dataset, canWrite, notify, onEvidence, selectedDate }) {
  const [handoff] = useState(() => takeWorkflow('actions', dataset.id));
  useEffect(() => consumeWorkflow('actions', handoff), [handoff]);
  const [input, setInput] = useState(() => initialInput(dataset, selectedDate, handoff));
  const [candidates, setCandidates] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [active, setActive] = useState(null);
  const [reconfirmationRequired, setReconfirmationRequired] = useState(false);
  const [revision, revise] = useState(0);
  const [page, setPage] = useState(1);
  const [deleting, setDeleting] = useState(null);
  const generation = useRef(0);
  const saved = useResource(
    `/action-plans?datasetId=${dataset.id}&page=${page}&pageSize=10`,
    revision
  );
  const dates = [...new Set(dataset.data.production.map((row) => row.date))].sort();
  const transferredStages =
    !active &&
    handoff?.datasetId === dataset.id &&
    (handoff.date || '') === (input.date || '') &&
    handoff.hours === Number(input.hours) &&
    handoff.observationHours === Number(input.observationHours)
      ? handoff.suggestedStages || []
      : [];

  useEffect(() => {
    const controller = new AbortController();
    generation.current += 1;
    const next = initialInput(dataset, selectedDate, handoff);
    setInput(next);
    setResult(null);
    setCandidates([]);
    setActive(null);
    setReconfirmationRequired(false);
    setName('');
    setLoading(true);
    setError('');
    api('/action-plan/evaluate', 'POST', next, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) {
          setCandidates(response.candidates);
          setResult(response);
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [dataset.id, dataset.version, selectedDate, handoff]);

  function change(key, value) {
    generation.current += 1;
    setResult(null);
    setError('');
    setInput((old) => ({
      ...old,
      [key]: value,
      status: 'draft',
      ...(['hours', 'observationHours'].includes(key)
        ? { actions: old.actions.map((action) => ({ ...action, confirmed: false })) }
        : {})
    }));
  }

  function changeAction(eventId, key, value) {
    change(
      'actions',
      input.actions.map((action) =>
        action.eventId === eventId
          ? { ...action, [key]: value, ...(key !== 'confirmed' ? { confirmed: false } : {}) }
          : action
      )
    );
  }

  async function evaluate(event) {
    event?.preventDefault();
    const current = generation.current;
    setBusy(true);
    setError('');
    try {
      const response = await api('/action-plan/evaluate', 'POST', toRequest(input));
      if (current === generation.current) {
        setResult(response);
        setCandidates(response.candidates);
      }
    } catch (failure) {
      if (current === generation.current) setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError('');
    try {
      const payload = {
        name: name.trim(),
        input: result.input,
        expectedDatasetVersion: dataset.version
      };
      const entity = await api(
        active ? `/action-plans/${active.id}` : '/action-plans',
        active ? 'PUT' : 'POST',
        active ? { version: active.version, data: payload } : payload
      );
      setActive(entity);
      if (result.readiness.status === 'ready') setReconfirmationRequired(false);
      revise((value) => value + 1);
      notify?.('План мероприятий сохранён');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function load(entity) {
    setBusy(true);
    setError('');
    generation.current += 1;
    const current = generation.current;
    try {
      const changedDataset = entity.datasetVersion !== dataset.version;
      const next = {
        ...entity.input,
        expectedDatasetVersion: dataset.version,
        ...(changedDataset
          ? {
              status: 'draft',
              actions: entity.input.actions.map((action) => ({ ...action, confirmed: false }))
            }
          : {})
      };
      const recalculated = await api('/action-plan/evaluate', 'POST', next);
      if (current !== generation.current) return;
      setInput(next);
      setName(entity.name);
      setActive(entity);
      setResult(recalculated);
      setCandidates(recalculated.candidates);
      setReconfirmationRequired(changedDataset);
      if (changedDataset)
        notify?.(
          'Данные изменились. Прежние подтверждения сняты; инженер должен повторно проверить мероприятия.'
        );
    } catch (failure) {
      if (current === generation.current) setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function dispatch(entity) {
    setBusy(true);
    setError('');
    try {
      const response = await api(`/action-plans/${entity.id}/tasks`, 'POST', {
        version: entity.version,
        expectedDatasetVersion: dataset.version
      });
      notify?.(
        response.alreadyCreated
          ? 'Задачи этого плана уже созданы'
          : `Созданы задачи: ${response.count}`
      );
      revise((value) => value + 1);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="action-plan">
      <div className="page-intro">
        <div>
          <h2>От потерянных минут к конкретной работе</h2>
          <p>
            Выберите остановку, обоснуйте действие и проверьте эффект. Согласованный план
            превращается в задачи с ответственными и сроками.
          </p>
        </div>
        <span className="action-plan-version">Данные · версия {dataset.version}</span>
      </div>
      <ErrorBox>{error}</ErrorBox>
      {reconfirmationRequired && (
        <p className="action-plan-note" role="status">
          Набор данных изменился с момента сохранения плана. Прежние подтверждения сняты. Проверьте
          источники, минуты, расходы и заново подтвердите каждое мероприятие перед передачей в
          работу.
        </p>
      )}
      {loading ? (
        <Loading label="Находим зарегистрированные остановки…" />
      ) : (
        <form onSubmit={evaluate}>
          <fieldset disabled={busy} className="action-plan-fieldset">
            <div className="action-plan-scope">
              <Field label="Период исходных данных">
                <select
                  value={input.date || ''}
                  onChange={(event) => {
                    const value = event.target.value;
                    generation.current += 1;
                    setResult(null);
                    setInput(({ date, ...rest }) => ({
                      ...rest,
                      ...(value ? { date: value } : {}),
                      actions: []
                    }));
                    setActive(null);
                  }}
                >
                  <option value="">Все наблюдения</option>
                  {dates.map((date) => (
                    <option value={date} key={date}>
                      {date}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Горизонт расчёта, ч">
                <input
                  type="number"
                  min="1"
                  max="744"
                  required
                  value={input.hours}
                  onChange={(event) => change('hours', event.target.value)}
                />
              </Field>
              <Field label="Длительность исходной строки, ч">
                <input
                  type="number"
                  min="1"
                  max="24"
                  required
                  value={input.observationHours}
                  onChange={(event) => change('observationHours', event.target.value)}
                />
              </Field>
            </div>
            <section className="action-plan-events" aria-labelledby="action-events-title">
              <h3 id="action-events-title">На что можно повлиять</h3>
              <p>
                Минуты берутся из журнала. Плановое обслуживание и остановки без классификации
                защищены.
              </p>
              {candidates
                .filter((item) => !input.date || item.date === input.date)
                .map((item) => {
                  const selected = input.actions.some((action) => action.eventId === item.id);
                  return (
                    <div className="action-plan-event" key={item.id}>
                      <div>
                        <strong>
                          {item.equipment} <span>{item.stageName}</span>
                        </strong>
                        <p>
                          {item.reason} · {item.date}
                        </p>
                        {transferredStages.some((stage) => stage.stageId === item.stageId) && (
                          <small>
                            Для цели нужно вернуть{' '}
                            {format(
                              transferredStages.find((stage) => stage.stageId === item.stageId)
                                .recoverMinutes,
                              2
                            )}{' '}
                            мин на исходный период участка. Выберите и обоснуйте работу по
                            конкретной остановке.
                          </small>
                        )}
                        {item.exclusionReason && <small>{item.exclusionReason}</small>}
                      </div>
                      <span className="action-plan-minutes">{format(item.minutes)} мин</span>
                      <Button
                        type="button"
                        onClick={() => onEvidence?.([item.id])}
                        aria-label={`Исходная запись ${item.id}`}
                      >
                        {item.id}
                      </Button>
                      <Button
                        type="button"
                        disabled={!item.eligible || selected || input.actions.length >= 30}
                        onClick={() =>
                          change('actions', [
                            ...input.actions,
                            {
                              eventId: item.id,
                              title: '',
                              owner: '',
                              dueDate: null,
                              mechanism: '',
                              evidence: '',
                              validationMethod: '',
                              expectedRecoveredMinutes: '',
                              confidencePct: 0,
                              confirmed: false,
                              oneOffCost: null,
                              recurringCostPerPeriod: null
                            }
                          ])
                        }
                      >
                        {selected ? 'В плане' : item.eligible ? 'Добавить работу' : 'Защищено'}
                      </Button>
                    </div>
                  );
                })}
              {!candidates.length && (
                <Empty title="Нет остановок в выборке">
                  Добавьте фактические записи в разделе «Данные».
                </Empty>
              )}
            </section>

            <div className="action-plan-worklist">
              {input.actions.map((action, index) => {
                const source = candidates.find((item) => item.id === action.eventId);
                return (
                  <section className="action-plan-work" key={action.eventId}>
                    <header>
                      <div>
                        <h3>Мероприятие {index + 1}</h3>
                        <p>
                          {source?.equipment} · {source?.reason} · {action.eventId}
                        </p>
                      </div>
                      <Button
                        type="button"
                        onClick={() =>
                          change(
                            'actions',
                            input.actions.filter((item) => item.eventId !== action.eventId)
                          )
                        }
                      >
                        Убрать из плана
                      </Button>
                    </header>
                    <Field label="Какую работу выполнить">
                      <input
                        maxLength="180"
                        value={action.title}
                        onChange={(event) =>
                          changeAction(action.eventId, 'title', event.target.value)
                        }
                      />
                    </Field>
                    <div className="action-plan-two">
                      <Field label="Ответственный">
                        <input
                          maxLength="80"
                          autoComplete="off"
                          value={action.owner}
                          onChange={(event) =>
                            changeAction(action.eventId, 'owner', event.target.value)
                          }
                        />
                      </Field>
                      <Field label="Срок выполнения">
                        <input
                          type="date"
                          value={action.dueDate || ''}
                          onChange={(event) =>
                            changeAction(action.eventId, 'dueDate', event.target.value)
                          }
                        />
                      </Field>
                      <Field label="Как работа устраняет причину">
                        <textarea
                          rows="3"
                          maxLength="1200"
                          value={action.mechanism}
                          onChange={(event) =>
                            changeAction(action.eventId, 'mechanism', event.target.value)
                          }
                        />
                      </Field>
                      <Field
                        label="На чём основана оценка минут"
                        hint="Протокол осмотра, хронометраж или результат предыдущего ремонта."
                      >
                        <textarea
                          rows="3"
                          maxLength="1200"
                          value={action.evidence}
                          onChange={(event) =>
                            changeAction(action.eventId, 'evidence', event.target.value)
                          }
                        />
                      </Field>
                      <Field
                        label="Вернуть из этой остановки, мин"
                        hint={`Не более ${format(source?.minutes)} мин. Модель усреднит их по исходным наблюдениям.`}
                      >
                        <input
                          type="number"
                          min="0.01"
                          step="0.01"
                          max={source?.minutes}
                          required
                          value={action.expectedRecoveredMinutes}
                          onChange={(event) =>
                            changeAction(
                              action.eventId,
                              'expectedRecoveredMinutes',
                              event.target.value
                            )
                          }
                        />
                      </Field>
                      <Field
                        label="Уверенность инженера, %"
                        hint="Экспертная оценка; не вероятность, измеренная моделью."
                      >
                        <input
                          type="number"
                          min="0"
                          max="100"
                          value={action.confidencePct}
                          onChange={(event) =>
                            changeAction(action.eventId, 'confidencePct', event.target.value)
                          }
                        />
                      </Field>
                      <Field
                        label="Разовые затраты, ₸"
                        hint="Пусто — неизвестны. Укажите 0, только если затрат нет."
                      >
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          max="1000000000000"
                          value={action.oneOffCost ?? ''}
                          onChange={(event) =>
                            changeAction(action.eventId, 'oneOffCost', event.target.value)
                          }
                        />
                      </Field>
                      <Field label="Затраты за расчётный период, ₸">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          max="1000000000000"
                          value={action.recurringCostPerPeriod ?? ''}
                          onChange={(event) =>
                            changeAction(
                              action.eventId,
                              'recurringCostPerPeriod',
                              event.target.value
                            )
                          }
                        />
                      </Field>
                    </div>
                    <Field label="Как подтвердим фактический результат">
                      <textarea
                        rows="2"
                        maxLength="1200"
                        value={action.validationMethod}
                        onChange={(event) =>
                          changeAction(action.eventId, 'validationMethod', event.target.value)
                        }
                      />
                    </Field>
                    <label className="action-plan-confirm">
                      <input
                        type="checkbox"
                        checked={action.confirmed}
                        onChange={(event) =>
                          changeAction(action.eventId, 'confirmed', event.target.checked)
                        }
                      />
                      <span>
                        Инженер проверил причину, выполнимость работы и отсутствие двойного учёта
                        остановок.
                      </span>
                    </label>
                  </section>
                );
              })}
            </div>

            <section className="action-plan-economics">
              <h3>Проверка эффекта</h3>
              <Field
                label="Целевой выпуск за выбранный горизонт"
                hint="Можно перенести из обратного плана или указать свою цель."
              >
                <input
                  type="number"
                  min="0.01"
                  max="1000000"
                  step="0.01"
                  value={input.targetGoodOutput ?? ''}
                  onChange={(event) => change('targetGoodOutput', event.target.value)}
                />
              </Field>
              <div className="action-plan-two">
                <Field label="Выполнение плана, %">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    required
                    value={input.realizationPct}
                    onChange={(event) => change('realizationPct', event.target.value)}
                  />
                </Field>
                <Field label="Количество сопоставимых периодов">
                  <input
                    type="number"
                    min="1"
                    max="366"
                    required
                    value={input.periods}
                    onChange={(event) => change('periods', event.target.value)}
                  />
                </Field>
              </div>
              <details>
                <summary>Добавить подтверждённую экономику</summary>
                <p>
                  Без маржи, спроса и их источника показываем выпуск и известные затраты. Денежную
                  выгоду не подставляем.
                </p>
                <div className="action-plan-two">
                  <Field label="Маржинальный доход на машину, ₸">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      max="1000000000000"
                      value={input.unitContribution ?? ''}
                      onChange={(event) => change('unitContribution', event.target.value)}
                    />
                  </Field>
                  <Field label="Дополнительный спрос за период, машин">
                    <input
                      type="number"
                      min="0"
                      max="1000000"
                      step="0.01"
                      value={input.maxAdditionalSalesPerPeriod ?? ''}
                      onChange={(event) =>
                        change('maxAdditionalSalesPerPeriod', event.target.value)
                      }
                    />
                  </Field>
                </div>
                <Field label="Источник маржи и спроса">
                  <textarea
                    rows="2"
                    maxLength="1200"
                    value={input.economicEvidence}
                    onChange={(event) => change('economicEvidence', event.target.value)}
                  />
                </Field>
              </details>
              <Button type="submit" tone="primary">
                {busy ? 'Проверяем…' : 'Проверить план и эффект'}
              </Button>
            </section>
          </fieldset>
        </form>
      )}
      {result && (
        <section className="action-plan-result" aria-live="polite">
          <div className="action-plan-result-title">
            <h3>
              {result.partialOutput === null
                ? 'Черновик плана сохранит ваши работы'
                : 'Что даст выполнение плана'}
            </h3>
            <span className={result.readiness.status === 'ready' ? 'ready' : ''}>
              {result.readiness.status === 'ready'
                ? 'Можно передать в работу'
                : 'Нужна инженерная проверка'}
            </span>
          </div>
          {result.partialOutput === null ? (
            <div className="action-plan-note" role="status">
              <p>
                Работы и расходы можно подготовить и сохранить. Для расчёта выпуска и передачи плана
                в работу нужно дополнить исходные данные:
              </p>
              <ul>
                {result.modelReadiness.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
              <a href="#/app/data">Открыть исходные данные</a>
            </div>
          ) : (
            <p>
              Расчётный выпуск за {format(result.input.hours)} ч. Фактический результат проверяется
              после выполнения.
            </p>
          )}
          {result.targetGoodOutput !== null && (
            <p className="action-plan-target-status">
              Цель: {format(result.targetGoodOutput, 2)} машин.{' '}
              {result.targetMet === null
                ? 'Достижимость пока не оценена: недостаточно исходных данных.'
                : result.targetMet
                  ? 'Выбранные мероприятия достигают цели в расчётной модели.'
                  : `Не хватает ${format(result.targetGap, 2)} машины при выполнении ${format(result.realizationPct)}%. Уточните мероприятия или цель.`}
            </p>
          )}
          {result.partialOutput !== null && (
            <div className="action-plan-comparison">
              {[
                ['Текущие условия', result.baselineOutput],
                [`Выполнение ${format(result.realizationPct)}%`, result.partialOutput],
                ['Полное выполнение', result.plannedOutput]
              ].map(([label, value]) => (
                <div key={label}>
                  <span>{label}</span>
                  <strong>
                    {format(value, 2)} <small>машин</small>
                  </strong>
                  <meter
                    min="0"
                    max={Math.max(1, result.plannedOutput, result.baselineOutput)}
                    value={value}
                    aria-label={label}
                  />
                </div>
              ))}
            </div>
          )}
          <div className="action-plan-money">
            <span>Известные затраты за {result.input.periods} период(а)</span>
            <strong>
              {format(result.economics.knownTotalCost, 2)} ₸
              {result.economics.unknownCostCount > 0 ? ' + неуточнённые' : ''}
            </strong>
          </div>
          {result.economics.netContribution !== null ? (
            <div className="action-plan-money">
              <span>Условный чистый эффект с учётом спроса</span>
              <strong>{format(result.economics.netContribution, 2)} ₸</strong>
            </div>
          ) : (
            <p className="action-plan-note">
              Для денежного эффекта нужны:{' '}
              {result.economics.missingInputs.join('; ').toLocaleLowerCase('ru-RU')}.
            </p>
          )}
          {result.readiness.blockers.length > 0 && (
            <details className="action-plan-review" open={input.actions.length > 0}>
              <summary>До передачи в работу: {result.readiness.blockers.length}</summary>
              <ul>
                {result.readiness.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="action-plan-save">
            <Field label="Название плана">
              <input
                maxLength="100"
                value={name}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Button
              disabled={!canWrite || busy || !name.trim() || !input.actions.length}
              onClick={save}
            >
              {active ? 'Обновить план' : 'Сохранить план'}
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                downloadJson(
                  { name, datasetVersion: dataset.version, source: dataset.data.source, ...result },
                  'qarqyn-action-plan.json'
                )
              }
            >
              {result.partialOutput === null ? 'Скачать план' : 'Скачать расчёт'}
            </Button>
          </div>
          <details className="action-plan-assumptions">
            <summary>Исходные данные и допущения</summary>
            <Button onClick={() => onEvidence?.(result.sourceIds)}>Открыть исходные записи</Button>
            {result.assumptions.map((item) => (
              <p key={item}>{item}</p>
            ))}
          </details>
        </section>
      )}
      <section className="action-plan-saved">
        <h3>Сохранённые планы</h3>
        <ErrorBox>{saved.error}</ErrorBox>
        {saved.loading ? (
          <Loading />
        ) : saved.data?.items.length ? (
          <>
            {saved.data.items.map((entity) => (
              <div className="action-plan-saved-row" key={entity.id}>
                <div>
                  <strong>{entity.name}</strong>
                  <p>
                    {entity.result.readiness.status === 'ready'
                      ? 'Инженерная проверка заполнена'
                      : 'Черновик'}{' '}
                    · данные v{entity.datasetVersion} · {entity.input.actions.length} мероприятий
                  </p>
                  {entity.datasetVersion !== dataset.version && (
                    <small>Данные изменились. Откройте и пересчитайте план.</small>
                  )}
                </div>
                <Button disabled={busy} onClick={() => load(entity)}>
                  Открыть
                </Button>
                <Button
                  disabled={
                    busy ||
                    !canWrite ||
                    entity.result.readiness.status !== 'ready' ||
                    entity.datasetVersion !== dataset.version
                  }
                  onClick={() => dispatch(entity)}
                >
                  Создать задачи
                </Button>
                {canWrite && (
                  <Button disabled={busy} tone="danger" onClick={() => setDeleting(entity)}>
                    Удалить
                  </Button>
                )}
              </div>
            ))}
            <Pagination
              page={page}
              pageSize={10}
              total={saved.data.total}
              onChange={setPage}
              disabled={busy}
            />
          </>
        ) : (
          <p>
            Сохраните проверенный расчёт, чтобы вернуться к нему или передать мероприятия
            ответственным.
          </p>
        )}
      </section>
      {deleting && (
        <Confirm
          title="Удалить план мероприятий?"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api(`/action-plans/${deleting.id}`, 'DELETE', { version: deleting.version });
            if (active?.id === deleting.id) setActive(null);
            revise((value) => value + 1);
            notify?.('План удалён');
          }}
        >
          {deleting.name}. Созданные по нему задачи сохранятся в журнале.
        </Confirm>
      )}
    </div>
  );
}

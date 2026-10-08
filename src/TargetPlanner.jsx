import { useEffect, useRef, useState } from 'react';
import { api, format } from './api.js';
import { Button, Field, ErrorBox, Loading } from './ui.jsx';
import { Icon } from './icons.jsx';
import './target-planner.css';
import { stageImage } from './stage-assets.js';

export default function TargetPlanner({ analysis, canWrite, notify, evidence, navigate }) {
  const [hours, setHours] = useState(8);
  const [observationHours, setObservationHours] = useState(8);
  const [target, setTarget] = useState('');
  const [baseline, setBaseline] = useState(null);
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const calculation = useRef(null);
  const contextKey = `${analysis.datasetId}:${analysis.version}:${hours}:${observationHours}:${target}`;
  const currentContext = useRef(contextKey);
  currentContext.current = contextKey;
  useEffect(() => {
    const controller = new AbortController();
    calculation.current?.abort();
    setBusy(false);
    setBaseline(null);
    setPlan(null);
    setSaved(false);
    setError('');
    api(
      '/simulate',
      'POST',
      { datasetId: analysis.datasetId, hours, observationHours, interventions: [] },
      controller.signal
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        setBaseline(result.baseline.output);
        setTarget(String(Math.ceil(result.baseline.output * 1.02)));
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => {
      controller.abort();
      calculation.current?.abort();
    };
  }, [analysis.datasetId, analysis.version, hours, observationHours]);
  async function calculate(event) {
    event.preventDefault();
    calculation.current?.abort();
    const controller = new AbortController();
    calculation.current = controller;
    const requestKey = currentContext.current;
    setBusy(true);
    setError('');
    setPlan(null);
    setSaved(false);
    try {
      const result = await api(
        '/plan-target',
        'POST',
        {
          datasetId: analysis.datasetId,
          hours,
          observationHours,
          targetGoodOutput: Number(target)
        },
        controller.signal
      );
      if (!controller.signal.aborted && requestKey === currentContext.current) setPlan(result);
    } catch (e) {
      if (!controller.signal.aborted && requestKey === currentContext.current) setError(e.message);
    } finally {
      if (!controller.signal.aborted && requestKey === currentContext.current) setBusy(false);
    }
  }
  async function save() {
    const requestKey = currentContext.current;
    setSaving(true);
    setError('');
    try {
      await api('/scenarios', 'POST', {
        name: `Цель ${format(plan.targetGoodOutput, 1)} за ${hours} ч`,
        note: 'Обратное планирование. Минимальные восстановления простоев в последовательной модели. Качество неизменно, явно указанное плановое ТО исключено. Перед применением нужна проверка инженером.',
        input: plan.input,
        expectedDatasetVersion: plan.datasetVersion
      });
      if (requestKey === currentContext.current) setSaved(true);
      notify('План сохранён в сценариях');
    } catch (e) {
      if (requestKey === currentContext.current) setError(e.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <div className="page-intro">
        <div>
          <h2>От цели — к действиям.</h2>
          <p>
            Задайте нужный выпуск. Двойник найдёт минимальное сокращение простоев по участкам при
            неизменном качестве.
          </p>
        </div>
      </div>
      <div className="target-workspace">
        <form className="target-form" onSubmit={calculate}>
          <Field label="Горизонт плана">
            <select
              value={hours}
              disabled={busy}
              onChange={(e) => setHours(Number(e.target.value))}
            >
              {[8, 16, 40, 160].map((h) => (
                <option key={h} value={h}>
                  {h} часов
                </option>
              ))}
            </select>
          </Field>
          <Field label="Период исходной строки" hint="Допущение: длительность строки неоднозначна">
            <select
              value={observationHours}
              disabled={busy}
              onChange={(e) => setObservationHours(Number(e.target.value))}
            >
              <option value={8}>8 часов · одна смена</option>
              <option value={16}>16 часов · две смены</option>
            </select>
          </Field>
          <Field
            label="Нужный годный выпуск"
            hint="Расчётный поток автомобилей за выбранный горизонт"
          >
            <input
              type="number"
              min="0.01"
              max="1000000"
              step="0.01"
              value={target}
              disabled={busy || baseline === null}
              required
              onChange={(e) => {
                setTarget(e.target.value);
                setPlan(null);
                setSaved(false);
              }}
            />
          </Field>
          <div className="target-baseline">
            <span>Без изменений</span>
            <strong>
              {format(baseline, 2)}
              <small> автомобилей</small>
            </strong>
          </div>
          <Button tone="primary" icon="target" disabled={busy || baseline === null}>
            {busy ? 'Рассчитываем план…' : 'Найти путь к цели'}
          </Button>
          <p className="target-note">
            Качество и скорость оборудования фиксированы. Плановое ТО не включается в доступный
            резерв.
          </p>
        </form>
        <section className="target-result" aria-live="polite" aria-busy={busy}>
          <ErrorBox>{error}</ErrorBox>
          {busy ? (
            <Loading label="Проверяем ограничения каждого участка…" />
          ) : plan ? (
            <>
              <div className={`target-verdict ${plan.achievable ? 'possible' : 'limited'}`}>
                <Icon name={plan.achievable ? 'check' : 'incident'} size={28} />
                <div>
                  <h3>
                    {plan.achievable
                      ? 'Цель достижима в модели'
                      : 'Цель превышает доступный резерв'}
                  </h3>
                  <p>{plan.reason}</p>
                </div>
              </div>
              <div className="target-readings">
                <div>
                  <span>Сейчас</span>
                  <strong>{format(plan.baselineGoodOutput, 2)}</strong>
                </div>
                <Icon name="arrow" size={30} />
                <div>
                  <span>{plan.achievable ? 'С планом' : 'Максимум при ограничениях'}</span>
                  <strong>
                    {format(plan.achievable ? plan.result.scenario.output : plan.maxGoodOutput, 2)}
                  </strong>
                </div>
              </div>
              {plan.achievable ? (
                <>
                  <h3 className="target-action-title">Что нужно изменить</h3>
                  <div className="target-actions">
                    {plan.interventions.map((item) => (
                      <article key={item.stageId}>
                        <img src={stageImage(item.stageId)} alt="" width="1280" height="1280" />
                        <div>
                          <h4>{item.name}</h4>
                          <p>
                            {item.recoverMinutes > 0
                              ? `Вернуть ${format(item.recoverMinutes, 2)} мин из ${format(item.availableMinutes, 2)} доступных`
                              : 'Изменения не требуются'}
                          </p>
                          {item.excludedPlannedMinutes > 0 && (
                            <small>
                              Плановое ТО: {format(item.excludedPlannedMinutes, 1)} мин исключено
                            </small>
                          )}
                          <button className="text-button" onClick={() => evidence(item.sourceIds)}>
                            Проверить исходные записи <Icon name="arrow" size={14} />
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                  <p className="target-total">
                    Суммарное восстановление: <b>{format(plan.totalRecoverMinutes, 2)} мин</b> на
                    исходный период {observationHours} ч.
                  </p>
                  <div className="row-actions">
                    <Button
                      tone="primary"
                      icon="plus"
                      disabled={!canWrite || saving || saved}
                      onClick={save}
                    >
                      {saved ? 'План сохранён' : saving ? 'Сохраняем…' : 'Сохранить как сценарий'}
                    </Button>
                    {saved && <Button onClick={() => navigate('lab')}>Открыть сценарии</Button>}
                  </div>
                  {!canWrite && (
                    <p className="target-note">
                      Расчёт доступен в демо. Для сохранения нужен вход редактора.
                    </p>
                  )}
                </>
              ) : (
                <div className="target-limit">
                  <h3>Не хватает {format(plan.shortfall, 2)} автомобиля в модели</h3>
                  <p>
                    Одного сокращения наблюдаемых простоев недостаточно. Проверьте длительность
                    периода, качество и производительность в лаборатории сценариев.
                  </p>
                  <Button onClick={() => navigate('lab')} icon="lab">
                    Изучить другие изменения
                  </Button>
                </div>
              )}
              <details className="target-assumptions">
                <summary>Почему расчёту нужны ограничения</summary>
                {plan.assumptions.map((text, i) => (
                  <p key={i}>{text}</p>
                ))}
              </details>
            </>
          ) : (
            <div className="target-intro">
              <Icon name="target" size={48} />
              <h3>Найдите ровно столько изменений, сколько нужно.</h3>
              <p>
                Алгоритм проходит цепочку от готового автомобиля назад к сварке и проверяет,
                способен ли каждый участок обеспечить цель.
              </p>
              <ol>
                <li>Учитывает потери качества на всём пути.</li>
                <li>Сохраняет явно указанное плановое обслуживание.</li>
                <li>Объясняет, если доступных минут недостаточно.</li>
              </ol>
              <p>Это расчёт для инженерной проверки. Команды оборудованию не отправляются.</p>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

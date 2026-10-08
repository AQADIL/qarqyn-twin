import { useEffect, useState } from 'react';
import { api, format } from './api.js';
import { Button, Field, ErrorBox, Loading, Modal, Confirm, Empty, useResource } from './ui.jsx';
import { Icon } from './icons.jsx';

export default function Lab({ analysis, canWrite, notify }) {
  const stages = analysis.stages.filter((s) => s.kind === 'production' && s.observations);
  const [input, setInput] = useState({
    datasetId: analysis.datasetId,
    hours: 8,
    observationHours: 8,
    interventions: []
  });
  const [result, setResult] = useState(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [revision, revise] = useState(0),
    [saving, setSaving] = useState(null),
    [deleting, setDeleting] = useState(null);
  const [suggestions, setSuggestions] = useState(null),
    [optimizing, setOptimizing] = useState(false);
  const saved = useResource(`/scenarios?datasetId=${analysis.datasetId}`, revision);
  useEffect(() => {
    let ignore = false;
    const controller = new AbortController();
    setBusy(true);
    setError('');
    const timer = setTimeout(
      () =>
        api('/simulate', 'POST', input, controller.signal)
          .then((r) => {
            if (!ignore) setResult(r);
          })
          .catch((e) => {
            if (!ignore) {
              setError(e.message);
              setResult(null);
            }
          })
          .finally(() => {
            if (!ignore) setBusy(false);
          }),
      200
    );
    return () => {
      ignore = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [input]);
  function change(stageId, key, value) {
    setInput((old) => {
      const item = old.interventions.find((x) => x.stageId === stageId) || {
        stageId,
        recoverMinutes: 0,
        defectPct: null
      };
      return {
        ...old,
        interventions: [
          ...old.interventions.filter((x) => x.stageId !== stageId),
          { ...item, [key]: value }
        ]
      };
    });
  }
  async function recommend() {
    setOptimizing(true);
    setError('');
    try {
      setSuggestions(
        await api('/optimize', 'POST', {
          datasetId: input.datasetId,
          hours: input.hours,
          observationHours: input.observationHours
        })
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setOptimizing(false);
    }
  }
  return (
    <>
      <div className="page-intro">
        <div>
          <span className="eyebrow">ЛАБОРАТОРИЯ РЕШЕНИЙ</span>
          <h2>Что изменит выпуск?</h2>
          <p>Измените условия и проследите эффект через всю цепочку производства.</p>
        </div>
        <Button icon="lab" onClick={recommend} disabled={optimizing}>
          {optimizing ? 'Сравниваем…' : 'Сравнить точки влияния'}
        </Button>
      </div>
      <ErrorBox>{error}</ErrorBox>
      <div className="lab-layout">
        <section className="lab-controls">
          <div className="lab-period">
            <Field label="Горизонт расчёта">
              <select
                value={input.hours}
                onChange={(e) => {
                  setSuggestions(null);
                  setInput({ ...input, hours: Number(e.target.value) });
                }}
              >
                {[8, 16, 40, 160].map((h) => (
                  <option key={h} value={h}>
                    {h} часов
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Период исходной строки" hint="Допущение: в данных период неоднозначен">
              <select
                value={input.observationHours}
                onChange={(e) => {
                  setSuggestions(null);
                  setInput({ ...input, observationHours: Number(e.target.value) });
                }}
              >
                <option value={8}>8 часов · одна смена</option>
                <option value={16}>16 часов · две смены</option>
              </select>
            </Field>
          </div>
          {stages.map((s) => {
            const edit = input.interventions.find((x) => x.stageId === s.id);
            const max = s.downtimeMinutes / s.observations;
            return (
              <div className="intervention" key={s.id}>
                <h3>
                  <Icon name={s.id} size={26} />
                  {s.name}
                </h3>
                <Field
                  label={
                    <span>
                      Вернуть время <b>{format(edit?.recoverMinutes || 0, 1)} мин</b>
                    </span>
                  }
                  hint={`Из ${format(max, 1)} мин простоя на исходный период`}
                >
                  <input
                    aria-label={`${s.name}: вернуть минуты простоя`}
                    type="range"
                    min="0"
                    max={max}
                    step="0.5"
                    value={edit?.recoverMinutes || 0}
                    onChange={(e) => change(s.id, 'recoverMinutes', Number(e.target.value))}
                  />
                </Field>
                <Field
                  label={
                    <span>
                      Целевая доля брака <b>{format(edit?.defectPct ?? s.defectPct, 2)}%</b>
                    </span>
                  }
                  hint={`Исходная доля: ${format(s.defectPct, 2)}%`}
                >
                  <input
                    aria-label={`${s.name}: целевая доля брака`}
                    type="range"
                    min="0"
                    max={Math.max(10, s.defectPct || 0)}
                    step="0.01"
                    value={edit?.defectPct ?? s.defectPct ?? 0}
                    onChange={(e) => change(s.id, 'defectPct', Number(e.target.value))}
                  />
                </Field>
              </div>
            );
          })}
          <Button tone="quiet" onClick={() => setInput({ ...input, interventions: [] })}>
            Сбросить изменения
          </Button>
        </section>
        <div className="lab-results">
          {!result && busy ? (
            <Loading label="Строим модель потока…" />
          ) : (
            result && (
              <>
                <section className={`scenario-result ${busy ? 'updating' : ''}`} aria-busy={busy}>
                  <span className="eyebrow">РАСЧЁТНЫЙ ГОДНЫЙ ПОТОК / {input.hours} ЧАСОВ</span>
                  <div className="result-number">
                    <strong>{format(result.scenario.output, 1)}</strong>
                    <span>
                      автомобилей
                      <br />в модели
                    </span>
                    <b className={result.delta >= 0 ? 'positive' : 'negative'}>
                      {result.delta > 0 ? '+' : ''}
                      {format(result.delta, 1)}
                    </b>
                  </div>
                  <div className="result-comparison">
                    <span>
                      Базовый сценарий <b>{format(result.baseline.output, 1)}</b>
                    </span>
                    <span>
                      С выбранными изменениями <b>{format(result.scenario.output, 1)}</b>
                    </span>
                  </div>
                  <div className="comparison-lines">
                    <div
                      style={{
                        width: `${(result.baseline.output / Math.max(result.baseline.output, result.scenario.output, 1)) * 100}%`
                      }}
                    />
                    <div
                      style={{
                        width: `${(result.scenario.output / Math.max(result.baseline.output, result.scenario.output, 1)) * 100}%`
                      }}
                    />
                  </div>
                  <p>
                    Чувствительность к доле брака:{' '}
                    <b>
                      {format(result.range[0], 1)}–{format(result.range[1], 1)}
                    </b>
                    . Это диапазон модели, не гарантия выпуска.
                  </p>
                  <Button
                    tone="primary"
                    icon="plus"
                    disabled={!canWrite || busy}
                    onClick={() => setSaving({ input })}
                  >
                    Сохранить сценарий
                  </Button>
                  {!canWrite && (
                    <small>Для сохранения нужен вход редактора. Расчёт доступен в демо.</small>
                  )}
                </section>
                <section className="flow-result">
                  <h3>Как проходит поток</h3>
                  <div className="flow-steps">
                    {result.scenario.steps.map((s, i) => (
                      <div key={s.stageId}>
                        <span className="mono">0{i + 1}</span>
                        <Icon name={s.stageId} size={30} />
                        <h4>{s.name}</h4>
                        <strong>{format(s.goodOutput, 1)}</strong>
                        <small>годных после участка</small>
                        <span className="flow-loss">Потеря на браке {format(s.loss, 1)}</span>
                      </div>
                    ))}
                  </div>
                </section>
                <section className="sensitivity">
                  <h3>Где находится резерв</h3>
                  <p>
                    Дополнительный поток при устранении всех наблюдаемых потерь одного участка, с
                    учётом текущих изменений.
                  </p>
                  {result.sensitivity.map((s) => (
                    <div key={s.stageId}>
                      <span>{s.name}</span>
                      <span className="sensitivity-line">
                        <i
                          style={{
                            width: `${(Math.max(0, s.headroom) / Math.max(...result.sensitivity.map((x) => x.headroom), 1)) * 100}%`
                          }}
                        />
                      </span>
                      <b>+{format(s.headroom, 1)}</b>
                    </div>
                  ))}
                </section>
                <details className="methodology">
                  <summary>Модель, формулы и ограничения</summary>
                  <h4>{result.model}</h4>
                  {result.assumptions.map((t) => (
                    <p key={t}>{t}</p>
                  ))}
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Участок</th>
                          <th>Скорость, шт/ч</th>
                          <th>Простой / строку</th>
                          <th>Записи</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.evidence.map((e) => (
                          <tr key={e.stageId}>
                            <td>{stages.find((s) => s.id === e.stageId)?.name}</td>
                            <td>{format(e.rate, 3)}</td>
                            <td>{format(e.downtimePerObservation, 2)} мин</td>
                            <td>{e.sourceIds.join(', ')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </>
            )
          )}
        </div>
      </div>
      {suggestions && (
        <section className="suggestions">
          <header className="section-head">
            <div>
              <span className="eyebrow">СРАВНЕНИЕ ВМЕШАТЕЛЬСТВ</span>
              <h2>Куда направить внимание</h2>
            </div>
          </header>
          <p>
            Каждый вариант рассчитывается отдельно от исходных условий. Стоимость и техническая
            реализуемость не оценены.
          </p>
          {suggestions.map((s, i) => (
            <div key={s.stageId}>
              <span className="rank">0{i + 1}</span>
              <div>
                <h3>{s.name}</h3>
                <p>{s.detail}</p>
              </div>
              <strong>
                +{format(s.delta, 1)}
                <small> расчётных шт</small>
              </strong>
              <Button
                onClick={() => {
                  setInput(s.input);
                  window.scrollTo({ top: 0, behavior: 'instant' });
                }}
              >
                Применить
              </Button>
            </div>
          ))}
        </section>
      )}
      <section className="saved-scenarios">
        <header className="section-head">
          <h2>Сохранённые решения</h2>
          <span className="eyebrow">ВЕРСИЯ ИСТОЧНИКА СОХРАНЯЕТСЯ</span>
        </header>
        <ErrorBox>{saved.error}</ErrorBox>
        {saved.loading ? (
          <Loading />
        ) : saved.data?.length ? (
          saved.data.map((s) => (
            <article key={s.id}>
              <Icon name="source" size={28} />
              <div>
                <h3>{s.name}</h3>
                <p>{s.note || 'Без заметки'}</p>
                <small>
                  Версия данных {s.datasetVersion} · {s.input.hours} ч ·{' '}
                  {new Date(s.createdAt).toLocaleString('ru-RU')}
                </small>
              </div>
              <strong>
                {s.result.delta > 0 ? '+' : ''}
                {format(s.result.delta, 1)}
                <small> шт в модели</small>
              </strong>
              <div className="row-actions">
                <Button
                  onClick={() => {
                    setInput(s.input);
                    window.scrollTo({ top: 0, behavior: 'instant' });
                  }}
                >
                  Открыть
                </Button>
                <button
                  className="icon-button"
                  aria-label={`Изменить ${s.name}`}
                  onClick={() => setSaving(s)}
                >
                  <Icon name="edit" />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Удалить ${s.name}`}
                  onClick={() => setDeleting(s)}
                >
                  <Icon name="delete" />
                </button>
              </div>
            </article>
          ))
        ) : (
          <Empty title="Решения ещё не сохранены">
            Сравните условия и сохраните перспективный сценарий вместе с расчётом.
          </Empty>
        )}
      </section>
      {saving && (
        <SaveScenario
          item={saving}
          onClose={() => setSaving(null)}
          onSave={() => {
            revise((v) => v + 1);
            setSaving(null);
            notify('Сценарий сохранён');
          }}
        />
      )}{' '}
      {deleting && (
        <Confirm
          title="Удалить сценарий?"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api(`/scenarios/${deleting.id}`, 'DELETE', { version: deleting.version });
            revise((v) => v + 1);
            notify('Сценарий удалён');
          }}
        >
          {deleting.name}. Это действие удалит сохранённый расчёт.
        </Confirm>
      )}
    </>
  );
}
function SaveScenario({ item, onSave, onClose }) {
  const [name, setName] = useState(item.name || ''),
    [note, setNote] = useState(item.note || ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal title={item.id ? 'Изменить решение' : 'Сохранить решение'} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const data = { name, note, input: item.input };
            await api(
              item.id ? `/scenarios/${item.id}` : '/scenarios',
              item.id ? 'PUT' : 'POST',
              item.id ? { version: item.version, data } : data
            );
            onSave();
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Название">
          <input
            autoFocus
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Основание решения">
          <textarea
            maxLength={2000}
            rows={4}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        {item.id && (
          <p className="small-note">При сохранении расчёт обновится по текущей версии данных.</p>
        )}
        <ErrorBox>{error}</ErrorBox>
        <div className="form-actions">
          <Button type="button" onClick={onClose}>
            Отмена
          </Button>
          <Button tone="primary" disabled={busy}>
            {busy ? 'Сохраняем…' : 'Сохранить'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

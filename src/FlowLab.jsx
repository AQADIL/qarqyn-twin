import { useEffect, useRef, useState } from 'react';
import { api, downloadJson, format } from './api.js';
import {
  Button,
  Field,
  ErrorBox,
  Empty,
  Loading,
  Pagination,
  Confirm,
  useResource
} from './ui.jsx';
import './flow-lab.css';

const labels = {
  busy: 'Обработка',
  blocked: 'Выход занят',
  starved: 'Нет деталей',
  down: 'Простой'
};
const fields = [
  ['machines', 'Станков', 1, 8, 1],
  ['cycleMinutes', 'Цикл, мин', 0.1, 240, 'any'],
  ['bufferCapacity', 'Буфер, шт.', 0, 200, 1],
  ['initialWip', 'Начальный НЗП', 0, 200, 1],
  ['reworkEvery', 'Передел каждой N-й', 0, 2000, 1],
  ['maxRework', 'Доп. проходов', 0, 3, 1]
];
function references(data) {
  return data.stages
    .filter((stage) => stage.kind !== 'buffer')
    .map((stage) => {
      const rows = data.production.filter((row) => row.stageId === stage.id);
      const output = rows.reduce((sum, row) => sum + row.actual, 0);
      const minutes = rows.reduce((sum, row) => sum + row.runtimeHours * 60, 0);
      return {
        ...stage,
        cycle: output > 0 ? minutes / output : null,
        rowIds: rows.map((row) => row.id)
      };
    });
}
function initialInput(dataset, stageReferences) {
  return {
    datasetId: dataset.id,
    expectedDatasetVersion: dataset.version,
    horizonMinutes: String(dataset.data.targets.hoursPerShift * 60),
    materialCount: '',
    assumptionsConfirmed: false,
    stages: stageReferences
      .filter((stage) => stage.kind === 'production')
      .map((stage) => ({
        stageId: stage.id,
        machines: '',
        cycleMinutes: '',
        bufferCapacity: '',
        initialWip: '',
        reworkEvery: '',
        maxRework: '',
        downtime: []
      }))
  };
}
function numericInput(value) {
  return {
    ...value,
    horizonMinutes: Number(value.horizonMinutes),
    materialCount: Number(value.materialCount),
    stages: value.stages.map((stage) => ({
      ...stage,
      ...Object.fromEntries(fields.map(([key]) => [key, Number(stage[key])])),
      downtime: stage.downtime.map((stop) =>
        Object.fromEntries(Object.entries(stop).map(([key, entry]) => [key, Number(entry)]))
      )
    }))
  };
}

export default function FlowLab(props) {
  if (!props.dataset?.data) return <Loading />;
  return <FlowEditor key={`${props.dataset.id}:${props.dataset.version}`} {...props} />;
}

function FlowEditor({ dataset, onEvidence, notify, canWrite }) {
  const stageReferences = references(dataset.data);
  const [input, setInput] = useState(() => initialInput(dataset, stageReferences));
  const [result, setResult] = useState(null);
  const [baseline, setBaseline] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [revision, setRevision] = useState(0);
  const [savedPage, setSavedPage] = useState(1);
  const [deleting, setDeleting] = useState(null);
  const [sample, setSample] = useState(60);
  const [loadNotice, setLoadNotice] = useState('');
  const controller = useRef(null);
  const saved = useResource(
    `/flow-studies?datasetId=${dataset.id}&page=${savedPage}&pageSize=20`,
    revision
  );
  const currentKey = JSON.stringify(input);
  const [resultKey, setResultKey] = useState('');
  const stale = Boolean(result && currentKey !== resultKey);
  useEffect(() => () => controller.current?.abort(), []);

  function updateStage(index, key, value) {
    setInput((old) => ({
      ...old,
      stages: old.stages.map((stage, i) => (i === index ? { ...stage, [key]: value } : stage))
    }));
  }
  function updateStop(stageIndex, stopIndex, key, value) {
    const stops = input.stages[stageIndex].downtime.map((stop, i) =>
      i === stopIndex ? { ...stop, [key]: value } : stop
    );
    updateStage(stageIndex, 'downtime', stops);
  }
  function simpleLine() {
    setInput((old) => ({
      ...old,
      assumptionsConfirmed: false,
      stages: old.stages.map((stage) => ({
        ...stage,
        machines: '1',
        cycleMinutes:
          stageReferences.find((reference) => reference.id === stage.stageId)?.cycle?.toFixed(4) ??
          '',
        bufferCapacity: '0',
        initialWip: '0',
        reworkEvery: '0',
        maxRework: '0',
        downtime: []
      }))
    }));
    setLoadNotice(
      'Задан сценарий: один эквивалентный станок, прямые передачи, пустая линия, без передела и временных интервалов простоев. Цикл взят из темпа исходных записей. Проверьте условия и укажите число деталей.'
    );
  }
  async function simulate(event) {
    event.preventDefault();
    setError('');
    controller.current?.abort();
    controller.current = new AbortController();
    setBusy(true);
    const requestKey = currentKey;
    try {
      const response = await api(
        '/flow-simulate',
        'POST',
        numericInput(input),
        controller.current.signal
      );
      setResult(response);
      setResultKey(requestKey);
      setSample(response.timeline.length - 1);
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!result || stale || !name.trim()) return;
    setSaving(true);
    setError('');
    try {
      await api('/flow-studies', 'POST', {
        name: name.trim(),
        input: result.input,
        expectedDatasetVersion: dataset.version
      });
      setRevision((old) => old + 1);
      setSavedPage(1);
      setName('');
      notify?.('Модель потока сохранена');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setSaving(false);
    }
  }
  function load(study) {
    const storedInput = study.input ?? study.data?.input;
    if (!storedInput) {
      setError('В сохранённой модели нет конфигурации.');
      return;
    }
    setInput({
      ...storedInput,
      datasetId: dataset.id,
      expectedDatasetVersion: dataset.version,
      assumptionsConfirmed: false
    });
    setLoadNotice(
      `Загружены условия «${study.name ?? study.data?.name}». Подтвердите их и пересчитайте на текущей версии данных.`
    );
    setResult(null);
    setError('');
  }
  const snapshot = result?.timeline[Math.min(sample, result.timeline.length - 1)];
  const comparable =
    baseline &&
    result &&
    baseline.horizonMinutes === result.horizonMinutes &&
    baseline.conservation.totalInitial === result.conservation.totalInitial &&
    baseline.datasetVersion === result.datasetVersion &&
    baseline.input.materialCount === result.input.materialCount &&
    baseline.input.stages.map((s) => `${s.stageId}:${s.initialWip}`).join('|') ===
      result.input.stages.map((s) => `${s.stageId}:${s.initialWip}`).join('|');

  return (
    <div className="flow-lab">
      <div className="page-intro">
        <div>
          <h2>Поток под нагрузкой</h2>
          <p>
            Проверьте, где детали ждут, какие станки блокируются и сколько изделий дойдёт до выхода.
          </p>
        </div>
      </div>
      <div className="flow-context">
        <strong>Сценарий с явными условиями</strong>
        <p>
          В исходных данных есть выпуск и суммарные простои, но нет вместимости буферов, числа
          станков и времени начала остановок. Эти параметры задаются здесь. Модель не выдаёт их за
          измерения завода.
        </p>
      </div>
      <ErrorBox>{error}</ErrorBox>
      <form onSubmit={simulate} className="flow-editor">
        <div className="flow-toolbar">
          <Field label="Период, мин" hint="Изначально — длительность смены из настроек набора">
            <input
              required
              type="number"
              min="1"
              max="1440"
              step="any"
              value={input.horizonMinutes}
              onChange={(event) => setInput({ ...input, horizonMinutes: event.target.value })}
            />
          </Field>
          <Field label="Деталей на входе, шт." hint="Укажите конечный запас перед первым участком">
            <input
              required
              type="number"
              min="0"
              max="2000"
              step="1"
              value={input.materialCount}
              onChange={(event) => setInput({ ...input, materialCount: event.target.value })}
            />
          </Field>
          <Button type="button" onClick={simpleLine}>
            Задать простую линию
          </Button>
        </div>
        {loadNotice && (
          <p className="flow-notice" role="status">
            {loadNotice}
          </p>
        )}
        <div className="flow-route-heading">
          <h3>Маршрут детали</h3>
          <p>
            Буфер перед участком. Ноль — прямая передача. НЗП — детали в очереди в начале периода.
          </p>
        </div>
        {input.stages.map((stage, index) => {
          const reference = stageReferences.find((entry) => entry.id === stage.stageId);
          return (
            <section
              className="flow-stage-editor"
              key={stage.stageId}
              aria-label={`Условия: ${reference?.name ?? stage.stageId}`}
            >
              <div className="flow-stage-title">
                <h4>
                  <span>{index + 1}</span>
                  {reference?.name ?? stage.stageId}
                </h4>
                <div className="flow-route-controls">
                  <button
                    type="button"
                    disabled={index === 0}
                    onClick={() =>
                      setInput((old) => {
                        const stages = [...old.stages];
                        [stages[index - 1], stages[index]] = [stages[index], stages[index - 1]];
                        return { ...old, stages };
                      })
                    }
                  >
                    Раньше
                  </button>
                  <button
                    type="button"
                    disabled={input.stages.length === 1}
                    onClick={() =>
                      setInput({ ...input, stages: input.stages.filter((_, i) => i !== index) })
                    }
                  >
                    Убрать
                  </button>
                </div>
              </div>
              {reference?.cycle != null && (
                <p className="flow-source">
                  Наблюдаемый темп: {format(reference.cycle, 3)} мин/шт. по записям{' '}
                  {reference.rowIds.join(', ')}. Это ориентир для эквивалентной линии; цикл
                  отдельного станка требует уточнения.
                </p>
              )}
              {onEvidence && reference?.rowIds.length > 0 && (
                <button
                  type="button"
                  className="flow-source-link"
                  onClick={() => onEvidence(reference.rowIds)}
                >
                  Показать исходные записи
                </button>
              )}
              <div className="flow-stage-fields">
                {fields.map(([key, label, min, max, step]) => (
                  <Field key={key} label={label}>
                    <input
                      required
                      type="number"
                      min={min}
                      max={max}
                      step={step}
                      value={stage[key]}
                      onChange={(event) => updateStage(index, key, event.target.value)}
                    />
                  </Field>
                ))}
              </div>
              <details className="flow-downtime">
                <summary>Остановки оборудования · {stage.downtime.length} интервалов</summary>
                <p>
                  Минуты от начала периода. Перекрывающиеся остановки одного станка объединяются.
                  Отсутствие интервалов означает допущение об отсутствии остановок, а не
                  подтверждённый факт.
                </p>
                {stage.downtime.map((stop, stopIndex) => (
                  <div className="flow-stop-row" key={stopIndex}>
                    <Field label="Станок №">
                      <input
                        required
                        type="number"
                        min="1"
                        max={Number(stage.machines) || 8}
                        step="1"
                        value={stop.machine}
                        onChange={(event) =>
                          updateStop(index, stopIndex, 'machine', event.target.value)
                        }
                      />
                    </Field>
                    <Field label="Начало, мин">
                      <input
                        required
                        type="number"
                        min="0"
                        max={input.horizonMinutes}
                        step="any"
                        value={stop.startMinute}
                        onChange={(event) =>
                          updateStop(index, stopIndex, 'startMinute', event.target.value)
                        }
                      />
                    </Field>
                    <Field label="Конец, мин">
                      <input
                        required
                        type="number"
                        min="0"
                        max={input.horizonMinutes}
                        step="any"
                        value={stop.endMinute}
                        onChange={(event) =>
                          updateStop(index, stopIndex, 'endMinute', event.target.value)
                        }
                      />
                    </Field>
                    <button
                      type="button"
                      onClick={() =>
                        updateStage(
                          index,
                          'downtime',
                          stage.downtime.filter((_, i) => i !== stopIndex)
                        )
                      }
                      aria-label={`Удалить остановку ${stopIndex + 1} участка ${reference?.name}`}
                    >
                      Удалить
                    </button>
                  </div>
                ))}
                <Button
                  type="button"
                  disabled={stage.downtime.length >= 50}
                  onClick={() =>
                    updateStage(index, 'downtime', [
                      ...stage.downtime,
                      { machine: '', startMinute: '', endMinute: '' }
                    ])
                  }
                >
                  Добавить остановку
                </Button>
              </details>
            </section>
          );
        })}
        {stageReferences.some(
          (stage) => !input.stages.some((entry) => entry.stageId === stage.id)
        ) && (
          <Field label="Добавить участок в маршрут">
            <select
              value=""
              onChange={(event) => {
                if (event.target.value)
                  setInput({
                    ...input,
                    stages: [
                      ...input.stages,
                      {
                        stageId: event.target.value,
                        machines: '',
                        cycleMinutes: '',
                        bufferCapacity: '',
                        initialWip: '',
                        reworkEvery: '',
                        maxRework: '',
                        downtime: []
                      }
                    ]
                  });
              }}
            >
              <option value="">Выберите участок</option>
              {stageReferences
                .filter((stage) => !input.stages.some((entry) => entry.stageId === stage.id))
                .map((stage) => (
                  <option key={stage.id} value={stage.id}>
                    {stage.name}
                  </option>
                ))}
            </select>
          </Field>
        )}
        <p className="flow-source">
          Передел — условный режим: каждая N-я поступившая деталь проходит ещё заданное число циклов
          на том же станке, затем принимается. Два нуля отключают передел.
        </p>
        <label className="flow-confirm">
          <input
            type="checkbox"
            required
            checked={input.assumptionsConfirmed}
            onChange={(event) => setInput({ ...input, assumptionsConfirmed: event.target.checked })}
          />
          <span>
            Я проверил параметры сценария. Неизвестные параметры заданы как допущения; результат
            требует проверки на линии.
          </span>
        </label>
        <div className="flow-actions">
          <Button type="submit" tone="primary" disabled={busy}>
            {busy ? 'Рассчитываем движение деталей…' : 'Рассчитать поток'}
          </Button>
          {stale && <span role="status">Условия изменены. Пересчитайте результат.</span>}
        </div>
      </form>

      {result && (
        <section
          className={`flow-result${stale ? ' is-stale' : ''}`}
          aria-label="Результат моделирования"
        >
          <div className="flow-result-heading">
            <div>
              <h3>Куда пришёл поток</h3>
              <p>
                За {format(result.horizonMinutes)} минут · версия данных {result.datasetVersion}
              </p>
            </div>
            <div className="flow-actions">
              <Button onClick={() => setBaseline(result)} disabled={stale}>
                Взять за основу сравнения
              </Button>
              <Button
                onClick={() =>
                  downloadJson(
                    { ...result, baseline: comparable ? baseline : undefined },
                    'qarqyn-flow-study.json'
                  )
                }
                disabled={stale}
              >
                Скачать расчёт
              </Button>
            </div>
          </div>
          <div className="flow-balance">
            <div>
              <strong>{format(result.completed)}</strong>
              <span>готовых изделий</span>
            </div>
            <div>
              <strong>{format(result.conservation.remainingWip)}</strong>
              <span>осталось на линии</span>
            </div>
            <div>
              <strong>{format(result.conservation.unreleased)}</strong>
              <span>ещё на входе</span>
            </div>
            <p>
              Баланс: {format(result.conservation.totalInitial)} = {format(result.completed)} +{' '}
              {format(result.conservation.remainingWip)} + {format(result.conservation.unreleased)}.{' '}
              {result.conservation.difference === 0
                ? 'Все детали учтены.'
                : 'Обнаружено расхождение.'}
            </p>
          </div>
          {baseline && (
            <div className="flow-comparison" role="status">
              {comparable ? (
                <>
                  <strong>
                    {result.completed - baseline.completed > 0 ? '+' : ''}
                    {format(result.completed - baseline.completed)} изделий
                  </strong>
                  <span>
                    к сохранённой основе: {format(baseline.completed)} → {format(result.completed)}{' '}
                    при одинаковом периоде, входе и начальном НЗП.
                  </span>
                </>
              ) : (
                <p>
                  Основа сравнения сохранена. Для корректного сравнения верните тот же период,
                  запас, начальный НЗП и маршрут.
                </p>
              )}
              <button onClick={() => setBaseline(null)}>Убрать сравнение</button>
            </div>
          )}
          <div className="flow-playhead">
            <div>
              <h4>Движение во времени</h4>
              <output>
                {format(snapshot?.minute, 1)} мин · {format(snapshot?.completed)} готово
              </output>
            </div>
            <input
              aria-label="Момент расчётного периода"
              type="range"
              min="0"
              max={result.timeline.length - 1}
              step="1"
              value={sample}
              onChange={(event) => setSample(Number(event.target.value))}
            />
            <div className="flow-mini-route">
              {snapshot?.stages.map((stage) => (
                <div key={stage.stageId}>
                  <strong>
                    {result.stages.find((entry) => entry.stageId === stage.stageId)?.name}
                  </strong>
                  <span>
                    {stage.queued} в очереди · {stage.inMachines} в станках
                  </span>
                  {stage.blocked > 0 && <em>{stage.blocked} ждут передачи</em>}
                </div>
              ))}
            </div>
          </div>
          <div className="flow-legend">
            {Object.entries(labels).map(([key, label]) => (
              <span key={key}>
                <i className={`flow-swatch ${key}`} />
                {label}
              </span>
            ))}
          </div>
          <div className="flow-capacity">
            {result.stages.map((stage) => (
              <div className="flow-capacity-row" key={stage.stageId}>
                <div>
                  <strong>{stage.name}</strong>
                  <span>
                    Пиковая очередь {stage.queuePeak} · средняя {format(stage.averageQueue, 1)} ·
                    переделов {stage.reworkPasses}
                  </span>
                </div>
                <div
                  className="flow-state-bar"
                  role="img"
                  aria-label={Object.entries(stage.machineMinutes)
                    .map(([key, minutes]) => `${labels[key]}: ${format(minutes, 1)} станко-минут`)
                    .join('; ')}
                >
                  {Object.entries(stage.machineMinutes).map(([key, minutes]) => (
                    <span
                      className={key}
                      key={key}
                      style={{
                        width: `${(minutes / (result.horizonMinutes * stage.machines.length)) * 100}%`
                      }}
                      title={`${labels[key]}: ${format(minutes, 1)} станко-мин`}
                    />
                  ))}
                </div>
                <div className="flow-state-values">
                  {Object.entries(stage.machineMinutes).map(([key, minutes]) => (
                    <span key={key}>
                      {labels[key]} <b>{format(minutes, 1)}</b>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="flow-source">
            Время указано в станко-минутах: у двух станков за 60 минут всего 120 станко-минут.
            Остановка имеет приоритет над блокировкой в учёте времени. Среднее время завершённых
            деталей в модели: {format(result.meanLeadMinutes, 1)} мин. Для начального НЗП
            учитывается только оставшееся время с начала расчёта; предыдущая длительность нахождения
            на линии неизвестна.
          </p>
          <details className="flow-model-notes">
            <summary>Как устроен расчёт и что он не учитывает</summary>
            <ul>
              {result.assumptions.map((assumption) => (
                <li key={assumption}>{assumption}</li>
              ))}
            </ul>
          </details>
          {canWrite && (
            <div className="flow-save">
              <Field label="Название модели">
                <input
                  maxLength="100"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Например: буфер перед окраской"
                />
              </Field>
              <Button onClick={save} disabled={!name.trim() || stale || saving}>
                {saving ? 'Сохраняем…' : 'Сохранить модель'}
              </Button>
            </div>
          )}
        </section>
      )}
      <section className="flow-saved">
        <h3>Сохранённые модели</h3>
        <ErrorBox>{saved.error}</ErrorBox>
        {saved.loading ? (
          <Loading />
        ) : saved.data?.items?.length ? (
          <ul>
            {saved.data.items.map((study) => (
              <li key={study.id}>
                <div>
                  <strong>{study.name ?? study.data?.name}</strong>
                  <span>Версия модели {study.version}</span>
                </div>
                <div className="flow-actions">
                  <Button onClick={() => load(study)}>Загрузить условия</Button>
                  {canWrite && (
                    <Button tone="danger" onClick={() => setDeleting(study)}>
                      Удалить
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="Моделей пока нет">
            Рассчитайте поток и сохраните условия, чтобы повторить проверку или сравнить изменения.
          </Empty>
        )}
        {saved.data && (
          <Pagination
            page={savedPage}
            pageSize={20}
            total={saved.data.total}
            onChange={setSavedPage}
            disabled={saved.loading}
          />
        )}
      </section>
      {deleting && (
        <Confirm
          title="Удалить сохранённую модель?"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api(`/flow-studies/${deleting.id}`, 'DELETE', { version: deleting.version });
            if (saved.data?.items?.length === 1 && savedPage > 1) setSavedPage((old) => old - 1);
            setRevision((old) => old + 1);
            notify?.('Модель потока удалена');
          }}
        >
          {deleting.name}. Исходные производственные записи сохранятся.
        </Confirm>
      )}
    </div>
  );
}

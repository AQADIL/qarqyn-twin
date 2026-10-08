import { useEffect, useRef, useState } from 'react';
import { api, downloadJson, format } from './api.js';
import ImportData from './ImportData.jsx';
import { Icon } from './icons.jsx';
import {
  Button,
  Field,
  Modal,
  Confirm,
  ErrorBox,
  Loading,
  Pagination,
  labels,
  useResource
} from './ui.jsx';
const groups = {
  production: 'Производство',
  quality: 'Качество',
  downtime: 'Простои',
  plans: 'План моделей'
};
const columns = {
  production: [
    'id',
    'date',
    'stageId',
    'line',
    'plan',
    'actual',
    'runtimeHours',
    'utilizationPct',
    'periodHours',
    'regime'
  ],
  quality: ['id', 'date', 'stageId', 'produced', 'defects', 'reportedPct'],
  downtime: ['id', 'date', 'stageId', 'equipment', 'reason', 'minutes', 'classification'],
  plans: ['id', 'model', 'quantity']
};
const numeric = new Set([
  'plan',
  'actual',
  'periodHours',
  'runtimeHours',
  'utilizationPct',
  'produced',
  'defects',
  'reportedPct',
  'minutes',
  'quantity'
]);
export default function Data({ dataset, canWrite, refresh, selectDataset, notify }) {
  const [group, setGroup] = useState('production'),
    [row, setRow] = useState(null),
    [deleting, remove] = useState(null),
    [settings, setSettings] = useState(false);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [deleteDataset, setDeleteDataset] = useState(false);
  const [importing, setImporting] = useState(null),
    [history, setHistory] = useState(false),
    [search, setSearch] = useState(''),
    [dateFilter, setDateFilter] = useState(''),
    [sort, setSort] = useState('date'),
    [direction, setDirection] = useState(1),
    [page, setPage] = useState(1);
  useEffect(() => setPage(1), [search, dateFilter, group, sort, direction]);
  const filteredRows = dataset.data[group]
    .map((item, index) => ({ item, index }))
    .filter(
      ({ item }) =>
        (group === 'plans' || !dateFilter || item.date === dateFilter) &&
        Object.values(item)
          .join(' ')
          .toLocaleLowerCase('ru')
          .includes(search.toLocaleLowerCase('ru'))
    )
    .sort((left, right) => {
      const a = left.item[sort],
        b = right.item[sort];
      return (
        direction *
        (typeof a === 'number' && typeof b === 'number'
          ? a - b
          : String(a ?? '').localeCompare(String(b ?? ''), 'ru', { numeric: true }))
      );
    });
  const visibleRows = filteredRows.slice((page - 1) * 25, page * 25);
  useEffect(
    () => setPage((current) => Math.min(current, Math.max(1, Math.ceil(filteredRows.length / 25)))),
    [filteredRows.length]
  );
  const file = useRef(null),
    editable = canWrite && !dataset.seed;
  async function copy() {
    setBusy(true);
    setError('');
    try {
      const result = await api('/datasets', 'POST', {
        ...dataset.data,
        name: `${dataset.data.name.slice(0, 80)} · рабочая копия`
      });
      await refresh();
      selectDataset(result.id);
      notify('Рабочая копия создана');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function importFile(event) {
    const selected = event.target.files?.[0];
    if (selected) setImporting(selected);
    event.target.value = '';
  }
  async function updateData(data, snapshot) {
    await api(`/datasets/${snapshot.id}`, 'PUT', { version: snapshot.version, data });
    await refresh();
  }
  return (
    <>
      <div className="page-intro">
        <div>
          <span className="eyebrow">ИСТОЧНИК ПРАВДЫ</span>
          <h2>Данные производства</h2>
          <p>{dataset.data.source.description}</p>
        </div>
        <div className="row-actions">
          <Button onClick={() => setHistory(true)}>История версий</Button>
          <Button icon="download" onClick={() => downloadJson(dataset.data, 'qarqyn-dataset.json')}>
            JSON
          </Button>
          <Button icon="plus" disabled={!canWrite || busy} onClick={() => file.current.click()}>
            Импортировать
          </Button>
          <input
            ref={file}
            type="file"
            accept=".json,.csv,.xlsx,application/json,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="visually-hidden"
            aria-label="Импортировать JSON, CSV или XLSX"
            onChange={importFile}
          />
        </div>
      </div>
      <ErrorBox>{error}</ErrorBox>
      <div className="dataset-banner">
        <Icon name={dataset.seed ? 'lock' : 'data'} size={32} />
        <div>
          <strong>{dataset.seed ? 'Исходный набор защищён' : dataset.data.name}</strong>
          <p>
            {dataset.seed
              ? 'Для редактирования создайте рабочую копию. Оригинал останется доступен для сравнения.'
              : `Рабочий набор · версия ${dataset.version}. Изменения проверяются сервером и записываются в журнал.`}
          </p>
        </div>
        {dataset.seed ? (
          <Button disabled={!canWrite || busy} onClick={copy}>
            {busy ? 'Создаём…' : 'Создать копию'}
          </Button>
        ) : (
          <div className="row-actions">
            <Button disabled={!editable} onClick={() => setSettings(dataset)}>
              Параметры
            </Button>
            <button
              className="icon-button"
              disabled={!editable}
              onClick={() => setDeleteDataset(dataset)}
              aria-label="Удалить набор данных"
            >
              <Icon name="delete" />
            </button>
          </div>
        )}
      </div>
      <div className="data-tabs" role="tablist" aria-label="Категория данных">
        {Object.entries(groups).map(([key, name]) => (
          <button
            id={`tab-${key}`}
            key={key}
            role="tab"
            tabIndex={group === key ? 0 : -1}
            onKeyDown={(event) => {
              const keys = Object.keys(groups),
                index = keys.indexOf(group);
              const next =
                event.key === 'ArrowRight'
                  ? (index + 1) % keys.length
                  : event.key === 'ArrowLeft'
                    ? (index + keys.length - 1) % keys.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? keys.length - 1
                        : null;
              if (next !== null) {
                event.preventDefault();
                setGroup(keys[next]);
                document.getElementById(`tab-${keys[next]}`)?.focus();
              }
            }}
            aria-selected={group === key}
            aria-controls="data-panel"
            onClick={() => setGroup(key)}
          >
            {name}
            <span>{dataset.data[key].length}</span>
          </button>
        ))}
      </div>
      <section id="data-panel" role="tabpanel" aria-labelledby={`tab-${group}`}>
        <div className="section-head">
          <h3>{groups[group]}</h3>
          <Button
            disabled={!editable}
            icon="plus"
            onClick={() => setRow({ item: {}, index: -1, snapshot: dataset })}
          >
            Добавить запись
          </Button>
        </div>
        <div className="form-grid">
          <Field label="Поиск по записям">
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </Field>
          {group !== 'plans' && (
            <Field label="Дата">
              <input
                type="date"
                value={dateFilter}
                onChange={(event) => setDateFilter(event.target.value)}
              />
            </Field>
          )}
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {columns[group].map((key) => (
                  <th
                    key={key}
                    aria-sort={
                      sort === key ? (direction === 1 ? 'ascending' : 'descending') : 'none'
                    }
                  >
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => {
                        setDirection(sort === key ? -direction : 1);
                        setSort(key);
                      }}
                    >
                      {labels[key]}
                      {sort === key ? (direction === 1 ? ' ↑' : ' ↓') : ''}
                    </button>
                  </th>
                ))}
                {editable && <th>Действия</th>}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map(({ item: r, index }) => (
                <tr key={r.id}>
                  {columns[group].map((key) => (
                    <td key={key}>
                      {key === 'stageId'
                        ? dataset.data.stages.find((s) => s.id === r[key])?.name
                        : key === 'classification'
                          ? {
                              planned: 'Плановое',
                              unplanned: 'Внеплановое',
                              unknown: 'Не классифицировано'
                            }[r[key]] || 'По исходной записи'
                          : numeric.has(key)
                            ? format(r[key], 2)
                            : r[key]}
                    </td>
                  ))}
                  {editable && (
                    <td>
                      <div className="row-actions">
                        <button
                          className="icon-button"
                          aria-label={`Изменить ${r.id}`}
                          onClick={() => setRow({ item: r, index, snapshot: dataset })}
                        >
                          <Icon name="edit" size={18} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`Удалить ${r.id}`}
                          onClick={() => remove({ item: r, index, snapshot: dataset })}
                        >
                          <Icon name="delete" size={18} />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {!filteredRows.length && <p className="empty">Нет записей по выбранным условиям.</p>}
        </div>
        <Pagination page={page} pageSize={25} total={filteredRows.length} onChange={setPage} />
      </section>
      {importing && (
        <ImportData
          file={importing}
          dataset={dataset}
          initialGroup={group}
          onClose={() => setImporting(null)}
          onImported={async (id) => {
            setImporting(null);
            await refresh();
            selectDataset(id);
            notify('Набор импортирован после проверки');
          }}
        />
      )}
      {history && (
        <DatasetHistory
          dataset={dataset}
          editable={editable}
          onClose={() => setHistory(false)}
          onRestored={async () => {
            await refresh();
            setHistory(false);
            notify('Версия восстановлена как новая запись истории');
          }}
        />
      )}
      <div className="data-footnote">
        <Icon name="source" />
        <p>
          При импорте проверяются типы, допустимые значения, уникальность ID и связи участков. JSON
          можно получить кнопкой выше. Записи не превращаются в «живую телеметрию».
        </p>
      </div>
      {row && (
        <RowForm
          group={group}
          row={row}
          stages={row.snapshot.data.stages}
          onClose={() => setRow(null)}
          onSave={async (item) => {
            const rows = [...row.snapshot.data[group]];
            if (row.index < 0) rows.push(item);
            else rows[row.index] = item;
            await updateData({ ...row.snapshot.data, [group]: rows }, row.snapshot);
            setRow(null);
            notify('Запись сохранена');
          }}
        />
      )}{' '}
      {deleting && (
        <Confirm
          title={`Удалить запись ${deleting.item.id}?`}
          onClose={() => remove(null)}
          onConfirm={async () => {
            await updateData(
              {
                ...deleting.snapshot.data,
                [group]: deleting.snapshot.data[group].filter(
                  (record) => record.id !== deleting.item.id
                )
              },
              deleting.snapshot
            );
            notify('Запись удалена');
          }}
        >
          Связанные показатели пересчитаются. Последнюю производственную запись участка удалить
          нельзя.
        </Confirm>
      )}{' '}
      {deleteDataset && (
        <Confirm
          title="Удалить рабочий набор?"
          onClose={() => setDeleteDataset(false)}
          onConfirm={async () => {
            await api(`/datasets/${deleteDataset.id}`, 'DELETE', {
              version: deleteDataset.version
            });
            selectDataset('allur');
            await refresh();
            notify('Рабочий набор удалён');
          }}
        >
          Также будут удалены сценарии и задачи этого набора.
        </Confirm>
      )}{' '}
      {settings && (
        <DatasetSettings
          dataset={settings}
          onClose={() => setSettings(false)}
          onSave={async (data) => {
            await updateData(data, settings);
            setSettings(false);
            notify('Параметры сохранены');
          }}
        />
      )}
    </>
  );
}
function RowForm({ group, row, stages, onClose, onSave }) {
  const [values, setValues] = useState({
      ...row.item,
      ...(group === 'downtime' && row.index < 0 ? { classification: 'unknown' } : {})
    }),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <Modal
      title={row.index < 0 ? 'Добавить запись' : `Изменить ${row.item.id}`}
      onClose={onClose}
      pending={busy}
      guardChanges
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const item = {};
            for (const key of columns[group]) {
              if (
                ['reportedPct', 'periodHours', 'regime', 'classification'].includes(key) &&
                (values[key] === undefined || values[key] === '')
              )
                continue;
              item[key] = numeric.has(key) ? Number(values[key]) : values[key];
            }
            await onSave(item);
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-grid">
          {columns[group].map((key) => (
            <Field
              key={key}
              label={labels[key]}
              hint={
                key === 'id'
                  ? 'Латинские буквы, цифры, _ или -'
                  : key === 'reportedPct'
                    ? 'Необязательно. Показатели считаются из количества.'
                    : null
              }
            >
              {key === 'classification' ? (
                <select
                  value={values.classification ?? ''}
                  onChange={(event) => setValues({ ...values, classification: event.target.value })}
                >
                  <option value="">По исходной причине · тип не задан</option>
                  <option value="unknown">Не классифицировано</option>
                  <option value="planned">Плановое обслуживание</option>
                  <option value="unplanned">Внеплановый простой</option>
                </select>
              ) : key === 'stageId' ? (
                <select
                  required
                  value={values[key] || ''}
                  onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                >
                  <option value="" disabled>
                    Выберите участок
                  </option>
                  {stages
                    .filter((s) => (group === 'production' ? s.kind === 'production' : true))
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
              ) : (
                <input
                  required={
                    !['reportedPct', 'periodHours', 'regime', 'classification'].includes(key)
                  }
                  type={numeric.has(key) ? 'number' : key === 'date' ? 'date' : 'text'}
                  step={
                    [
                      'runtimeHours',
                      'periodHours',
                      'utilizationPct',
                      'minutes',
                      'reportedPct'
                    ].includes(key)
                      ? 'any'
                      : '1'
                  }
                  min={key === 'periodHours' ? 1 : numeric.has(key) ? '0' : undefined}
                  max={
                    key === 'periodHours' || key === 'runtimeHours'
                      ? 24
                      : ['utilizationPct', 'reportedPct'].includes(key)
                        ? 100
                        : undefined
                  }
                  maxLength={key === 'reason' ? 500 : 100}
                  value={values[key] ?? ''}
                  onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                />
              )}
            </Field>
          ))}
        </div>
        <ErrorBox>{error}</ErrorBox>
        <div className="form-actions">
          <Button type="button" data-close-modal disabled={busy}>
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
function DatasetHistory({ dataset, editable, onClose, onRestored }) {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const history = useResource(`/datasets/${dataset.id}/versions?page=${page}&pageSize=15`);
  const snapshot = useResource(selected ? `/datasets/${dataset.id}/versions/${selected}` : null);
  async function restore() {
    setRestoring(true);
    setError('');
    try {
      await api(`/datasets/${dataset.id}/restore`, 'POST', {
        version: dataset.version,
        restoreVersion: selected
      });
      await onRestored();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setRestoring(false);
    }
  }
  return (
    <Modal title="История данных" onClose={onClose} wide pending={restoring}>
      <p>
        Текущая версия: {dataset.version}. Просмотр снимка сохраняет текущие данные. Восстановление
        создаёт следующую версию; прежняя история остаётся доступной.
      </p>
      <ErrorBox>{error || history.error || snapshot.error}</ErrorBox>
      {history.loading ? (
        <Loading />
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Версия</th>
                <th>Дата</th>
                <th>Автор</th>
                <th>Действие</th>
              </tr>
            </thead>
            <tbody>
              {history.data?.items.map((version) => (
                <tr key={version.version}>
                  <td>
                    {version.version}
                    {version.version === dataset.version ? ' · текущая' : ''}
                  </td>
                  <td>
                    {version.createdAt ? new Date(version.createdAt).toLocaleString('ru-RU') : '—'}
                  </td>
                  <td>{version.actor || '—'}</td>
                  <td>
                    <Button
                      disabled={restoring}
                      onClick={() => {
                        setSelected(version.version);
                        setConfirming(false);
                      }}
                    >
                      Открыть снимок
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {history.data && (
        <Pagination
          page={page}
          pageSize={15}
          total={history.data.total}
          onChange={setPage}
          disabled={restoring}
        />
      )}
      {selected && (
        <section>
          <h3>Снимок версии {selected}</h3>
          {snapshot.loading ? (
            <Loading />
          ) : (
            snapshot.data && (
              <>
                <p>{snapshot.data.data.name}</p>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Категория</th>
                        <th>В снимке</th>
                        <th>Сейчас</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(groups).map(([group, name]) => (
                        <tr key={group}>
                          <th>{name}</th>
                          <td>{snapshot.data.data[group].length}</td>
                          <td>{dataset.data[group].length}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="form-actions">
                  <Button
                    onClick={() =>
                      downloadJson(snapshot.data, `qarqyn-${dataset.id}-v${selected}.json`)
                    }
                  >
                    Скачать снимок JSON
                  </Button>
                  <Button
                    disabled={!editable || selected === dataset.version || restoring}
                    onClick={() => setConfirming(true)}
                  >
                    Восстановить эту версию
                  </Button>
                </div>
                {confirming && (
                  <div role="alert">
                    <p>
                      Восстановить записи и параметры версии {selected} вместо текущей версии{' '}
                      {dataset.version}?
                    </p>
                    <div className="row-actions">
                      <Button disabled={restoring} onClick={() => setConfirming(false)}>
                        Отмена
                      </Button>
                      <Button tone="primary" disabled={restoring} onClick={restore}>
                        {restoring ? 'Восстанавливаем…' : 'Восстановить данные'}
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )
          )}
        </section>
      )}
    </Modal>
  );
}
function DatasetSettings({ dataset, onClose, onSave }) {
  const [name, setName] = useState(dataset.data.name),
    [targets, setTargets] = useState(dataset.data.targets),
    [coverage, setCoverage] = useState(dataset.data.observationCoverage || []),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const names = {
    monthlyOutput: 'Месячный выпуск, шт',
    maxDefectPct: 'Порог брака, %',
    maxDowntimeMinutes: 'Порог простоя, мин',
    targetOeePct: 'Целевой OEE, %',
    shiftsPerDay: 'Смен в сутки',
    hoursPerShift: 'Часов в смене'
  };
  return (
    <Modal title="Параметры набора" onClose={onClose} pending={busy} guardChanges>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSave({ ...dataset.data, name, targets, observationCoverage: coverage });
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Название">
          <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="form-grid">
          {Object.entries(names).map(([key, label]) => (
            <Field key={key} label={label}>
              <input
                required
                type="number"
                min="0"
                step="any"
                value={targets[key]}
                onChange={(e) => setTargets({ ...targets, [key]: Number(e.target.value) })}
              />
            </Field>
          ))}
        </div>
        <details>
          <summary>Подтвердить полноту журнала простоев</summary>
          <p>
            Отмечайте только проверенные периоды. Тогда отсутствие события считается нулевым
            простоем; без подтверждения это неизвестное значение.
          </p>
          {[
            ...new Map(
              dataset.data.production.map((row) => [`${row.stageId}:${row.date}`, row])
            ).values()
          ].map((row) => (
            <label className="field" key={`${row.stageId}:${row.date}`}>
              <span>
                <input
                  type="checkbox"
                  checked={coverage.some(
                    (item) =>
                      item.stageId === row.stageId &&
                      item.date === row.date &&
                      item.downtimeComplete
                  )}
                  onChange={(event) =>
                    setCoverage((current) => [
                      ...current.filter(
                        (item) => !(item.stageId === row.stageId && item.date === row.date)
                      ),
                      {
                        stageId: row.stageId,
                        date: row.date,
                        downtimeComplete: event.target.checked
                      }
                    ])
                  }
                />{' '}
                {dataset.data.stages.find((stage) => stage.id === row.stageId)?.name} · {row.date}:
                журнал полон
              </span>
            </label>
          ))}
        </details>
        <ErrorBox>{error}</ErrorBox>
        <div className="form-actions">
          <Button type="button" data-close-modal disabled={busy}>
            Отмена
          </Button>
          <Button tone="primary" disabled={busy}>
            Сохранить
          </Button>
        </div>
      </form>
    </Modal>
  );
}

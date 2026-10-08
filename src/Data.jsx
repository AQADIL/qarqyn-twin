import { useRef, useState } from 'react';
import { api, downloadJson, format } from './api.js';
import { Icon } from './icons.jsx';
import { Button, Field, Modal, Confirm, ErrorBox, labels } from './ui.jsx';
const groups = {
  production: 'Производство',
  quality: 'Качество',
  downtime: 'Простои',
  plans: 'План моделей'
};
const columns = {
  production: ['id', 'date', 'stageId', 'line', 'plan', 'actual', 'runtimeHours', 'utilizationPct'],
  quality: ['id', 'date', 'stageId', 'produced', 'defects', 'reportedPct'],
  downtime: ['id', 'date', 'stageId', 'equipment', 'reason', 'minutes'],
  plans: ['id', 'model', 'quantity']
};
const numeric = new Set([
  'plan',
  'actual',
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
  async function importFile(e) {
    const selected = e.target.files?.[0];
    if (!selected) return;
    setError('');
    setBusy(true);
    try {
      if (selected.size > 2 * 1024 * 1024) throw new Error('Размер файла не должен превышать 2 МБ');
      const data = JSON.parse(await selected.text());
      const result = await api('/datasets', 'POST', data);
      await refresh();
      selectDataset(result.id);
      notify('Набор импортирован');
    } catch (e) {
      setError(
        e instanceof SyntaxError
          ? 'Файл должен содержать корректный JSON. Скачайте текущий набор как пример формата.'
          : e.message
      );
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  }
  async function updateData(data) {
    await api(`/datasets/${dataset.id}`, 'PUT', { version: dataset.version, data });
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
          <Button icon="download" onClick={() => downloadJson(dataset.data, 'qarqyn-dataset.json')}>
            JSON
          </Button>
          <Button icon="plus" disabled={!canWrite || busy} onClick={() => file.current.click()}>
            Импортировать
          </Button>
          <input
            ref={file}
            type="file"
            accept=".json,application/json"
            className="visually-hidden"
            aria-label="Импортировать JSON"
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
            <Button disabled={!editable} onClick={() => setSettings(true)}>
              Параметры
            </Button>
            <button
              className="icon-button"
              disabled={!editable}
              onClick={() => setDeleteDataset(true)}
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
          <Button disabled={!editable} icon="plus" onClick={() => setRow({ item: {}, index: -1 })}>
            Добавить запись
          </Button>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {columns[group].map((key) => (
                  <th key={key}>{labels[key]}</th>
                ))}
                {editable && <th>Действия</th>}
              </tr>
            </thead>
            <tbody>
              {dataset.data[group].map((r, index) => (
                <tr key={r.id}>
                  {columns[group].map((key) => (
                    <td key={key}>
                      {key === 'stageId'
                        ? dataset.data.stages.find((s) => s.id === r[key])?.name
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
                          onClick={() => setRow({ item: r, index })}
                        >
                          <Icon name="edit" size={18} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`Удалить ${r.id}`}
                          onClick={() => remove({ item: r, index })}
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
          {!dataset.data[group].length && <p className="empty">Записей нет.</p>}
        </div>
      </section>
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
          stages={dataset.data.stages}
          onClose={() => setRow(null)}
          onSave={async (item) => {
            const rows = [...dataset.data[group]];
            if (row.index < 0) rows.push(item);
            else rows[row.index] = item;
            await updateData({ ...dataset.data, [group]: rows });
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
            await updateData({
              ...dataset.data,
              [group]: dataset.data[group].filter((_, i) => i !== deleting.index)
            });
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
            await api(`/datasets/${dataset.id}`, 'DELETE', { version: dataset.version });
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
          dataset={dataset}
          onClose={() => setSettings(false)}
          onSave={async (data) => {
            await updateData(data);
            setSettings(false);
            notify('Параметры сохранены');
          }}
        />
      )}
    </>
  );
}
function RowForm({ group, row, stages, onClose, onSave }) {
  const [values, setValues] = useState(row.item),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <Modal title={row.index < 0 ? 'Добавить запись' : `Изменить ${row.item.id}`} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const item = {};
            for (const key of columns[group]) {
              if (key === 'reportedPct' && (values[key] === undefined || values[key] === ''))
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
              {key === 'stageId' ? (
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
                  required={key !== 'reportedPct'}
                  type={numeric.has(key) ? 'number' : key === 'date' ? 'date' : 'text'}
                  step={
                    ['runtimeHours', 'utilizationPct', 'minutes', 'reportedPct'].includes(key)
                      ? 'any'
                      : '1'
                  }
                  min={numeric.has(key) ? '0' : undefined}
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
function DatasetSettings({ dataset, onClose, onSave }) {
  const [name, setName] = useState(dataset.data.name),
    [targets, setTargets] = useState(dataset.data.targets),
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
    <Modal title="Параметры набора" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSave({ ...dataset.data, name, targets });
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
        <ErrorBox>{error}</ErrorBox>
        <div className="form-actions">
          <Button type="button" onClick={onClose}>
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

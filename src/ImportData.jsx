import { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { Button, ErrorBox, Field, Loading, Modal, labels } from './ui.jsx';
import { readImportFile } from './import-data.js';

const emptyRows = [];
const fields = {
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
const numberFields = new Set([
  'plan',
  'actual',
  'runtimeHours',
  'utilizationPct',
  'periodHours',
  'produced',
  'defects',
  'reportedPct',
  'minutes',
  'quantity'
]);
const optionalFields = new Set(['id', 'reportedPct', 'periodHours', 'regime', 'classification']);
const names = {
  production: 'Производство',
  quality: 'Качество',
  downtime: 'Простои',
  plans: 'План моделей'
};

export default function ImportData({ file, dataset, initialGroup, onClose, onImported }) {
  const [loaded, setLoaded] = useState(null),
    [error, setError] = useState(''),
    [issues, setIssues] = useState([]),
    [busy, setBusy] = useState(false);
  const [sheetIndex, setSheetIndex] = useState(0),
    [group, setGroup] = useState(initialGroup),
    [mapping, setMapping] = useState({});
  const [mode, setMode] = useState('replace'),
    [checked, setChecked] = useState(null);
  const [name, setName] = useState(file.name.replace(/\.[^.]+$/, '').slice(0, 100));
  useEffect(() => {
    let active = true;
    readImportFile(file)
      .then((result) => {
        if (active) setLoaded(result);
      })
      .catch((failure) => {
        if (active) setError(failure.message);
      });
    return () => {
      active = false;
    };
  }, [file]);
  const rows = loaded?.sheets?.[sheetIndex]?.rows || emptyRows;
  const headers = rows[0] || [];
  useEffect(() => {
    const next = {};
    for (const field of fields[group]) {
      const index = headers.findIndex((header) =>
        [field, labels[field]]
          .filter(Boolean)
          .some((candidate) => candidate.toLowerCase() === header.trim().toLowerCase())
      );
      if (index >= 0) next[field] = String(index);
    }
    setMapping(next);
    setChecked(null);
  }, [loaded, sheetIndex, group]);
  const preview = useMemo(() => {
    if (!loaded) return { data: null, errors: [] };
    if (loaded.data) return { data: { ...loaded.data, name }, errors: [] };
    const errors = [];
    const imported = rows.slice(1).map((row, index) => {
      const record = {};
      for (const field of fields[group]) {
        let value =
          mapping[field] === undefined || mapping[field] === ''
            ? ''
            : String(row[Number(mapping[field])] ?? '').trim();
        if (!value) {
          if (field === 'id') {
            record.id = `import_${index + 1}_${group}`;
            continue;
          }
          if (!optionalFields.has(field))
            errors.push(`Строка ${index + 2}: не заполнено «${labels[field] || field}»`);
          continue;
        }
        if (field === 'date' && /^\d{2}\.\d{2}\.\d{4}$/.test(value))
          value = value.split('.').reverse().join('-');
        if (field === 'stageId')
          value =
            dataset.data.stages.find(
              (stage) => stage.id === value || stage.name.toLowerCase() === value.toLowerCase()
            )?.id || value;
        if (numberFields.has(field)) {
          value = Number(value.replace(/\s/g, '').replace(',', '.'));
          if (!Number.isFinite(value))
            errors.push(`Строка ${index + 2}: «${labels[field] || field}» должно быть числом`);
        }
        record[field] = value;
      }
      return record;
    });
    const data = {
      ...dataset.data,
      name,
      source: {
        name: file.name,
        kind: 'user-import',
        description: `Импорт ${names[group]} из ${file.name}; остальные категории перенесены из «${dataset.data.name}».`
      },
      [group]: mode === 'append' ? [...dataset.data[group], ...imported] : imported
    };
    return { data, errors };
  }, [loaded, mapping, group, rows, mode, dataset, name, file.name]);
  async function validate() {
    if (!preview.data || preview.errors.length) return;
    setBusy(true);
    setError('');
    setIssues([]);
    try {
      await api('/datasets/validate', 'POST', { data: preview.data });
      setChecked(preview.data);
    } catch (failure) {
      setChecked(null);
      setError(failure.message);
      setIssues(failure.issues || []);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!checked || checked !== preview.data) return;
    setBusy(true);
    setError('');
    try {
      const result = await api('/datasets', 'POST', checked);
      onImported(result.id);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Проверка импорта" wide onClose={onClose} pending={busy} guardChanges>
      <ErrorBox>{error}</ErrorBox>
      {issues.length > 0 && (
        <ul>
          {issues.slice(0, 20).map((issue, index) => (
            <li key={index}>
              {Array.isArray(issue.path) ? issue.path.join('.') : issue.path}: {issue.message}
            </li>
          ))}
        </ul>
      )}
      {!loaded && !error && <Loading label="Читаем файл…" />}
      {loaded && (
        <>
          <p>Будет создан отдельный набор. Текущие данные не изменятся.</p>
          <Field label="Название нового набора">
            <input
              value={name}
              maxLength={100}
              required
              onChange={(event) => {
                setName(event.target.value);
                setChecked(null);
              }}
            />
          </Field>
          {!loaded.data && (
            <>
              <div className="form-grid">
                <Field label="Лист">
                  <select
                    value={sheetIndex}
                    onChange={(event) => setSheetIndex(Number(event.target.value))}
                  >
                    {loaded.sheets.map((sheet, index) => (
                      <option key={index} value={index}>
                        {sheet.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Категория">
                  <select value={group} onChange={(event) => setGroup(event.target.value)}>
                    {Object.entries(names).map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="Что делать с выбранной категорией в копии">
                <select
                  value={mode}
                  onChange={(event) => {
                    setMode(event.target.value);
                    setChecked(null);
                  }}
                >
                  <option value="replace">Заменить строки категории</option>
                  <option value="append">Добавить к имеющимся строкам</option>
                </select>
              </Field>
              <p>
                Остальные категории и параметры будут скопированы из текущего набора. Сопоставьте
                колонки; даты принимаются в формате ГГГГ-ММ-ДД или ДД.ММ.ГГГГ. Формулы XLSX не
                исполняются: используются сохранённые в файле значения.
              </p>
              <div className="form-grid">
                {fields[group].map((field) => (
                  <Field
                    key={field}
                    label={`${labels[field] || field}${optionalFields.has(field) ? ' · необязательно' : ''}`}
                  >
                    <select
                      value={mapping[field] ?? ''}
                      onChange={(event) => {
                        setMapping((current) => ({ ...current, [field]: event.target.value }));
                        setChecked(null);
                      }}
                    >
                      <option value="">Не выбрано</option>
                      {headers.map((header, index) => (
                        <option key={index} value={index}>
                          {index + 1}. {header || 'Без названия'}
                        </option>
                      ))}
                    </select>
                  </Field>
                ))}
              </div>
              <p>
                Строк: {Math.max(0, rows.length - 1)}. Без колонки ID присваиваются идентификаторы
                import_номер_категория. При добавлении проверьте их уникальность.
              </p>
              <div className="table-scroll">
                <table>
                  <caption>Первые 5 строк файла</caption>
                  <thead>
                    <tr>
                      {headers.map((header, index) => (
                        <th key={index}>{header}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(1, 6).map((row, index) => (
                      <tr key={index}>
                        {headers.map((_, column) => (
                          <td key={column}>{row[column]}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {loaded.data && (
            <p>
              {Object.keys(names)
                .map(
                  (key) =>
                    `${names[key]}: ${Array.isArray(loaded.data[key]) ? loaded.data[key].length : 'неверный формат'}`
                )
                .join(' · ')}
            </p>
          )}
          {preview.errors.length > 0 && (
            <ErrorBox>
              {preview.errors.slice(0, 8).join('; ')}
              {preview.errors.length > 8 ? `; ещё ошибок: ${preview.errors.length - 8}` : ''}
            </ErrorBox>
          )}
          {checked === preview.data && (
            <p role="status">Проверка структуры и связей пройдена. Можно создать набор.</p>
          )}
          <div className="form-actions">
            <Button data-close-modal disabled={busy}>
              Отмена
            </Button>
            <Button disabled={busy || preview.errors.length > 0 || !name.trim()} onClick={validate}>
              Проверить на сервере
            </Button>
            <Button tone="primary" disabled={busy || checked !== preview.data} onClick={save}>
              Создать набор
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

import { useEffect, useState } from 'react';
import { api } from './api.js';
import { takeWorkflow, consumeWorkflow } from './workflow.js';
import { Icon } from './icons.jsx';
import {
  Button,
  Field,
  Modal,
  Confirm,
  ErrorBox,
  Empty,
  Loading,
  Pagination,
  useResource
} from './ui.jsx';
const statuses = { open: 'Открыто', investigating: 'В работе', resolved: 'Решено' };
const priorities = { normal: 'Обычный', high: 'Высокий', critical: 'Критический' };
export default function Incidents({ analysis, canWrite, notify, evidence }) {
  const [handoff] = useState(() => takeWorkflow('incidents', analysis.datasetId));
  useEffect(() => consumeWorkflow('incidents', handoff), [handoff]);
  const [page, setPage] = useState(1),
    [query, setQuery] = useState('');
  const [revision, revise] = useState(0),
    [editing, edit] = useState(
      handoff
        ? {
            title: handoff.title,
            description: handoff.description,
            stageId: handoff.stageId ?? null
          }
        : null
    ),
    [deleting, remove] = useState(null),
    [filter, setFilter] = useState('all');
  useEffect(() => setPage(1), [filter, query]);
  const state = useResource(
    `/incidents?datasetId=${analysis.datasetId}&page=${page}&pageSize=20&status=${filter}&q=${encodeURIComponent(query)}`,
    revision
  );
  const rows = state.data?.items;
  return (
    <>
      <div className="page-intro">
        <div>
          <span className="eyebrow">ОТ СИГНАЛА К ДЕЙСТВИЮ</span>
          <h2>Контроль отклонений</h2>
          <p>Сигналы рассчитаны по данным. Задачи для проверки создаёт инженер.</p>
        </div>
        <Button tone="primary" icon="plus" disabled={!canWrite} onClick={() => edit({})}>
          Создать задачу
        </Button>
      </div>
      <section className="signals-table">
        <h3>
          Автоматические сигналы <span className="count">{analysis.findings.length}</span>
        </h3>
        {analysis.findings.map((f) => (
          <article key={f.id}>
            <span className={`signal ${f.severity}`} />
            <div>
              <h3>{f.title}</h3>
              <p>{f.detail}</p>
              <small>{f.action}</small>
            </div>
            <div className="row-actions">
              <Button onClick={() => evidence(f.sourceIds)} icon="source">
                Источники
              </Button>
              {canWrite && (
                <Button
                  onClick={() =>
                    edit({
                      title: f.title,
                      description: `${f.detail}\n${f.action}\nИсточники: ${f.sourceIds.join(', ')}`,
                      stageId: f.stageId || null,
                      priority: f.severity === 'high' ? 'high' : 'normal'
                    })
                  }
                >
                  В задачу
                </Button>
              )}
            </div>
          </article>
        ))}
      </section>
      <section className="incident-section">
        <Field label="Поиск задач">
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
        </Field>
        <div className="section-head">
          <h2>Журнал задач</h2>
          <Field label="Статус">
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="all">Все статусы</option>
              {Object.entries(statuses).map(([key, label]) => (
                <option value={key} key={key}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {!canWrite && (
          <p className="notice">
            В демо доступны исходные сигналы. Для создания и просмотра рабочих задач войдите как
            редактор.
          </p>
        )}
        <ErrorBox>{state.error}</ErrorBox>
        {state.loading ? (
          <Loading />
        ) : rows?.length ? (
          <div className="task-list">
            {rows.map((r) => (
              <article key={r.id}>
                <div>
                  <span className={`status-tag ${r.status}`}>{statuses[r.status]}</span>
                  <span className="task-priority">{priorities[r.priority]} приоритет</span>
                </div>
                <h3>{r.title}</h3>
                <p className="preserve-lines">{r.description}</p>
                <p>
                  {r.assignee ? `Ответственный: ${r.assignee}` : 'Ответственный не назначен'}
                  {r.dueDate ? ` · Срок: ${r.dueDate}` : ''}
                </p>
                {r.resolutionNote && <p>Результат проверки: {r.resolutionNote}</p>}
                <footer>
                  <small>
                    {analysis.stages.find((s) => s.id === r.stageId)?.name ||
                      'Общепроизводственная задача'}{' '}
                    · {new Date(r.updatedAt).toLocaleString('ru-RU')}
                  </small>
                  <div className="row-actions">
                    <Button icon="edit" disabled={!canWrite} onClick={() => edit(r)}>
                      Изменить
                    </Button>
                    <button
                      className="icon-button"
                      disabled={!canWrite}
                      onClick={() => remove(r)}
                      aria-label={`Удалить задачу ${r.title}`}
                    >
                      <Icon name="delete" />
                    </button>
                  </div>
                </footer>
              </article>
            ))}
          </div>
        ) : (
          <Empty title="Нет задач в выбранном статусе">
            Создайте задачу из сигнала или добавьте наблюдение вручную.
          </Empty>
        )}
        {state.data && (
          <Pagination page={page} pageSize={20} total={state.data.total} onChange={setPage} />
        )}
      </section>
      {editing && (
        <IncidentForm
          item={editing}
          analysis={analysis}
          onClose={() => edit(null)}
          onSave={() => {
            revise((v) => v + 1);
            edit(null);
            notify('Задача сохранена');
          }}
        />
      )}{' '}
      {deleting && (
        <Confirm
          title="Удалить задачу?"
          onClose={() => remove(null)}
          onConfirm={async () => {
            await api(`/incidents/${deleting.id}`, 'DELETE', { version: deleting.version });
            revise((v) => v + 1);
            notify('Задача удалена');
          }}
        >
          {deleting.title}. Запись останется только в журнале действий.
        </Confirm>
      )}
    </>
  );
}
function IncidentForm({ item, analysis, onSave, onClose }) {
  const [data, setData] = useState({
    datasetId: analysis.datasetId,
    stageId: item.stageId || null,
    assignee: item.assignee || '',
    dueDate: item.dueDate || null,
    resolutionNote: item.resolutionNote || '',
    title: item.title || '',
    description: item.description || '',
    priority: item.priority || 'normal',
    status: item.status || 'open'
  });
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const change = (key) => (e) =>
    setData({
      ...data,
      [key]: ['stageId', 'dueDate'].includes(key) ? e.target.value || null : e.target.value
    });
  return (
    <Modal
      title={item.id ? 'Изменить задачу' : 'Новая задача'}
      onClose={onClose}
      pending={busy}
      guardChanges
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api(
              item.id ? `/incidents/${item.id}` : '/incidents',
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
          <input required autoFocus maxLength={180} value={data.title} onChange={change('title')} />
        </Field>
        <Field label="Участок">
          <select value={data.stageId || ''} onChange={change('stageId')}>
            <option value="">Общепроизводственная задача</option>
            {analysis.stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="form-grid">
          <Field label="Приоритет">
            <select value={data.priority} onChange={change('priority')}>
              {Object.entries(priorities).map(([key, v]) => (
                <option key={key} value={key}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Статус">
            <select value={data.status} onChange={change('status')}>
              {Object.entries(statuses).map(([key, v]) => (
                <option key={key} value={key}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="form-grid">
          <Field label="Ответственный">
            <input
              required={data.status === 'resolved'}
              value={data.assignee}
              maxLength={80}
              onChange={change('assignee')}
            />
          </Field>
          <Field label="Срок проверки">
            <input type="date" value={data.dueDate || ''} onChange={change('dueDate')} />
          </Field>
        </div>
        <Field label="Описание и основание">
          <textarea
            rows={5}
            maxLength={3000}
            value={data.description}
            onChange={change('description')}
          />
        </Field>
        <Field label="Фактический результат проверки">
          <textarea
            rows={3}
            maxLength={3000}
            value={data.resolutionNote}
            required={data.status === 'resolved'}
            onChange={change('resolutionNote')}
          />
        </Field>
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

import { useState } from 'react';
import { api } from './api.js';
import { Icon } from './icons.jsx';
import { Button, Field, Modal, Confirm, ErrorBox, Empty, Loading, useResource } from './ui.jsx';
const statuses = { open: 'Открыто', investigating: 'В работе', resolved: 'Решено' };
const priorities = { normal: 'Обычный', high: 'Высокий', critical: 'Критический' };
export default function Incidents({ analysis, canWrite, notify, evidence }) {
  const [revision, revise] = useState(0),
    [editing, edit] = useState(null),
    [deleting, remove] = useState(null),
    [filter, setFilter] = useState('all');
  const state = useResource(`/incidents?datasetId=${analysis.datasetId}`, revision);
  const rows = state.data?.filter((r) => filter === 'all' || r.status === filter);
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
                      stageId: f.stageId || analysis.stages[0].id,
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
                <footer>
                  <small>
                    {analysis.stages.find((s) => s.id === r.stageId)?.name} ·{' '}
                    {new Date(r.updatedAt).toLocaleString('ru-RU')}
                  </small>
                  <div className="row-actions">
                    <Button icon="edit" onClick={() => edit(r)}>
                      Изменить
                    </Button>
                    <button
                      className="icon-button"
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
    stageId: item.stageId || analysis.stages[0].id,
    title: item.title || '',
    description: item.description || '',
    priority: item.priority || 'normal',
    status: item.status || 'open'
  });
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const change = (key) => (e) => setData({ ...data, [key]: e.target.value });
  return (
    <Modal title={item.id ? 'Изменить задачу' : 'Новая задача'} onClose={onClose}>
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
          <select value={data.stageId} onChange={change('stageId')}>
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
        <Field label="Описание и основание">
          <textarea
            rows={5}
            maxLength={3000}
            value={data.description}
            onChange={change('description')}
          />
        </Field>
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

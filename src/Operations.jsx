import { useState } from 'react';
import { api, format } from './api.js';
import { Button, ErrorBox, Field, Loading, Modal, useResource } from './ui.jsx';
import './operations.css';

const dateLabel = (value) => (value ? new Date(value).toLocaleString('ru-RU') : 'Пока нет');
export default function Operations({ notify }) {
  const [revision, revise] = useState(0),
    [tab, setTab] = useState('system');
  const state = useResource('/operations', revision);
  const users = useResource('/users', revision);
  const backups = useResource('/operations/backups', revision);
  const reservations = useResource('/ai/reservations', revision);
  const [editing, setEditing] = useState(null),
    [confirm, setConfirm] = useState(null),
    [reconcile, setReconcile] = useState(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const refresh = () => revise((n) => n + 1);
  async function backup() {
    setBusy(true);
    setError('');
    try {
      await api('/operations/backup', 'POST', {});
      refresh();
      notify('Резервная копия создана и проверена');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  const tabs = [
    ['system', 'Состояние'],
    ['users', 'Команда'],
    ['backups', 'Копии данных'],
    ['ai', 'Учёт ИИ']
  ];
  const pending = Array.isArray(reservations.data)
    ? reservations.data
    : reservations.data?.items || [];
  return (
    <section className="operations">
      <div className="page-intro">
        <div>
          <h2>Контроль рабочего пространства</h2>
          <p>Доступ команды, сохранность данных и состояние сервера.</p>
        </div>
        <Button onClick={refresh} disabled={busy}>
          Обновить
        </Button>
      </div>
      <div className="operations-navigation" role="group" aria-label="Раздел управления">
        {tabs.map(([id, label]) => (
          <button type="button" key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <ErrorBox>{error || state.error}</ErrorBox>
      {state.loading ? (
        <Loading />
      ) : (
        state.data &&
        tab === 'system' && (
          <>
            <div className="operations-status">
              <span className={`status-tag ${state.data.database.ready ? 'resolved' : 'open'}`}>
                {state.data.database.ready ? 'База доступна' : 'Требует проверки'}
              </span>
              <p>
                Проверка готовности выполняется сервером. Состояние обновляется каждые 15 секунд.
              </p>
            </div>
            <dl className="operations-facts">
              <div>
                <dt>Режим</dt>
                <dd>{state.data.runtime.production ? 'Production' : 'Разработка'}</dd>
              </div>
              <div>
                <dt>Версия схемы</dt>
                <dd>{state.data.database.schemaVersion}</dd>
              </div>
              <div>
                <dt>Размер базы</dt>
                <dd>{format(state.data.database.bytes / 1048576, 2)} МБ</dd>
              </div>
              <div>
                <dt>Последняя резервная копия</dt>
                <dd>{dateLabel(state.data.backups.latestAt)}</dd>
              </div>
              <div>
                <dt>Резервное копирование</dt>
                <dd>{state.data.backups.enabled ? 'Доступно по запросу' : 'Недоступно'}</dd>
              </div>
              <div>
                <dt>Доверенный reverse proxy</dt>
                <dd>{state.data.runtime.proxyConfigured ? 'Настроен' : 'Прямое подключение'}</dd>
              </div>
              <div>
                <dt>Время работы процесса</dt>
                <dd>{format(state.data.runtime.uptimeSeconds / 60, 1)} мин</dd>
              </div>
              <div>
                <dt>Хранение аудита</dt>
                <dd>
                  {state.data.retention.auditDays
                    ? `${state.data.retention.auditDays} дней`
                    : 'Без автоматической очистки'}
                </dd>
              </div>
              <div>
                <dt>Хранение диалогов</dt>
                <dd>
                  {state.data.retention.chatDays
                    ? `${state.data.retention.chatDays} дней`
                    : 'Без автоматической очистки'}
                </dd>
              </div>
            </dl>
            <p>
              Политика копий:{' '}
              {state.data.retention.backupKeepCount
                ? `оставлять последние ${state.data.retention.backupKeepCount}`
                : 'хранить все копии'}
              . Очистка выполняется по кнопке ниже или командой обслуживания; автоматическое
              расписание не настроено этим экраном.
            </p>
            <details className="operations-note">
              <summary>Обслуживание и восстановление</summary>
              <p>
                Для внешнего размещения настройте HTTPS, доверенные адреса прокси и постоянный диск.
                Копии остаются на этом сервере; для защиты от его потери переносите их на отдельное
                хранилище.
              </p>
              <p>
                Восстановление выполняется отдельной командой в новый файл базы. Работающая база не
                перезаписывается. Команды описаны в README репозитория.
              </p>
              <Button
                disabled={
                  !state.data.retention.auditDays &&
                  !state.data.retention.chatDays &&
                  !state.data.retention.backupKeepCount
                }
                onClick={() =>
                  setConfirm({
                    title: 'Очистить устаревшие записи?',
                    text: `Будут применены сроки: аудит ${state.data.retention.auditDays || 'без удаления'}; диалоги ${state.data.retention.chatDays || 'без удаления'} дней. ${state.data.retention.backupKeepCount ? `Сохранятся последние ${state.data.retention.backupKeepCount} резервных копий, остальные будут удалены.` : 'Все резервные копии сохранятся.'} Сначала создайте актуальную резервную копию.`,
                    action: async () => {
                      await api('/operations/retention', 'POST', { confirm: true });
                      refresh();
                      notify('Политика хранения применена');
                    }
                  })
                }
              >
                Применить сроки хранения
              </Button>
            </details>
          </>
        )
      )}
      {tab === 'users' && (
        <>
          <div className="section-head">
            <h3>Участники команды</h3>
            <Button tone="primary" icon="plus" onClick={() => setEditing({})}>
              Добавить участника
            </Button>
          </div>
          <p>
            Каждый участник входит под собственным логином. Изменение доступа завершает его
            существующие сессии.
          </p>
          <ErrorBox>{users.error}</ErrorBox>
          {users.loading ? (
            <Loading />
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Логин</th>
                    <th>Роль</th>
                    <th>Доступ</th>
                    <th>Управление</th>
                  </tr>
                </thead>
                <tbody>
                  {(users.data || []).map((user) => (
                    <tr key={user.id}>
                      <td>{user.username}</td>
                      <td>
                        {user.role === 'admin'
                          ? 'Администратор'
                          : user.role === 'editor'
                            ? 'Редактор'
                            : 'Наблюдатель'}
                      </td>
                      <td>{user.disabled ? 'Приостановлен' : 'Активен'}</td>
                      <td>
                        {user.isOwner ? (
                          <span>Владелец · настройки сервера</span>
                        ) : (
                          <div className="row-actions">
                            <Button onClick={() => setEditing(user)}>Изменить</Button>
                            <Button
                              onClick={() =>
                                setConfirm({
                                  title: user.disabled
                                    ? 'Вернуть доступ?'
                                    : 'Приостановить доступ?',
                                  text: `Пользователь ${user.username}. Данные сохранятся, активные сессии будут завершены.`,
                                  action: async () => {
                                    await api(`/users/${user.id}`, 'PATCH', {
                                      disabled: !user.disabled
                                    });
                                    refresh();
                                    notify('Доступ обновлён');
                                  }
                                })
                              }
                            >
                              {user.disabled ? 'Включить' : 'Приостановить'}
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {tab === 'backups' && (
        <>
          <div className="section-head">
            <h3>Проверенные копии SQLite</h3>
            <Button tone="primary" onClick={backup} disabled={busy || !state.data?.backups.enabled}>
              {busy ? 'Создаём копию…' : 'Создать резервную копию'}
            </Button>
          </div>
          <p>
            Снимок хранится отдельно от работающей базы. Создание копии не изменяет производственные
            записи.
          </p>
          <ErrorBox>{backups.error}</ErrorBox>
          {backups.loading ? (
            <Loading />
          ) : (backups.data || []).length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Файл</th>
                    <th>Создан</th>
                    <th>Размер</th>
                  </tr>
                </thead>
                <tbody>
                  {backups.data.map((item) => (
                    <tr key={item.name}>
                      <td>
                        <code>{item.name}</code>
                      </td>
                      <td>{dateLabel(item.createdAt)}</td>
                      <td>{format(item.bytes / 1048576, 2)} МБ</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty">
              Резервных копий пока нет. Создайте первую перед важным изменением данных.
            </p>
          )}
        </>
      )}
      {tab === 'ai' && (
        <>
          <h3>Сверка неопределённых запросов</h3>
          <p>
            После обрыва соединения приложение сохраняет резерв расходов. Сверьте запрос с кабинетом
            провайдера и внесите подтверждённый результат. Это внутренний учёт, он не меняет баланс
            провайдера.
          </p>
          <ErrorBox>{reservations.error}</ErrorBox>
          {reservations.loading ? (
            <Loading />
          ) : pending.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Запрос</th>
                    <th>Время</th>
                    <th>Резерв, USD</th>
                    <th>Действие</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <code>{row.id}</code>
                      </td>
                      <td>{dateLabel(row.createdAt || row.created_at)}</td>
                      <td>{format(row.reservedUsd ?? row.costUsd ?? row.cost_usd, 5)}</td>
                      <td>
                        <Button disabled={row.active} onClick={() => setReconcile(row)}>
                          Сверить
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty">Неопределённых запросов нет.</p>
          )}
        </>
      )}
      {editing && (
        <UserEditor
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
            notify('Доступ участника сохранён');
          }}
        />
      )}
      {confirm && <ActionConfirm action={confirm} onClose={() => setConfirm(null)} />}
      {reconcile && (
        <Reconcile
          item={reconcile}
          onClose={() => setReconcile(null)}
          onSaved={() => {
            setReconcile(null);
            refresh();
            notify('Результат сверки сохранён');
          }}
        />
      )}
    </section>
  );
}
function UserEditor({ user, onClose, onSaved }) {
  const [username, setUsername] = useState(user.username || ''),
    [password, setPassword] = useState(''),
    [role, setRole] = useState(user.role || 'editor');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal
      title={user.id ? 'Доступ участника' : 'Новый участник'}
      onClose={() => {
        if (!busy) onClose();
      }}
      pending={busy}
      guardChanges
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try {
            await api(user.id ? `/users/${user.id}` : '/users', user.id ? 'PATCH' : 'POST', {
              username,
              role,
              ...(!user.id || password ? { password } : {})
            });
            onSaved();
          } catch (failure) {
            setError(failure.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Логин">
          <input
            required
            minLength={1}
            maxLength={80}
            autoComplete="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field
          label={
            user.id
              ? 'Новый пароль · оставьте пустым, чтобы сохранить прежний'
              : 'Пароль · от 16 символов'
          }
        >
          <input
            type="password"
            required={!user.id}
            minLength={16}
            maxLength={256}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="Роль">
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="editor">Редактор: рабочие данные и помощник</option>
            <option value="viewer">Наблюдатель: просмотр и расчёты</option>
          </select>
        </Field>
        <ErrorBox>{error}</ErrorBox>
        <div className="form-actions">
          <Button type="button" data-close-modal disabled={busy}>
            Отмена
          </Button>
          <Button tone="primary" disabled={busy}>
            {busy ? 'Сохраняем…' : 'Сохранить доступ'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function ActionConfirm({ action, onClose }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal
      title={action.title}
      pending={busy}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p>{action.text}</p>
      <ErrorBox>{error}</ErrorBox>
      <div className="form-actions">
        <Button disabled={busy} onClick={onClose}>
          Отмена
        </Button>
        <Button
          disabled={busy}
          tone="primary"
          onClick={async () => {
            setBusy(true);
            try {
              await action.action();
              onClose();
            } catch (failure) {
              setError(failure.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Выполняем…' : 'Подтвердить'}
        </Button>
      </div>
    </Modal>
  );
}
function Reconcile({ item, onClose, onSaved }) {
  const [outcome, setOutcome] = useState(''),
    [cost, setCost] = useState(''),
    [note, setNote] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal
      title="Подтверждение расхода"
      pending={busy}
      guardChanges
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try {
            await api(`/ai/reservations/${item.id}/reconcile`, 'POST', {
              outcome,
              note,
              ...(outcome === 'charged' ? { costUsd: Number(cost) } : {})
            });
            onSaved();
          } catch (failure) {
            setError(failure.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Результат по кабинету провайдера">
          <select required value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="" disabled>
              Выберите подтверждённый результат
            </option>
            <option value="not_charged">Списание отсутствует</option>
            <option value="charged">Списание подтверждено</option>
          </select>
        </Field>
        {outcome === 'charged' && (
          <Field label="Фактический расход, USD">
            <input
              required
              type="number"
              min="0"
              max="1000"
              step="0.000001"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          </Field>
        )}
        <Field label="Основание сверки">
          <textarea
            required
            minLength={5}
            maxLength={800}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        <ErrorBox>{error}</ErrorBox>
        <div className="form-actions">
          <Button type="button" disabled={busy} data-close-modal>
            Отмена
          </Button>
          <Button tone="primary" disabled={busy}>
            {busy ? 'Сохраняем…' : 'Подтвердить сверку'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

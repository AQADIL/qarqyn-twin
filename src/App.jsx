import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Brand, Icon } from './icons.jsx';
import { Button, Modal, Field, ErrorBox, Loading, Evidence, useResource } from './ui.jsx';
import Landing from './Landing.jsx';
import Overview from './Overview.jsx';
import Lab from './Lab.jsx';
import Data from './Data.jsx';
import Incidents from './Incidents.jsx';
import Assistant from './Assistant.jsx';
import TargetPlanner from './TargetPlanner.jsx';

const pages = {
  overview: ['Производство', 'overview'],
  target: ['План выпуска', 'target'],
  lab: ['Сценарии', 'lab'],
  incidents: ['Отклонения', 'incident'],
  data: ['Данные', 'data'],
  assistant: ['Помощник', 'source'],
  audit: ['Журнал действий', 'source']
};
function getPage() {
  const page = location.hash.replace('#/app/', '');
  return pages[page] ? page : 'overview';
}
export default function App() {
  const [session, setSession] = useState(null),
    [restoring, setRestoring] = useState(true),
    [workspace, setWorkspace] = useState(location.hash.startsWith('#/app'));
  const [page, setPage] = useState(getPage),
    [login, setLogin] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [datasetId, setDatasetId] = useState('allur'),
    [revision, revise] = useState(0),
    [menu, setMenu] = useState(false),
    [date, setDate] = useState('');
  const [evidence, setEvidence] = useState(null),
    [toast, setToast] = useState('');
  const datasets = useResource(session ? '/datasets' : null, revision);
  const dataset = useResource(session ? `/datasets/${datasetId}` : null, revision);
  const analysis = useResource(
    session ? `/analysis/${datasetId}${page === 'overview' && date ? `?date=${date}` : ''}` : null,
    revision
  );
  useEffect(() => {
    let active = true;
    api('/session')
      .then((s) => {
        if (active) setSession(s);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setRestoring(false);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const listener = () => {
      if (location.hash === '#workspace-content') return;
      setWorkspace(location.hash.startsWith('#/app'));
      setPage(getPage());
      setMenu(false);
    };
    window.addEventListener('hashchange', listener);
    return () => window.removeEventListener('hashchange', listener);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  function navigate(next) {
    location.hash = `/app/${next}`;
    setPage(next);
    setWorkspace(true);
    setMenu(false);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  async function open() {
    if (session) return navigate('overview');
    setBusy(true);
    setError('');
    try {
      const s = await api('/auth/demo', 'POST', {});
      setSession(s);
      navigate('overview');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    try {
      await api('/auth/logout', 'POST', {});
      setSession(null);
      location.hash = '';
      setDatasetId('allur');
      setDate('');
    } catch (e) {
      setToast(e.message);
    }
  }
  function selectDataset(id) {
    setDatasetId(id);
    setDate('');
  }
  const canWrite = session?.user.role === 'admin' || session?.user.role === 'editor';
  const refresh = async () => revise((v) => v + 1);
  const loginModal = login && (
    <Login
      onClose={() => setLogin(false)}
      onSuccess={(s) => {
        setSession(s);
        setLogin(false);
        setDatasetId('allur');
        revise((v) => v + 1);
        navigate('overview');
      }}
    />
  );
  if (!workspace)
    return (
      <>
        <Landing
          onOpen={open}
          onLogin={() => setLogin(true)}
          busy={busy || restoring}
          error={error}
        />
        {loginModal}
      </>
    );
  if (restoring)
    return (
      <div className="center-screen">
        <Brand />
        <Loading label="Восстанавливаем рабочее пространство…" />
      </div>
    );
  if (!session)
    return (
      <div className="center-screen">
        <Brand />
        <h1>Откройте производство</h1>
        <p>Войдите для работы с данными или изучите демонстрационный набор.</p>
        <ErrorBox>{error}</ErrorBox>
        <div className="row-actions">
          <Button tone="primary" disabled={busy} onClick={open}>
            Открыть демо
          </Button>
          <Button onClick={() => setLogin(true)}>Войти</Button>
        </div>
        <a href="#">На главную</a>
        {loginModal}
      </div>
    );
  const a = analysis.data;
  return (
    <div className="app-shell">
      <a className="skip-link" href="#workspace-content">
        К рабочей области
      </a>
      <header className="mobile-header">
        <a href="#">
          <Brand />
        </a>
        <button
          className="icon-button"
          aria-label="Открыть меню"
          aria-expanded={menu}
          onClick={() => setMenu(!menu)}
        >
          <Icon name={menu ? 'close' : 'menu'} />
        </button>
      </header>
      {menu && (
        <button className="menu-shade" onClick={() => setMenu(false)} aria-label="Закрыть меню" />
      )}
      <aside className={`sidebar ${menu ? 'open' : ''}`}>
        <a className="sidebar-brand" href="#" aria-label="QARQYN главная">
          <Brand />
        </a>
        <div className="plant-label">
          <span className="square-dot" />
          <div>
            <strong>ALLUR</strong>
            <small>Цифровой двойник · кейс 02</small>
          </div>
        </div>
        <span className="nav-caption">РАБОЧЕЕ ПРОСТРАНСТВО</span>
        <nav aria-label="Разделы приложения">
          {Object.entries(pages)
            .filter(([key]) => key !== 'audit' || session.user.role === 'admin')
            .map(([key, [label, icon]]) => (
              <a
                key={key}
                href={`#/app/${key}`}
                className={key === page ? 'active' : ''}
                aria-current={key === page ? 'page' : undefined}
                onClick={() => setMenu(false)}
              >
                <Icon name={icon} />
                <span>{label}</span>
                {key === 'incidents' && a && <small>{a.findings.length}</small>}
              </a>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="source-badge">
            <Icon name="source" size={20} />
            <p>
              Тестовые данные
              <br />
              <span>Подключение к заводу отсутствует</span>
            </p>
          </div>
          <div className="account">
            <span className="avatar">{session.user.username.slice(0, 1).toUpperCase()}</span>
            <div>
              <strong>{session.user.username}</strong>
              <small>{canWrite ? 'Редактор производства' : 'Просмотр и расчёт'}</small>
            </div>
            <button className="icon-button" onClick={logout} aria-label="Выйти">
              <Icon name="logout" size={18} />
            </button>
          </div>
          {!canWrite && (
            <button className="editor-login" onClick={() => setLogin(true)}>
              Войти как редактор <Icon name="arrow" size={16} />
            </button>
          )}
        </div>
      </aside>
      <div className="workspace">
        <header className="workspace-header">
          <div className="breadcrumbs">
            QARQYN <span>/</span> ALLUR <span>/</span> <strong>{pages[page][0]}</strong>
          </div>
          <div className="header-tools">
            <span className="status-dot" /> <span>Локальный расчёт</span>
            <button
              className="icon-button"
              onClick={() => a && setEvidence({})}
              aria-label="Информация об источнике"
            >
              <Icon name="source" size={20} />
            </button>
          </div>
        </header>
        <main id="workspace-content" className="workspace-main" tabIndex={-1}>
          <div className="workspace-title">
            <div>
              <h1>{page === 'overview' ? 'Пульс производства' : pages[page][0]}</h1>
            </div>
            <div className="dataset-select">
              <Field label="Набор данных">
                <select value={datasetId} onChange={(e) => selectDataset(e.target.value)}>
                  {datasets.data?.map((d) => (
                    <option value={d.id} key={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </Field>
              {page === 'overview' && a && (
                <Field label="Период">
                  <select value={date} onChange={(e) => setDate(e.target.value)}>
                    <option value="">Все наблюдения</option>
                    {a.dates.map((d) => (
                      <option value={d} key={d}>
                        {new Date(`${d}T12:00:00`).toLocaleDateString('ru-RU')}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <a
                className="button export-button"
                href={`/api/export/${datasetId}`}
                download
                aria-label="Скачать сводку CSV"
              >
                <Icon name="download" size={18} />
                <span>CSV</span>
              </a>
            </div>
          </div>
          <ErrorBox>{datasets.error || dataset.error || analysis.error}</ErrorBox>
          {(dataset.error || analysis.error) && (
            <Button onClick={refresh}>Повторить загрузку</Button>
          )}
          {analysis.loading || dataset.loading ? (
            <Loading />
          ) : (
            a &&
            dataset.data && (
              <div key={datasetId}>
                {page === 'overview' && (
                  <Overview
                    analysis={a}
                    evidence={(ids) => setEvidence({ ids })}
                    navigate={navigate}
                  />
                )}{' '}
                {page === 'lab' && <Lab analysis={a} canWrite={canWrite} notify={setToast} />}{' '}
                {page === 'target' && (
                  <TargetPlanner
                    analysis={a}
                    canWrite={canWrite}
                    notify={setToast}
                    evidence={(ids) => setEvidence({ ids })}
                    navigate={navigate}
                  />
                )}
                {page === 'data' && (
                  <Data
                    dataset={dataset.data}
                    canWrite={canWrite}
                    refresh={refresh}
                    selectDataset={selectDataset}
                    notify={setToast}
                  />
                )}{' '}
                {page === 'incidents' && (
                  <Incidents
                    analysis={a}
                    canWrite={canWrite}
                    notify={setToast}
                    evidence={(ids) => setEvidence({ ids })}
                  />
                )}{' '}
                {page === 'assistant' && <Assistant analysis={a} canWrite={canWrite} />}{' '}
                {page === 'audit' && <Audit />}
              </div>
            )
          )}
          <footer className="workspace-footer">
            <span>QARQYN TWIN / исследовательский прототип</span>
            <span>Источники → сценарий → решение</span>
          </footer>
        </main>
      </div>
      {evidence && a && (
        <Evidence analysis={a} ids={evidence.ids} onClose={() => setEvidence(null)} />
      )}{' '}
      {loginModal}
      {toast && (
        <div className="toast" role="status">
          <Icon name="check" size={18} />
          {toast}
          <button onClick={() => setToast('')} aria-label="Закрыть уведомление">
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
function Login({ onSuccess, onClose }) {
  const [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <Modal title="Вход в рабочее пространство" onClose={onClose}>
      <p>Используйте учётную запись, настроенную владельцем при запуске системы.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            onSuccess(await api('/auth/login', 'POST', { username, password }));
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Логин">
          <input
            autoFocus
            autoComplete="username"
            required
            maxLength={80}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field label="Пароль">
          <input
            type="password"
            autoComplete="current-password"
            required
            maxLength={256}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <ErrorBox>{error}</ErrorBox>
        <div className="form-actions">
          <Button type="button" onClick={onClose}>
            Отмена
          </Button>
          <Button tone="primary" disabled={busy}>
            {busy ? 'Входим…' : 'Войти'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function Audit() {
  const state = useResource('/audit');
  return (
    <>
      <div className="page-intro">
        <div>
          <h2>История изменений</h2>
          <p>Последние 200 действий. Пароли и тексты запросов ИИ не записываются.</p>
        </div>
      </div>
      <ErrorBox>{state.error}</ErrorBox>
      {state.loading ? (
        <Loading />
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Время</th>
                <th>Пользователь</th>
                <th>Действие</th>
                <th>Объект</th>
                <th>Описание</th>
              </tr>
            </thead>
            <tbody>
              {state.data?.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.created_at).toLocaleString('ru-RU')}</td>
                  <td>{r.actor}</td>
                  <td>{r.action}</td>
                  <td>
                    <code>{r.entity_id}</code>
                  </td>
                  <td>{r.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!state.data?.length && (
            <p className="empty">История появится после первого изменения.</p>
          )}
        </div>
      )}
    </>
  );
}

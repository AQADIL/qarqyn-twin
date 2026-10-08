import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Brand, Icon } from './icons.jsx';
import { Button, Modal, Field, ErrorBox, Loading, Evidence, useResource } from './ui.jsx';
import Landing from './Landing.jsx';
import Overview from './Overview.jsx';
import { ThemeTools } from './Theme.jsx';
import { clearWorkflow } from './workflow.js';

const Lab = lazy(() => import('./Lab.jsx'));
const Data = lazy(() => import('./Data.jsx'));
const Incidents = lazy(() => import('./Incidents.jsx'));
const Assistant = lazy(() => import('./Assistant.jsx'));
const TargetPlanner = lazy(() => import('./TargetPlanner.jsx'));
const DecisionCenter = lazy(() => import('./DecisionCenter.jsx'));
const Operations = lazy(() => import('./Operations.jsx'));
const FlowLab = lazy(() => import('./FlowLab.jsx'));
const ActionPlan = lazy(() => import('./ActionPlan.jsx'));

const pages = {
  overview: ['Производство', 'overview'],
  decisions: ['Риски и эффект', 'decisions'],
  target: ['План выпуска', 'target'],
  actions: ['Мероприятия', 'target'],
  flow: ['Поток линии', 'lab'],
  lab: ['Сценарии', 'lab'],
  incidents: ['Отклонения', 'incident'],
  data: ['Данные', 'data'],
  assistant: ['Помощник', 'source'],
  audit: ['Журнал действий', 'source'],
  operations: ['Управление', 'settings']
};
function getPage() {
  const page = location.hash.replace('#/app/', '').split('?')[0];
  return pages[page] ? page : 'overview';
}
function routeSelection() {
  const query = new URLSearchParams(location.hash.split('?')[1] || '');
  return {
    datasetId: /^[A-Za-z0-9_-]{1,64}$/.test(query.get('dataset') || '')
      ? query.get('dataset')
      : 'allur',
    date: /^\d{4}-\d{2}-\d{2}$/.test(query.get('date') || '') ? query.get('date') : ''
  };
}
function routeHref(page, datasetId, date) {
  const query = new URLSearchParams();
  if (datasetId !== 'allur') query.set('dataset', datasetId);
  if (date) query.set('date', date);
  return `#/app/${page}${query.size ? `?${query}` : ''}`;
}
export default function App() {
  const [session, setSession] = useState(null),
    [restoring, setRestoring] = useState(true),
    [workspace, setWorkspace] = useState(location.hash.startsWith('#/app'));
  const [page, setPage] = useState(getPage),
    [login, setLogin] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [datasetId, setDatasetId] = useState(() => routeSelection().datasetId),
    [revision, revise] = useState(0),
    [menu, setMenu] = useState(false),
    [date, setDate] = useState(() => routeSelection().date);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 700px)').matches);
  const sidebarRef = useRef(null),
    menuButton = useRef(null);
  const [evidence, setEvidence] = useState(null),
    [toast, setToast] = useState('');
  const [workflowRevision, setWorkflowRevision] = useState(0);
  useEffect(() => {
    if (workspace) window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [workspace, page, datasetId, workflowRevision]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 700px)');
    const update = () => {
      setMobile(media.matches);
      if (!media.matches) setMenu(false);
    };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useLayoutEffect(() => {
    if (!menu || !mobile || !workspace || !session) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusMenu = () => {
      sidebarRef.current?.querySelector('.sidebar-close')?.focus({ preventScroll: true });
    };
    const containFocus = (event) => {
      if (sidebarRef.current?.contains(event.target) || event.target.closest('dialog[open]'))
        return;
      focusMenu();
    };
    document.addEventListener('focusin', containFocus);
    focusMenu();
    const focusFrame = requestAnimationFrame(() => {
      if (!document.querySelector('dialog[open]')) focusMenu();
    });
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('focusin', containFocus);
      document.body.style.overflow = previous;
      menuButton.current?.focus({ preventScroll: true });
    };
  }, [menu, mobile, workspace, session]);
  useEffect(() => {
    const handoff = (event) => {
      if (!pages[event.detail?.page]) return;
      const context = event.detail.context || {};
      const nextDataset = context.datasetId || datasetId;
      const nextDate = context.date ?? date;
      location.hash = routeHref(event.detail.page, nextDataset, nextDate);
      setWorkflowRevision((value) => value + 1);
    };
    window.addEventListener('qarqyn:navigate', handoff);
    return () => window.removeEventListener('qarqyn:navigate', handoff);
  }, [datasetId, date]);
  useEffect(() => {
    function expired() {
      clearWorkflow();
      setSession(null);
      setEvidence(null);
      setDatasetId('allur');
      setDate('');
      setRestoring(false);
    }
    window.addEventListener('qarqyn:session-expired', expired);
    return () => window.removeEventListener('qarqyn:session-expired', expired);
  }, []);
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
      const selection = routeSelection();
      setDatasetId(selection.datasetId);
      setDate(selection.date);
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
  function navigate(next, selection = {}) {
    location.hash = routeHref(next, selection.datasetId ?? datasetId, selection.date ?? date);
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
      clearWorkflow();
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
    location.hash = routeHref(page, id, '');
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
        setDate('');
        revise((v) => v + 1);
        navigate('overview', { datasetId: 'allur', date: '' });
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
  const matchingVersion =
    !a ||
    !dataset.data ||
    (a.version === dataset.data.version &&
      a.datasetId === dataset.data.id &&
      a.datasetId === datasetId);
  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#workspace-content"
        onClick={(event) => {
          event.preventDefault();
          const main = document.getElementById('workspace-content');
          main?.focus();
          main?.scrollIntoView({ block: 'start', behavior: 'instant' });
        }}
      >
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
          ref={menuButton}
          onClick={() => setMenu(!menu)}
        >
          <Icon name={menu ? 'close' : 'menu'} />
        </button>
      </header>
      {menu && (
        <button className="menu-shade" onClick={() => setMenu(false)} aria-label="Закрыть меню" />
      )}
      <aside
        ref={sidebarRef}
        className={`sidebar ${menu ? 'open' : ''}`}
        inert={mobile && !menu}
        aria-label="Меню рабочего пространства"
        onKeyDown={(event) => {
          if (!menu || !mobile) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            setMenu(false);
          }
          if (event.key === 'Tab') {
            const controls = [
              ...event.currentTarget.querySelectorAll('a[href],button:not([disabled]),select')
            ].filter((el) => el.offsetParent !== null);
            const first = controls[0],
              last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <button
          type="button"
          className="icon-button sidebar-close"
          aria-label="Закрыть меню"
          onClick={() => setMenu(false)}
        >
          <Icon name="close" />
        </button>
        <a className="sidebar-brand" href="#" aria-label="QARQYN главная">
          <Brand />
        </a>
        <div className="plant-label">
          <span className="square-dot" />
          <div>
            <strong>{dataset.data?.seed ? 'ALLUR' : 'QARQYN'}</strong>
            <small>
              {dataset.data?.seed ? 'Цифровой двойник · кейс 02' : 'Рабочее пространство'}
            </small>
          </div>
        </div>
        <span className="nav-caption">РАБОЧЕЕ ПРОСТРАНСТВО</span>
        <nav aria-label="Разделы приложения">
          {Object.entries(pages)
            .filter(
              ([key]) => !['audit', 'operations'].includes(key) || session.user.role === 'admin'
            )
            .map(([key, [label, icon]]) => (
              <a
                key={key}
                href={routeHref(key, datasetId, date)}
                className={key === page ? 'active' : ''}
                aria-current={key === page ? 'page' : undefined}
                onClick={() => setMenu(false)}
              >
                <Icon name={icon} />
                <span>{label}</span>
                {key === 'incidents' && a && <small>{a.findings.length}</small>}
                {['decisions', 'target', 'assistant', 'actions', 'flow'].includes(key) && (
                  <small className="feature-new">{key === 'assistant' ? 'AI' : 'NEW'}</small>
                )}
              </a>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="source-badge">
            <Icon name="source" size={20} />
            <p>
              {dataset.data?.seed ? 'Данные организаторов' : 'Загруженный набор'}
              <br />
              <span>{dataset.data?.data.source.name || 'Источник не загружен'}</span>
            </p>
          </div>
          <div className="account">
            <span className="avatar">{session.user.username.slice(0, 1).toUpperCase()}</span>
            <div>
              <strong>{session.user.username}</strong>
              <small className="role-label">
                {session.user.role === 'admin'
                  ? 'Администратор'
                  : canWrite
                    ? 'Редактор производства'
                    : 'Просмотр и расчёт'}
              </small>
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
      <div className="workspace" inert={mobile && menu}>
        <header className="workspace-header">
          <div className="breadcrumbs">
            QARQYN <span>/</span> <strong>{pages[page][0]}</strong>
          </div>
          <div className="header-tools">
            <ThemeTools />
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
                  <select
                    value={date}
                    onChange={(e) => {
                      setDate(e.target.value);
                      location.hash = routeHref(page, datasetId, e.target.value);
                    }}
                  >
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
                href={`/api/export/${datasetId}${page === 'overview' && date ? `?date=${date}` : ''}`}
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
          {!matchingVersion && (
            <div className="loading-sync" role="status">
              Сверяем версии показателей и исходных записей.{' '}
              <Button onClick={refresh}>Обновить</Button>
            </div>
          )}
          {analysis.loading || dataset.loading ? (
            <Loading />
          ) : (
            matchingVersion &&
            a &&
            dataset.data && (
              <div key={`${datasetId}:${workflowRevision}`}>
                <Suspense fallback={<Loading />}>
                  {page === 'overview' && (
                    <Overview
                      analysis={a}
                      evidence={(ids) => setEvidence({ ids })}
                      navigate={navigate}
                      selectedDate={date}
                    />
                  )}{' '}
                  {page === 'lab' && (
                    <Lab
                      analysis={a}
                      canWrite={canWrite}
                      notify={setToast}
                      selectedDate={date}
                      userId={session.user.id}
                    />
                  )}{' '}
                  {page === 'decisions' && (
                    <DecisionCenter
                      key={dataset.data.id}
                      dataset={dataset.data}
                      notify={setToast}
                      onEvidence={(ids) => setEvidence({ ids })}
                      selectedDate={date}
                      canWrite={canWrite}
                      userId={session.user.id}
                    />
                  )}
                  {page === 'target' && (
                    <TargetPlanner
                      analysis={a}
                      canWrite={canWrite}
                      notify={setToast}
                      evidence={(ids) => setEvidence({ ids })}
                      navigate={navigate}
                      selectedDate={date}
                    />
                  )}
                  {page === 'actions' && (
                    <ActionPlan
                      key={`${dataset.data.id}:${dataset.data.version}`}
                      dataset={dataset.data}
                      canWrite={canWrite}
                      notify={setToast}
                      onEvidence={(ids) => setEvidence({ ids })}
                      selectedDate={date}
                    />
                  )}
                  {page === 'flow' && (
                    <FlowLab
                      key={`${dataset.data.id}:${dataset.data.version}`}
                      dataset={dataset.data}
                      canWrite={canWrite}
                      notify={setToast}
                      onEvidence={(ids) => setEvidence({ ids })}
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
                  {page === 'assistant' && (
                    <Assistant analysis={a} canWrite={canWrite} userId={session.user.id} />
                  )}{' '}
                  {page === 'audit' && session.user.role === 'admin' && <Audit />}
                  {['audit', 'operations'].includes(page) && session.user.role !== 'admin' && (
                    <p className="notice">
                      Этот раздел доступен администратору рабочего пространства.
                    </p>
                  )}
                  {page === 'operations' && session.user.role === 'admin' && (
                    <Operations notify={setToast} />
                  )}
                </Suspense>
              </div>
            )
          )}
          <footer className="workspace-footer">
            <span>QARQYN TWIN / исследовательский прототип</span>
            <span>Источники → сценарий → решение</span>
          </footer>
        </main>
      </div>
      {evidence && a && matchingVersion && (
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
    <Modal title="Вход в рабочее пространство" onClose={onClose} pending={busy}>
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
          <Button type="button" onClick={onClose} disabled={busy}>
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
  const [page, setPage] = useState(1);
  const state = useResource(`/audit?page=${page}&pageSize=50`);
  return (
    <>
      <div className="page-intro">
        <div>
          <h2>История изменений</h2>
          <p>
            История действий с постраничным просмотром. Пароли и тексты запросов ИИ не записываются.
          </p>
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
              {state.data?.items?.map((r) => (
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
          {!state.data?.items?.length && (
            <p className="empty">История появится после первого изменения.</p>
          )}
          {state.data && (
            <div className="row-actions">
              <Button disabled={page === 1} onClick={() => setPage(page - 1)}>
                Назад
              </Button>
              <span>
                Страница {page} из {Math.max(1, Math.ceil(state.data.total / 50))} · всего{' '}
                {state.data.total}
              </span>
              <Button disabled={page * 50 >= state.data.total} onClick={() => setPage(page + 1)}>
                Далее
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

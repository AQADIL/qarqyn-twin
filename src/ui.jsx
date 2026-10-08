import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from './icons.jsx';
import { api } from './api.js';

export function useResource(path, revision = 0) {
  const [state, setState] = useState({ data: null, error: '', loading: true });
  useEffect(() => {
    if (!path) {
      setState({ data: null, error: '', loading: false });
      return;
    }
    const controller = new AbortController();
    setState({ data: null, error: '', loading: true });
    let fetching = false;
    async function read() {
      if (fetching || controller.signal.aborted) return;
      fetching = true;
      try {
        const data = await api(path, 'GET', undefined, controller.signal);
        if (!controller.signal.aborted)
          setState((old) =>
            JSON.stringify(old.data) === JSON.stringify(data) && !old.error
              ? old
              : { data, error: '', loading: false }
          );
      } catch (error) {
        if (!controller.signal.aborted)
          setState((old) => ({ ...old, error: error.message, loading: false }));
      } finally {
        fetching = false;
      }
    }
    read();
    const interval = setInterval(() => {
      if (!document.hidden) read();
    }, 15000);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [path, revision]);
  return state;
}
export function Button({ children, icon, tone = 'default', className = '', ...props }) {
  return (
    <button className={`button ${tone} ${className}`} {...props}>
      {icon && <Icon name={icon} size={18} />}
      <span>{children}</span>
    </button>
  );
}
export function ErrorBox({ children }) {
  return children ? (
    <div className="error-box" role="alert">
      {children}
    </div>
  ) : null;
}
export function Loading({ label = 'Загружаем данные…' }) {
  return (
    <div className="loading" role="status">
      <span className="loading-track" />
      {label}
    </div>
  );
}
export function Empty({ title, children }) {
  return (
    <div className="empty">
      <Icon name="source" size={34} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  pending = false,
  guardChanges = false
}) {
  const ref = useRef(null);
  const headingId = useId();
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  useEffect(() => {
    const el = ref.current;
    el.showModal();
    return () => el.close();
  }, []);
  useEffect(() => {
    if (!dirty || !guardChanges) return;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, guardChanges]);
  function close() {
    if (pending) return;
    if (guardChanges && dirty) setConfirmClose(true);
    else onClose();
  }
  return (
    <dialog
      ref={ref}
      className={wide ? 'modal wide' : 'modal'}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onChangeCapture={() => {
        if (guardChanges) setDirty(true);
      }}
      onClickCapture={(event) => {
        if (event.target.closest('[data-close-modal]')) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          close();
      }}
      aria-labelledby={headingId}
      aria-busy={pending}
    >
      <header className="modal-head">
        <h2 id={headingId}>{title}</h2>
        <button
          type="button"
          className="icon-button"
          disabled={pending}
          onClick={close}
          aria-label="Закрыть"
        >
          <Icon name="close" />
        </button>
      </header>
      {confirmClose ? (
        <section className="modal-discard" role="alert">
          <h3>Изменения ещё не сохранены</h3>
          <p>Вернуться к форме или закрыть её без сохранения?</p>
          <div className="form-actions">
            <Button onClick={() => setConfirmClose(false)} autoFocus>
              Продолжить редактирование
            </Button>
            <Button tone="danger" onClick={onClose}>
              Закрыть без сохранения
            </Button>
          </div>
        </section>
      ) : (
        children
      )}
    </dialog>
  );
}
export function Pagination({ page, pageSize = 20, total, onChange, disabled = false }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  useEffect(() => {
    if (!disabled && page > pages) onChange(pages);
  }, [page, pages, disabled, onChange]);
  return (
    <nav className="row-actions pagination" aria-label="Страницы списка">
      <Button disabled={disabled || page <= 1} onClick={() => onChange(page - 1)}>
        Назад
      </Button>
      <span role="status">
        {page} / {pages} · записей: {total}
      </span>
      <Button disabled={disabled || page >= pages} onClick={() => onChange(page + 1)}>
        Далее
      </Button>
    </nav>
  );
}
export function Confirm({ title, children, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal title={title} onClose={onClose} pending={busy}>
      <p>{children}</p>
      <ErrorBox>{error}</ErrorBox>
      <div className="form-actions">
        <Button onClick={onClose} disabled={busy}>
          Отмена
        </Button>
        <Button
          tone="danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
              onClose();
            } catch (e) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Удаляем…' : 'Удалить'}
        </Button>
      </div>
    </Modal>
  );
}
export function Evidence({ analysis, onClose, ids }) {
  const rows = Object.entries(analysis.records).flatMap(([group, records]) =>
    records.map((record) => ({ group, ...record }))
  );
  const selected = ids ? rows.filter((r) => ids.includes(r.id)) : rows;
  return (
    <Modal title="Проверяемые источники" wide onClose={onClose}>
      <p>
        {analysis.source.name}. {analysis.source.description}
      </p>
      <div className="source-meta">
        <span>
          Версия набора <b>{analysis.version}</b>
        </span>
        <span>
          Записей в выборке <b>{selected.length}</b>
        </span>
      </div>
      <div className="evidence-list">
        {selected.map((r) => (
          <div key={`${r.group}-${r.id}`}>
            <code>{r.id}</code>
            <dl>
              {Object.entries(r)
                .filter(([key]) => !['id', 'group'].includes(key))
                .map(([key, value]) => (
                  <div key={key}>
                    <dt>{labels[key] || key}</dt>
                    <dd>{String(value)}</dd>
                  </div>
                ))}
            </dl>
          </div>
        ))}
      </div>
      <details>
        <summary>Ограничения расчётов</summary>
        {analysis.warnings.map((w) => (
          <p key={w}>{w}</p>
        ))}
      </details>
    </Modal>
  );
}
export const labels = {
  periodHours: 'Длительность записи, ч',
  regime: 'Режим производства',
  classification: 'Тип простоя',
  id: 'ID',
  date: 'Дата',
  stageId: 'Участок',
  line: 'Линия',
  plan: 'План',
  actual: 'Факт',
  runtimeHours: 'Работа, ч',
  utilizationPct: 'Загрузка, %',
  equipment: 'Оборудование',
  reason: 'Причина',
  minutes: 'Простой, мин',
  model: 'Модель',
  quantity: 'Количество',
  produced: 'Проверено',
  defects: 'Брак',
  reportedPct: 'Брак в источнике, %'
};

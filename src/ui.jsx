import { useEffect, useRef, useState } from 'react';
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
export function Modal({ title, children, onClose, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    el.showModal();
    return () => el.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? 'modal wide' : 'modal'}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
      aria-labelledby="modal-heading"
    >
      <header className="modal-head">
        <h2 id="modal-heading">{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="Закрыть">
          <Icon name="close" />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function Confirm({ title, children, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal title={title} onClose={onClose}>
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

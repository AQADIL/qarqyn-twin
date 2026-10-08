import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, apiStream, format } from './api.js';
import { Brand, Icon } from './icons.jsx';
import {
  Button,
  Field,
  ErrorBox,
  Evidence,
  Loading,
  Modal,
  Pagination,
  Confirm,
  useResource
} from './ui.jsx';
import { openWorkflow } from './workflow.js';
import './Assistant.css';

export default function Assistant({ analysis, canWrite, userId }) {
  return (
    <Conversation
      key={`${userId}:${analysis.datasetId}`}
      analysis={analysis}
      canWrite={canWrite}
      userId={userId}
    />
  );
}
function turnsFrom(messages = []) {
  return messages
    .filter((message) => message.role === 'user')
    .map((message) => {
      const answer = messages.find(
        (item) => item.role === 'assistant' && item.requestId === message.requestId
      );
      return {
        id: message.id,
        requestId: message.requestId,
        question: message.question || '',
        answer: answer?.answer,
        error: answer?.error || message.error || '',
        pending: answer?.state === 'pending' || (message.state === 'pending' && !answer),
        cancelled: message.state === 'cancelled' || answer?.state === 'cancelled'
      };
    });
}
function useMotionVisibility(ref) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let intersecting = false;
    const update = () => setVisible(intersecting && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = entry.isIntersecting;
      update();
    });
    observer.observe(element);
    document.addEventListener('visibilitychange', update);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
    };
  }, [ref]);
  return visible;
}
function Thinking() {
  const element = useRef(null);
  const visible = useMotionVisibility(element);
  return (
    <div className="chat-thinking" role="status" ref={element} data-motion={visible}>
      <span className="chat-thinking-pulse" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>
        Готовлю ответ по вашим данным
        <span className="chat-thinking-ellipsis" aria-hidden="true">
          …
        </span>
      </span>
    </div>
  );
}
function Conversation({ analysis, canWrite, userId }) {
  const storageKey = `qarqyn:conversation:${userId}:${analysis.datasetId}`;
  const [selectedId, setSelectedId] = useState(() => sessionStorage.getItem(storageKey) || '');
  const [thread, setThread] = useState(null),
    [revision, revise] = useState(0),
    [page, setPage] = useState(1),
    [search, setSearch] = useState('');
  const [question, setQuestion] = useState(''),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState(null),
    [error, setError] = useState(''),
    [sources, setSources] = useState(null),
    [deleting, setDeleting] = useState(null);
  const [renaming, setRenaming] = useState(null),
    [threadLoading, setThreadLoading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false),
    [copied, setCopied] = useState('');
  const session = useResource('/session');
  const history = useResource(
    `/conversations?datasetId=${analysis.datasetId}&page=${page}&pageSize=20&q=${encodeURIComponent(search)}`,
    revision
  );
  const controller = useRef(null),
    textarea = useRef(null),
    composer = useRef(null),
    initialFocus = useRef(true),
    active = useRef(true),
    activeId = useRef(selectedId);
  const composerVisible = useMotionVisibility(composer);
  const enabled = Boolean(session.data?.aiAvailable && canWrite);
  activeId.current = selectedId;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    sessionStorage.setItem(storageKey, selectedId);
    if (!selectedId) {
      setThread(null);
      setThreadLoading(false);
      return;
    }
    const abort = new AbortController();
    setThreadLoading(true);
    api(`/conversations/${selectedId}`, 'GET', undefined, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) setThread(value);
      })
      .catch((failure) => {
        if (!abort.signal.aborted) {
          setError(failure.message);
          if (failure.status === 404) setSelectedId('');
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setThreadLoading(false);
      });
    return () => abort.abort();
  }, [selectedId, storageKey]);
  const resizeQuestion = useCallback(() => {
    const input = textarea.current;
    if (!input) return;
    input.style.height = '0px';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }, []);
  useLayoutEffect(resizeQuestion, [question, resizeQuestion]);
  useEffect(() => {
    const input = textarea.current;
    if (!input) return;
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === width) return;
      width = input.clientWidth;
      resizeQuestion();
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [resizeQuestion]);
  const storedTurns = turnsFrom(thread?.messages);
  const processing = busy || storedTurns.some((turn) => turn.pending);
  useEffect(() => {
    if (!initialFocus.current || !enabled || threadLoading || processing) return;
    if (selectedId && thread?.id !== selectedId) return;
    textarea.current?.focus();
    initialFocus.current = false;
  }, [enabled, threadLoading, processing, selectedId, thread?.id]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(''), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  useEffect(() => setPage(1), [search]);
  useEffect(() => {
    if (!selectedId || !storedTurns.some((turn) => turn.pending)) return;
    const timer = setInterval(
      () => refreshThread(selectedId).catch((failure) => setError(failure.message)),
      2500
    );
    return () => clearInterval(timer);
  }, [selectedId, storedTurns.some((turn) => turn.pending)]);
  const messages =
    pending && !storedTurns.some((item) => item.requestId === pending.requestId)
      ? [...storedTurns, pending]
      : storedTurns;
  const questions = analysis.findings.slice(0, 3);
  async function refreshThread(id) {
    const value = await api(`/conversations/${id}`);
    if (active.current && activeId.current === id) setThread(value);
    if (active.current) revise((value) => value + 1);
  }
  async function ask(value) {
    const text = value.trim();
    if (!enabled || processing || threadLoading || text.length < 3) return;
    setBusy(true);
    setError('');
    const request = new AbortController();
    controller.current = request;
    let id = selectedId;
    try {
      if (!id) {
        const created = await api(
          '/conversations',
          'POST',
          { datasetId: analysis.datasetId, title: text.slice(0, 100) },
          request.signal
        );
        id = created.id;
        activeId.current = id;
        setSelectedId(id);
        setThread(created);
      }
      setQuestion('');
      setPending({ id: 'pending', question: text, pending: true });
      await apiStream(
        '/assistant/stream',
        { conversationId: id, question: text, expectedDatasetVersion: analysis.version },
        (event, data) => {
          if (!active.current) return;
          if (event === 'status')
            setPending((previous) => ({ ...previous, requestId: data.requestId, pending: true }));
          if (event === 'answer')
            setPending((previous) => ({
              ...previous,
              answer: data.answer || data,
              pending: false
            }));
          if (event === 'error') setError(data.error || 'Не удалось получить ответ');
        },
        request.signal
      );
    } catch (failure) {
      if (!request.signal.aborted && active.current) setError(failure.message);
    } finally {
      if (active.current) {
        setBusy(false);
        controller.current = null;
        try {
          if (id) await refreshThread(id);
        } catch (failure) {
          setError(failure.message);
        }
        setPending(null);
        textarea.current?.focus({ preventScroll: true });
      }
    }
  }
  async function stop() {
    controller.current?.abort();
    setPending((previous) => (previous ? { ...previous, pending: false, cancelled: true } : null));
    if (selectedId)
      try {
        await api(`/conversations/${selectedId}/cancel`, 'POST', {});
        await refreshThread(selectedId);
      } catch (failure) {
        setError(failure.message);
      }
  }
  async function showSources(ids, version = analysis.version) {
    try {
      if (version === analysis.version) {
        setSources({ ids, analysis });
        return;
      }
      const snapshot = await api(`/datasets/${analysis.datasetId}/versions/${version}`);
      setSources({
        ids,
        analysis: {
          source: snapshot.data.source,
          version,
          records: Object.fromEntries(
            ['production', 'quality', 'downtime', 'plans'].map((key) => [key, snapshot.data[key]])
          ),
          warnings: ['Историческая версия набора, использованная для этого ответа.']
        }
      });
    } catch (failure) {
      setError(failure.message);
    }
  }
  async function copyAnswer(message) {
    try {
      await navigator.clipboard.writeText(
        [
          message.answer.summary,
          ...message.answer.observations.map((item) => `${item.title}\n${item.explanation}`),
          ...message.answer.nextSteps
        ].join('\n\n')
      );
      setCopied(message.id);
    } catch {
      setError('Не удалось скопировать. Выделите текст ответа и скопируйте его вручную.');
    }
  }
  return (
    <section className={`qarqyn-chat persistent-chat${messages.length ? ' has-conversation' : ''}`}>
      <div className="chat-toolbar">
        <Button
          tone="quiet"
          icon="source"
          onClick={() => setHistoryOpen(!historyOpen)}
          aria-expanded={historyOpen}
        >
          Диалоги
        </Button>
        <span className="chat-dataset-label">
          {analysis.name} · версия {analysis.version}
        </span>
        <Button
          tone="quiet"
          icon="plus"
          disabled={processing}
          onClick={() => {
            initialFocus.current = true;
            setSelectedId('');
            setThread(null);
            setQuestion('');
            setPending(null);
            setError('');
            setHistoryOpen(false);
            textarea.current?.focus({ preventScroll: true });
          }}
        >
          Новый
        </Button>
      </div>
      {historyOpen && (
        <section className="chat-history">
          <Field label="Поиск по истории диалогов">
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </Field>
          <ErrorBox>{history.error}</ErrorBox>
          {history.loading && <Loading label="Загружаем историю…" />}
          {!history.loading && history.data?.items.length === 0 && <p>Диалоги не найдены.</p>}
          <div className="chat-history-list">
            {history.data?.items.map((item) => (
              <div key={item.id}>
                <button
                  className="icon-button"
                  disabled={processing}
                  onClick={() => setRenaming(item)}
                  aria-label={`Переименовать диалог ${item.title}`}
                >
                  <Icon name="edit" size={17} />
                </button>
                <button
                  disabled={processing}
                  className="chat-history-title"
                  aria-current={item.id === selectedId ? 'true' : undefined}
                  onClick={() => {
                    setError('');
                    setSelectedId(item.id);
                    setThread(null);
                    setHistoryOpen(false);
                  }}
                >
                  <strong>{item.title}</strong>
                  <small>
                    {new Date(item.updatedAt || item.createdAt).toLocaleString('ru-RU')}
                  </small>
                </button>
                <button
                  className="icon-button"
                  disabled={processing}
                  onClick={() => setDeleting(item)}
                  aria-label={`Удалить диалог ${item.title}`}
                >
                  <Icon name="delete" size={17} />
                </button>
              </div>
            ))}
          </div>
          {history.data && (
            <Pagination
              page={page}
              pageSize={20}
              total={history.data.total}
              onChange={setPage}
              disabled={processing}
            />
          )}
        </section>
      )}
      <ErrorBox>{error}</ErrorBox>
      {threadLoading && <Loading label="Открываем диалог…" />}
      {!messages.length && !threadLoading && (
        <div className="chat-welcome">
          <div className="chat-brand">
            <Brand compact />
          </div>
          <h2>Что разберём в производстве?</h2>
          <p>От вопроса по данным до проверенного сценария.</p>
        </div>
      )}
      {messages.length > 0 && (
        <div className="chat-messages" aria-label="Диалог с помощником">
          {messages.map((message) => (
            <div className="chat-turn" key={message.id}>
              <div className="chat-user-message">
                <span className="chat-speaker">Вы</span>
                <p>{message.question}</p>
              </div>
              <article className="chat-assistant-message" aria-label="Ответ помощника">
                <header className="chat-answer-heading">
                  <Brand compact />
                  <span>QARQYN</span>
                </header>
                {message.pending && <Thinking />}
                {message.cancelled && <p role="status">Запрос остановлен. Вопрос сохранён.</p>}
                {message.error && <ErrorBox>{message.error}</ErrorBox>}
                {message.answer && (
                  <>
                    <Answer
                      answer={message.answer}
                      analysis={analysis}
                      canWrite={canWrite}
                      onSources={(ids) => showSources(ids, message.answer.datasetVersion)}
                    />
                    <div className="chat-answer-actions">
                      <button
                        className={`icon-button chat-answer-action${copied === message.id ? ' is-copied' : ''}`}
                        aria-label="Копировать ответ"
                        title={copied === message.id ? 'Скопировано' : 'Копировать ответ'}
                        onClick={() => copyAnswer(message)}
                      >
                        <Icon name={copied === message.id ? 'check' : 'copy'} size={19} />
                      </button>
                      <button
                        className="icon-button chat-answer-action"
                        aria-label="Проверить по текущим данным"
                        title="Проверить по текущим данным"
                        disabled={processing || !enabled || threadLoading}
                        onClick={() => ask(message.question)}
                      >
                        <Icon name="search" size={20} />
                      </button>
                      <span className="chat-sr-only" role="status">
                        {copied === message.id ? 'Ответ скопирован' : ''}
                      </span>
                    </div>
                  </>
                )}
                {!message.answer && !message.pending && (
                  <Button
                    disabled={processing || !enabled || threadLoading}
                    onClick={() => ask(message.question)}
                  >
                    Повторить вопрос
                  </Button>
                )}
              </article>
            </div>
          ))}
        </div>
      )}
      <div className="chat-compose-area">
        <form
          ref={composer}
          className={`chat-composer${processing ? ' is-processing' : ''}`}
          data-motion={composerVisible}
          onSubmit={(event) => {
            event.preventDefault();
            ask(question);
          }}
        >
          <svg className="chat-composer-orbit" aria-hidden="true" focusable="false">
            <rect className="orbit-tail" width="100%" height="100%" rx="27" pathLength="100" />
            <rect className="orbit-trail" width="100%" height="100%" rx="27" pathLength="100" />
            <rect className="orbit-head" width="100%" height="100%" rx="27" pathLength="100" />
          </svg>
          <label className="chat-sr-only" htmlFor="assistant-question">
            Сообщение помощнику
          </label>
          <textarea
            ref={textarea}
            id="assistant-question"
            name="question"
            maxLength={1200}
            rows={1}
            value={question}
            disabled={!enabled}
            placeholder="Спросите о производстве…"
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                ask(question);
              }
            }}
          />
          {processing ? (
            <button
              type="button"
              className="chat-send chat-stop"
              onClick={stop}
              aria-label="Остановить ответ"
              title="Остановить ответ"
            >
              <span aria-hidden="true" />
            </button>
          ) : (
            <button
              type="submit"
              className="chat-send"
              disabled={!enabled || threadLoading || question.trim().length < 3}
              aria-label="Отправить сообщение"
            >
              <Icon name="arrow" size={22} />
            </button>
          )}
        </form>
        {enabled && (
          <p className="chat-composer-context">
            <Icon name="source" size={13} />
            По текущим данным
          </p>
        )}
        {!canWrite ? (
          <p className="chat-compose-hint">
            Для диалога войдите в учётную запись с доступом к помощнику.
          </p>
        ) : !session.loading && !session.data?.aiAvailable ? (
          <p className="chat-compose-hint">Помощник не подключён. Проверьте настройки сервера.</p>
        ) : null}
      </div>
      {!messages.length && questions.length > 0 && (
        <div className="chat-suggestions">
          <p>Вопросы по вашим данным</p>
          <div>
            {questions.map((finding) => (
              <button
                key={finding.id}
                disabled={!enabled || processing || threadLoading}
                onClick={() => {
                  setQuestion(
                    `Разбери наблюдение «${finding.title}». На какие данные оно опирается и какие действия стоит проверить?`
                  );
                  textarea.current?.focus();
                }}
              >
                <span>{finding.title}</span>
                <Icon name="arrow" size={18} />
              </button>
            ))}
          </div>
        </div>
      )}
      {sources && (
        <Evidence analysis={sources.analysis} ids={sources.ids} onClose={() => setSources(null)} />
      )}
      {deleting && (
        <Confirm
          title="Удалить диалог?"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api(`/conversations/${deleting.id}`, 'DELETE', { version: deleting.version });
            if (selectedId === deleting.id) {
              setSelectedId('');
              setThread(null);
            }
            revise((value) => value + 1);
          }}
        >
          {deleting.title}. Вопросы и ответы будут удалены с сервера.
        </Confirm>
      )}
      {renaming && (
        <RenameConversation
          thread={renaming}
          onClose={() => setRenaming(null)}
          onSaved={async () => {
            setRenaming(null);
            revise((value) => value + 1);
            if (selectedId) await refreshThread(selectedId);
          }}
        />
      )}
    </section>
  );
}

function RenameConversation({ thread, onClose, onSaved }) {
  const [title, setTitle] = useState(thread.title),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal title="Название диалога" onClose={onClose} pending={busy} guardChanges>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try {
            await api(`/conversations/${thread.id}`, 'PATCH', { version: thread.version, title });
            await onSaved();
          } catch (failure) {
            setError(failure.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Название">
          <input
            required
            maxLength={120}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <ErrorBox>{error}</ErrorBox>
        <div className="form-actions">
          <Button type="button" data-close-modal disabled={busy}>
            Отмена
          </Button>
          <Button tone="primary" disabled={busy || !title.trim()}>
            {busy ? 'Сохраняем…' : 'Сохранить'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function SourceLinks({ ids, onOpen }) {
  if (!ids?.length) return null;
  return (
    <div className="chat-source-links" aria-label="Исходные записи">
      <Icon name="source" size={15} />
      {ids.map((id) => (
        <button key={id} onClick={() => onOpen([id])} aria-label={`Открыть источник ${id}`}>
          {id}
        </button>
      ))}
    </div>
  );
}

function Answer({ answer, analysis, canWrite, onSources }) {
  return (
    <div className="chat-answer-content">
      {answer.datasetVersion !== analysis.version && (
        <p className="chat-version-note">
          Ответ основан на версии {answer.datasetVersion}. Сейчас открыта версия {analysis.version};
          история сохранена, для нового решения обновите расчёт.
        </p>
      )}
      <p className="chat-summary">{answer.summary}</p>
      {answer.observations.length > 0 && (
        <div className="chat-observations">
          {answer.observations.map((observation, index) => (
            <section key={index}>
              <h3>{observation.title}</h3>
              <p>{observation.explanation}</p>
              <SourceLinks ids={observation.sourceIds} onOpen={onSources} />
            </section>
          ))}
        </div>
      )}
      {answer.proposal && answer.datasetVersion === analysis.version && (
        <Proposal
          proposal={answer.proposal}
          datasetVersion={answer.datasetVersion}
          analysis={analysis}
          canWrite={canWrite}
          onSources={onSources}
        />
      )}
      {answer.proposal && answer.datasetVersion !== analysis.version && (
        <div className="chat-version-note">
          <strong>{answer.proposal.title}</strong>
          <p>
            Исторический результат: {format(answer.proposal.result?.scenario.output, 2)} расчётных
            автомобилей. Интерактивные изменения доступны после повторного вопроса по текущим
            данным.
          </p>
        </div>
      )}
      {answer.nextSteps.length > 0 && (
        <section className="chat-next-steps">
          <h3>Что проверить дальше</h3>
          <ol>
            {answer.nextSteps.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ol>
        </section>
      )}
      {answer.limitations.length > 0 && (
        <details className="chat-disclosure">
          <summary>Границы ответа</summary>
          {answer.limitations.map((limitation, index) => (
            <p key={index}>{limitation}</p>
          ))}
        </details>
      )}
    </div>
  );
}

function Proposal({ proposal, datasetVersion, analysis, canWrite, onSources }) {
  const [input, setInput] = useState(proposal.input);
  const [result, setResult] = useState(null);
  const [calculating, setCalculating] = useState(true);
  const [revision, revise] = useState(0);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setCalculating(true);
    setError('');
    setResult(null);
    const timer = setTimeout(async () => {
      try {
        const next = await api(
          '/simulate',
          'POST',
          input,
          AbortSignal.any([controller.signal, AbortSignal.timeout(35000)])
        );
        if (controller.signal.aborted) return;
        if (next.datasetVersion !== datasetVersion)
          throw new Error('Набор данных изменился. Начните новый диалог по обновлённым данным.');
        setResult(next);
      } catch (error) {
        if (!controller.signal.aborted) setError(error.message);
      } finally {
        if (!controller.signal.aborted) setCalculating(false);
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [input, datasetVersion, revision]);

  function change(stageId, property, value) {
    setSaved(false);
    setCalculating(true);
    setResult(null);
    setInput((previous) => ({
      ...previous,
      interventions: previous.interventions.map((intervention) =>
        intervention.stageId === stageId ? { ...intervention, [property]: value } : intervention
      )
    }));
  }
  async function save() {
    if (!result || calculating || saving || !canWrite) return;
    setSaving(true);
    setError('');
    try {
      await api('/scenarios', 'POST', {
        name: proposal.title,
        note: proposal.explanation.slice(0, 2000),
        input,
        expectedDatasetVersion: datasetVersion
      });
      if (mounted.current) setSaved(true);
    } catch (error) {
      if (mounted.current) setError(error.message);
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <section className="chat-proposal">
      <header className="chat-proposal-header">
        <Icon name="lab" size={22} />
        <h3>Проверка решения</h3>
        <span className="feature-new">NEW</span>
      </header>
      <h4>{proposal.title}</h4>
      <p>{proposal.explanation}</p>
      <details className="chat-proposal-controls">
        <summary>
          Настроить условия <Icon name="edit" size={16} />
        </summary>
        <div>
          {input.interventions.map((intervention) => {
            const stage = analysis.stages.find((item) => item.id === intervention.stageId);
            if (!stage) return null;
            const recoveryLimit = proposal.recoveryLimits?.find(
              (limit) => limit.stageId === stage.id
            );
            const maximumRecovery = recoveryLimit?.maxMinutes ?? 0;
            return (
              <fieldset key={stage.id} disabled={saving}>
                <legend>{stage.name}</legend>
                <Field
                  label={
                    <span>
                      Вернуть время <b>{format(intervention.recoverMinutes, 1)} мин</b>
                    </span>
                  }
                >
                  <input
                    type="range"
                    min={0}
                    max={maximumRecovery}
                    disabled={!recoveryLimit || maximumRecovery === 0}
                    step="any"
                    value={intervention.recoverMinutes}
                    aria-label={`${stage.name}: вернуть минуты простоя`}
                    aria-valuetext={`${format(intervention.recoverMinutes, 1)} из ${format(maximumRecovery, 1)} минут`}
                    onChange={(event) =>
                      change(stage.id, 'recoverMinutes', Number(event.target.value))
                    }
                  />
                  <small>
                    Условно доступно {format(maximumRecovery, 1)} мин. Плановое ТО исключено.
                  </small>
                </Field>
                <Field
                  label={
                    <span>
                      Целевая доля брака{' '}
                      <b>{format(intervention.defectPct ?? stage.defectPct, 2)}%</b>
                    </span>
                  }
                >
                  <input
                    type="range"
                    min={0}
                    max={Math.max(
                      stage.defectPct || 0,
                      proposal.input.interventions.find((item) => item.stageId === stage.id)
                        ?.defectPct || 0,
                      0.01
                    )}
                    step="any"
                    value={intervention.defectPct ?? stage.defectPct ?? 0}
                    aria-label={`${stage.name}: целевая доля брака`}
                    aria-valuetext={`${format(intervention.defectPct ?? stage.defectPct, 2)} процентов`}
                    onChange={(event) => change(stage.id, 'defectPct', Number(event.target.value))}
                  />
                  <small>Исходная доля: {format(stage.defectPct, 2)}%</small>
                </Field>
              </fieldset>
            );
          })}
          <Button
            tone="quiet"
            disabled={saving}
            onClick={() => {
              setInput(proposal.input);
              setSaved(false);
            }}
          >
            Вернуть предложение помощника
          </Button>
        </div>
      </details>
      <div className="chat-proposal-result" aria-busy={calculating} aria-live="polite">
        {calculating ? (
          <p role="status">Пересчитываем выпуск по выбранным условиям…</p>
        ) : result ? (
          <>
            <div className="chat-flow-comparison">
              <div>
                <span>Исходный выпуск</span>
                <strong>{format(result.baseline.output, 1)}</strong>
              </div>
              <Icon name="arrow" size={22} />
              <div>
                <span>С изменениями</span>
                <strong>{format(result.scenario.output, 1)}</strong>
              </div>
              <b className={result.delta >= 0 ? 'positive' : 'negative'}>
                {result.delta > 0 ? '+' : ''}
                {format(result.delta, 1)}
              </b>
            </div>
            <p>
              Расчётных автомобилей за {format(input.hours)} ч. Реальный эффект требует проверки.
            </p>
          </>
        ) : null}
      </div>
      <ErrorBox>{error}</ErrorBox>
      {!result && !calculating && (
        <Button onClick={() => revise((value) => value + 1)}>Повторить расчёт</Button>
      )}
      <div className="chat-proposal-actions">
        <Button
          disabled={calculating || !result || saving}
          onClick={() => openWorkflow('lab', { ...input, datasetVersion })}
        >
          Открыть в лаборатории
        </Button>
        <Button
          disabled={!canWrite || calculating || !result || saved || saving}
          onClick={save}
          icon={saved ? 'check' : 'plus'}
        >
          {saved ? 'Сценарий сохранён' : saving ? 'Сохраняем…' : 'Сохранить в сценарии'}
        </Button>
        {result && (
          <Button
            disabled={!canWrite || calculating || saving}
            onClick={() =>
              openWorkflow('incidents', {
                datasetId: analysis.datasetId,
                datasetVersion,
                stageId: input.interventions.length === 1 ? input.interventions[0].stageId : null,
                title: proposal.title,
                description:
                  `${proposal.explanation}\nВерсия источника: ${datasetVersion}. Горизонт ${input.hours} ч, период ${input.observationHours} ч. Прирост в модели: ${format(result.delta, 2)} шт. Требуется проверить фактический эффект.`.slice(
                    0,
                    3000
                  )
              })
            }
          >
            Создать задачу
          </Button>
        )}
      </div>
      <details className="chat-disclosure">
        <summary>Источники и допущения расчёта</summary>
        <p>
          Версия данных {datasetVersion}. Исходный период принят равным {input.observationHours} ч.
        </p>
        {(result || proposal.result).assumptions.map((assumption, index) => (
          <p key={index}>{assumption}</p>
        ))}
        {(result || proposal.result).evidence.map((item) => (
          <div key={item.stageId}>
            <p>{analysis.stages.find((stage) => stage.id === item.stageId)?.name}</p>
            <SourceLinks ids={item.sourceIds} onOpen={onSources} />
          </div>
        ))}
      </details>
    </section>
  );
}

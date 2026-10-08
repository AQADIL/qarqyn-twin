import { useEffect, useRef, useState } from 'react';
import { api, format } from './api.js';
import { Brand, Icon } from './icons.jsx';
import { Button, Field, ErrorBox, Evidence, useResource } from './ui.jsx';
import './Assistant.css';

export default function Assistant({ analysis, canWrite }) {
  return (
    <Conversation
      key={`${analysis.datasetId}:${analysis.version}`}
      analysis={analysis}
      canWrite={canWrite}
    />
  );
}

function Conversation({ analysis, canWrite }) {
  const [revision, revise] = useState(0);
  const session = useResource('/session', revision);
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [sources, setSources] = useState(null);
  const controller = useRef(null);
  const textarea = useRef(null);
  const lastMessage = useRef(null);
  const enabled = Boolean(session.data?.aiAvailable && canWrite);
  const hasConversation = messages.length > 0;
  const questions = analysis.findings.slice(0, 3).map((finding) => ({
    id: finding.id,
    title: finding.title,
    question:
      `Разбери наблюдение «${finding.title}». Какие источники его подтверждают и что можно проверить с помощью сценария?`.slice(
        0,
        1200
      )
  }));

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!textarea.current) return;
    textarea.current.style.height = 'auto';
    textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 200)}px`;
  }, [question]);
  useEffect(() => {
    if (messages.length)
      lastMessage.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }, [messages.length]);

  async function ask(value, retryId) {
    const nextQuestion = value.trim();
    if (!enabled || controller.current || nextQuestion.length < 3) return;
    const request = new AbortController();
    controller.current = request;
    const id = retryId || crypto.randomUUID();
    const precedingMessages = retryId
      ? messages.slice(
          0,
          messages.findIndex((message) => message.id === retryId)
        )
      : messages;
    const history = precedingMessages
      .filter((message) => message.answer && message.id !== retryId)
      .slice(-6)
      .map((message) => ({
        question: message.question,
        summary: message.answer.summary.slice(0, 4000)
      }));
    setMessages((previous) =>
      retryId
        ? previous.map((message) =>
            message.id === retryId ? { ...message, error: '', pending: true } : message
          )
        : [...previous, { id, question: nextQuestion, pending: true }]
    );
    if (!retryId) setQuestion('');
    setBusy(true);
    try {
      const answer = await api(
        '/assistant',
        'POST',
        { datasetId: analysis.datasetId, question: nextQuestion, history },
        AbortSignal.any([request.signal, AbortSignal.timeout(100000)])
      );
      if (request.signal.aborted) return;
      if (answer.datasetVersion !== analysis.version)
        throw new Error(
          'Данные обновились во время ответа. Обновите набор и задайте вопрос снова.'
        );
      setMessages((previous) =>
        previous.map((message) =>
          message.id === id ? { ...message, answer, pending: false, error: '' } : message
        )
      );
    } catch (error) {
      if (request.signal.aborted) return;
      setMessages((previous) =>
        previous.map((message) =>
          message.id === id
            ? {
                ...message,
                pending: false,
                error:
                  error.name === 'TimeoutError'
                    ? 'Ответ не успел прийти. Попробуйте отправить вопрос ещё раз.'
                    : error.message
              }
            : message
        )
      );
    } finally {
      if (!request.signal.aborted) {
        controller.current = null;
        setBusy(false);
        textarea.current?.focus({ preventScroll: true });
      }
    }
  }

  return (
    <section className={`qarqyn-chat ${hasConversation ? 'has-conversation' : ''}`}>
      <div className="chat-toolbar">
        <details className="chat-context">
          <summary>
            <Icon name="data" size={17} />
            <span>Контекст: {analysis.name}</span>
          </summary>
          <div className="chat-context-body">
            <p>Наблюдения по текущему набору. Откройте источник или задайте вопрос по находке.</p>
            {analysis.findings.map((finding) => (
              <div className="chat-context-finding" key={finding.id}>
                <h3>{finding.title}</h3>
                <p>{finding.detail}</p>
                <SourceLinks ids={finding.sourceIds} onOpen={setSources} />
              </div>
            ))}
            {!analysis.findings.length && <p>В этом наборе нет выделенных отклонений.</p>}
            <button className="text-button" onClick={() => setSources(undefined)}>
              Все исходные записи <Icon name="source" size={16} />
            </button>
          </div>
        </details>
        {hasConversation && (
          <Button
            tone="quiet"
            icon="plus"
            disabled={busy}
            onClick={() => {
              setMessages([]);
              setQuestion('');
              textarea.current?.focus();
            }}
          >
            Новый диалог
          </Button>
        )}
      </div>

      {!hasConversation && (
        <div className="chat-welcome">
          <div className="chat-brand">
            <Brand compact />
          </div>
          <h2>Что разберём в производстве?</h2>
          <p>Спросите о данных. Найдём причины для проверки и сравним возможные решения.</p>
        </div>
      )}

      {hasConversation && (
        <div className="chat-messages" aria-label="Диалог с помощником">
          {messages.map((message, index) => (
            <div
              className="chat-turn"
              key={message.id}
              ref={index === messages.length - 1 ? lastMessage : null}
            >
              <div className="chat-user-message">
                <span className="chat-speaker">Вы</span>
                <p>{message.question}</p>
              </div>
              <article className="chat-assistant-message" aria-label="Ответ помощника">
                <header className="chat-answer-heading">
                  <Brand compact />
                  <span>QARQYN</span>
                </header>
                {message.pending && (
                  <div className="chat-thinking" role="status">
                    <span className="chat-thinking-line" />
                    Изучаю данные и проверяю возможные решения…
                  </div>
                )}
                {message.error && (
                  <div className="chat-request-error">
                    <ErrorBox>{message.error}</ErrorBox>
                    <Button
                      disabled={!enabled || busy}
                      onClick={() => ask(message.question, message.id)}
                    >
                      Повторить вопрос
                    </Button>
                  </div>
                )}
                {message.answer && (
                  <Answer
                    answer={message.answer}
                    analysis={analysis}
                    canWrite={canWrite}
                    onSources={setSources}
                  />
                )}
              </article>
            </div>
          ))}
        </div>
      )}

      <div className="chat-compose-area">
        <form
          className="chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            ask(question);
          }}
        >
          <label className="chat-sr-only" htmlFor="assistant-question">
            Сообщение помощнику
          </label>
          <textarea
            ref={textarea}
            id="assistant-question"
            name="question"
            autoComplete="off"
            minLength={3}
            maxLength={1200}
            rows={2}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                ask(question);
              }
            }}
            disabled={!enabled}
            placeholder="Спросите о производстве или предложите изменение…"
            aria-describedby="chat-composer-hint"
          />
          <div className="chat-composer-bottom">
            <span>
              <Icon name="source" size={15} /> По текущим данным
            </span>
            <button
              type="submit"
              className="chat-send"
              disabled={!enabled || busy || question.trim().length < 3}
              aria-label={busy ? 'Ожидаем ответ помощника' : 'Отправить сообщение'}
            >
              <Icon name="arrow" size={22} />
            </button>
          </div>
        </form>
        <div className="chat-compose-hint" id="chat-composer-hint">
          {session.loading ? (
            <span role="status">Подключаем помощника…</span>
          ) : session.error ? (
            <span role="alert">
              {session.error}{' '}
              <button className="text-button" onClick={() => revise((value) => value + 1)}>
                Повторить
              </button>
            </span>
          ) : !canWrite ? (
            <span>Чтобы общаться с помощником, войдите как редактор через меню слева.</span>
          ) : !session.data?.aiAvailable ? (
            <span>Помощник пока не подключён. Подключение настраивает владелец приложения.</span>
          ) : (
            <span>Enter — отправить · Shift + Enter — новая строка</span>
          )}
        </div>
      </div>

      {!hasConversation && questions.length > 0 && (
        <div className="chat-suggestions" aria-label="Вопросы по вашим данным">
          <p>Можно начать с того, что видно в данных</p>
          <div>
            {questions.map((item) => (
              <button
                type="button"
                key={item.id}
                disabled={!enabled || busy}
                onClick={() => {
                  setQuestion(item.question);
                  textarea.current?.focus();
                }}
              >
                <span>{item.title}</span>
                <Icon name="arrow" size={18} />
              </button>
            ))}
          </div>
        </div>
      )}
      {sources !== null && (
        <Evidence analysis={analysis} ids={sources} onClose={() => setSources(null)} />
      )}
    </section>
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
      {answer.proposal && (
        <Proposal
          proposal={answer.proposal}
          datasetVersion={answer.datasetVersion}
          analysis={analysis}
          canWrite={canWrite}
          onSources={onSources}
        />
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
          disabled={!canWrite || calculating || !result || saved || saving}
          onClick={save}
          icon={saved ? 'check' : 'plus'}
        >
          {saved ? 'Сценарий сохранён' : saving ? 'Сохраняем…' : 'Сохранить в сценарии'}
        </Button>
        {saved && (
          <a className="text-button" href="#/app/lab">
            Открыть сценарии <Icon name="arrow" size={16} />
          </a>
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

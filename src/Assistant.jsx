import { useState } from 'react';
import { api, format } from './api.js';
import { Icon } from './icons.jsx';
import { Button, Field, ErrorBox, Evidence, useResource } from './ui.jsx';

export default function Assistant({ analysis, canWrite }) {
  const [revision, revise] = useState(0),
    session = useResource('/session', revision);
  const [question, setQuestion] = useState(''),
    [answer, setAnswer] = useState(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false),
    [saving, setSaving] = useState(false),
    [sources, setSources] = useState(null);
  const enabled = session.data?.aiAvailable && canWrite;
  const questions = [
    'Какие отклонения требуют проверки в первую очередь?',
    'Сравни эффект улучшения сварки и окраски. Предложи проверяемый сценарий.',
    'Каких данных не хватает для прогноза простоев и расчёта OEE?'
  ];
  async function ask(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setAnswer(null);
    setSaved(false);
    try {
      setAnswer(await api('/assistant', 'POST', { datasetId: analysis.datasetId, question }));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      revise((v) => v + 1);
    }
  }
  async function save() {
    setSaving(true);
    setError('');
    try {
      await api('/scenarios', 'POST', {
        name: answer.proposal.title,
        note: `Предложение ${answer.provider}. ${answer.proposal.explanation}`.slice(0, 2000),
        input: answer.proposal.input
      });
      setSaved(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <div className="page-intro">
        <div>
          <span className="eyebrow">ИИ + ПРОВЕРЯЕМАЯ МОДЕЛЬ</span>
          <h2>Инженерный помощник</h2>
          <p>
            Разбирает факты, предлагает гипотезу. Эффект предложения пересчитывает серверная модель.
          </p>
        </div>
        <Icon name="source" size={54} />
      </div>
      <div className="assistant-layout">
        <section>
          <div className="assistant-status">
            <Icon name="lock" />
            <div>
              <h3>
                {session.data?.aiAvailable
                  ? canWrite
                    ? `${session.data.ai.model} · ${session.data.ai.reasoning}`
                    : 'ИИ доступен редактору'
                  : 'Внешний ИИ не подключён'}
              </h3>
              <p>
                {session.data?.aiAvailable
                  ? 'Вопрос, производственные записи и сводка отправляются OpenAI. Не включайте персональные данные и конфиденциальные сведения без разрешения.'
                  : 'Аналитика и лаборатория сценариев работают локально. Подключение ИИ настраивает владелец сервера.'}
              </p>
              {session.data?.ai && (
                <small>
                  Учтённый расход приложения ${format(session.data.ai.accountedUsd, 4)} / лимит $
                  {format(session.data.ai.limitUsd, 2)}. Оценка по настройкам тарифа, не баланс
                  OpenAI.
                </small>
              )}
            </div>
          </div>
          <form onSubmit={ask}>
            <Field label="Вопрос по текущему набору">
              <textarea
                name="question"
                autoComplete="off"
                required
                minLength={3}
                maxLength={1200}
                rows={4}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                disabled={!enabled || busy}
                placeholder="Например: где находится резерв выпуска…"
              />
            </Field>
            <div className="question-examples">
              {questions.map((q) => (
                <button
                  key={q}
                  type="button"
                  disabled={!enabled || busy}
                  onClick={() => setQuestion(q)}
                >
                  {q}
                </button>
              ))}
            </div>
            <Button tone="primary" disabled={!enabled || busy} icon="arrow">
              {busy ? 'Анализируем данные…' : 'Отправить данные и вопрос'}
            </Button>
            {busy && (
              <p className="request-status" role="status">
                Модель изучает источники и ограничения. Предельное ожидание — 90 секунд. Повторные
                запросы автоматически не отправляются.
              </p>
            )}
            <ErrorBox>{error}</ErrorBox>
          </form>
          {answer && (
            <article className="assistant-answer">
              <header>
                <span className="eyebrow">
                  ОТВЕТ / {answer.provider} · {answer.reasoning}
                </span>
                {answer.usage && (
                  <small>
                    Оценка запроса ${format(answer.usage.estimatedCostUsd, 5)} ·{' '}
                    {format(answer.usage.outputTokens)} выходных токенов, включая рассуждения
                  </small>
                )}
              </header>
              <p className="preserve-lines">{answer.summary}</p>
              <div className="ai-observations">
                {answer.observations.map((o, i) => (
                  <section key={i}>
                    <h3>{o.title}</h3>
                    <p>{o.explanation}</p>
                    <button className="text-button" onClick={() => setSources(o.sourceIds)}>
                      Проверить {o.sourceIds.join(', ')} <Icon name="source" size={16} />
                    </button>
                  </section>
                ))}
              </div>
              {answer.proposal && (
                <section className="ai-proposal">
                  <span className="eyebrow">ПРЕДЛОЖЕНО ИИ / ПЕРЕСЧИТАНО СЕРВЕРОМ</span>
                  <h3>{answer.proposal.title}</h3>
                  <p>{answer.proposal.explanation}</p>
                  <div className="ai-comparison">
                    <div>
                      <span>Базовый поток</span>
                      <strong>{format(answer.proposal.result.baseline.output, 1)}</strong>
                    </div>
                    <Icon name="arrow" />
                    <div>
                      <span>После изменений</span>
                      <strong>{format(answer.proposal.result.scenario.output, 1)}</strong>
                    </div>
                    <b className={answer.proposal.result.delta >= 0 ? 'positive' : 'negative'}>
                      {answer.proposal.result.delta > 0 ? '+' : ''}
                      {format(answer.proposal.result.delta, 1)}
                    </b>
                  </div>
                  <p className="small-note">
                    Горизонт {answer.proposal.hours} ч, допущение о строке{' '}
                    {answer.proposal.observationHours} ч. Расчётные автомобили, не гарантированный
                    выпуск.
                  </p>
                  <Button onClick={save} disabled={saved || saving} icon={saved ? 'check' : 'plus'}>
                    {saved
                      ? 'Сохранено в сценариях'
                      : saving
                        ? 'Сохраняем…'
                        : 'Сохранить для проверки'}
                  </Button>
                </section>
              )}
              <h3>Следующие действия</h3>
              <ol className="ai-next-steps">
                {answer.nextSteps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
              <details open>
                <summary>Ограничения ответа</summary>
                {answer.limitations.map((s, i) => (
                  <p key={i}>{s}</p>
                ))}
                <p>
                  Проверка ID подтверждает наличие источника, но не достоверность каждой фразы ИИ.
                  Решение проверяет инженер.
                </p>
              </details>
            </article>
          )}
        </section>
        <aside>
          <h3>Уже видно в данных</h3>
          {analysis.findings.map((f) => (
            <article key={f.id}>
              <h4>{f.title}</h4>
              <p>{f.detail}</p>
              <button className="text-button" onClick={() => setSources(f.sourceIds)}>
                Источники: {f.sourceIds.join(', ')}
              </button>
            </article>
          ))}
          <p className="small-note">
            Эти сигналы рассчитаны правилами; они не являются ответом языковой модели.
          </p>
        </aside>
      </div>
      {sources && <Evidence analysis={analysis} ids={sources} onClose={() => setSources(null)} />}
    </>
  );
}

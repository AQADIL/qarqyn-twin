import { useState } from 'react';
import { downloadJson, format } from './api.js';
import { Button, ErrorBox, Field, Loading, useResource } from './ui.jsx';
import './forecast-validation.css';

const states = {
  insufficient: 'Нужны данные',
  baseline: 'База сравнения',
  better: 'Есть преимущество'
};

export default function ForecastValidation({ dataset }) {
  const [revision, setRevision] = useState(0);
  const [selection, setSelection] = useState('');
  const resource = useResource(
    `/forecast-validation/${encodeURIComponent(dataset.id)}`,
    `${dataset.version}:${revision}`
  );
  const report = resource.data;
  if (resource.loading) return <Loading label="Сравниваем прогноз с базовым методом…" />;
  if (!report)
    return (
      <div className="forecast-validation">
        <ErrorBox>{resource.error}</ErrorBox>
        <Button onClick={() => setRevision((value) => value + 1)}>Повторить проверку</Button>
      </div>
    );
  if (report.datasetVersion !== dataset.version)
    return <Loading label="Синхронизируем проверку с текущей версией данных…" />;
  const options = report.stages.flatMap((stage) =>
    stage.metrics.map((metric) => ({
      ...metric,
      stageName: stage.name,
      id: `${stage.stageId}:${metric.key}`
    }))
  );
  const selected = options.find((option) => option.id === selection) || options[0];
  return (
    <section className="forecast-validation" aria-label="Независимая проверка прогноза">
      <ErrorBox>{resource.error}</ErrorBox>
      <header className="forecast-validation-heading">
        <div>
          <h3>Прогноз должен обыграть простую базу.</h3>
          <p>
            Откладываем часть истории и проверяем, насколько точнее получается предсказывать
            следующий период.
          </p>
        </div>
        <Button
          onClick={() =>
            downloadJson(report, `forecast-validation-${dataset.id}-v${dataset.version}.json`)
          }
        >
          Скачать проверку
        </Button>
      </header>
      <div className="forecast-validation-summary">
        <p>
          Преимущество:{' '}
          <strong>
            {format(report.summary.better)} из {format(report.summary.totalMetrics)}
          </strong>{' '}
          показателей
        </p>
        <p>
          Проверены на отложенной истории: <strong>{format(report.summary.evaluated)}</strong>
        </p>
        <p>
          Требуют данных: <strong>{format(report.summary.insufficient)}</strong>
        </p>
      </div>
      {selected && (
        <>
          <Field label="Участок и показатель для проверки">
            <select value={selected.id} onChange={(event) => setSelection(event.target.value)}>
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.stageName} · {option.label}
                </option>
              ))}
            </select>
          </Field>
          <div className="forecast-validation-verdict" aria-live="polite">
            <span className={`forecast-validation-status ${selected.status}`}>
              {states[selected.status]}
            </span>
            <h4>{selected.verdict}</h4>
            <p>{selected.scope}</p>
          </div>
          {selected.readiness.blockers.length > 0 && (
            <div className="forecast-validation-next">
              <h4>Что нужно для следующей проверки</h4>
              <ul>
                {selected.readiness.blockers.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
              <a href="#/app/data">Открыть данные и дополнить историю</a>
            </div>
          )}
          <dl className="forecast-validation-coverage">
            <div>
              <dt>Сопоставимых наблюдений</dt>
              <dd>{format(selected.observations)}</dd>
            </div>
            <div>
              <dt>До первой проверки</dt>
              <dd>{format(selected.readiness.additionalObservations)} периодов</dd>
            </div>
            <div>
              <dt>Исключено после смены режима</dt>
              <dd>{format(selected.readiness.excludedPriorRegimeDates)} дат</dd>
            </div>
          </dl>
          {selected.metrics && (
            <>
              <div className="forecast-validation-split">
                <div>
                  <strong>Выбор метода</strong>
                  <span>
                    {selected.training.from} — {selected.training.through}
                  </span>
                  <span>{format(selected.training.observations)} периодов</span>
                </div>
                <div>
                  <strong>Независимая проверка</strong>
                  <span>
                    {selected.holdout.from} — {selected.holdout.through}
                  </span>
                  <span>{format(selected.holdout.observations)} периодов</span>
                </div>
              </div>
              <p className="forecast-validation-method">
                Зафиксированный метод: <strong>{selected.selectedMethodLabel}</strong>. Одношаговый
                ориентир после проверки:{' '}
                <strong>
                  {format(selected.nextEstimate, 2)} {selected.unit}
                </strong>
                .
              </p>
              <div
                className="forecast-validation-table"
                tabIndex={0}
                role="region"
                aria-label="Ошибки методов на контрольном отрезке"
              >
                <table>
                  <caption>Меньше ошибка — точнее прогноз. Все ошибки в {selected.unit}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Метод</th>
                      <th scope="col">Средняя абсолютная ошибка</th>
                      <th scope="col">Среднеквадратичная ошибка</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th scope="row">Выбранный метод</th>
                      <td>{format(selected.metrics.mae, 3)}</td>
                      <td>{format(selected.metrics.rmse, 3)}</td>
                    </tr>
                    <tr>
                      <th scope="row">Последнее наблюдение</th>
                      <td>{format(selected.metrics.baselineMae, 3)}</td>
                      <td>{format(selected.metrics.baselineRmse, 3)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="forecast-validation-paired">
                <p>
                  Снижение средней ошибки:{' '}
                  <strong>
                    {selected.metrics.improvementPct === null
                      ? 'не определяется: базовая ошибка равна нулю'
                      : `${format(selected.metrics.improvementPct, 1)}%`}
                  </strong>
                </p>
                <p>
                  По отдельным периодам:{' '}
                  <strong>{format(selected.pairedEvidence.wins)} лучше</strong>,{' '}
                  {format(selected.pairedEvidence.ties)} одинаково,{' '}
                  {format(selected.pairedEvidence.losses)} хуже базы.
                </p>
                <p>
                  Выигрыш сохранился в{' '}
                  <strong>{selected.pairedEvidence.positiveBlocks} из 4</strong> последовательных
                  блоков.
                </p>
                {selected.pairedEvidence.interval ? (
                  <p>
                    Диапазон устойчивости разницы ошибок:{' '}
                    <strong>
                      {format(selected.pairedEvidence.interval.low, 3)} …{' '}
                      {format(selected.pairedEvidence.interval.high, 3)} {selected.unit}
                    </strong>
                    . Положительное значение означает выигрыш. Это перепроверка прошлых ошибок, не
                    гарантия будущего результата.
                  </p>
                ) : (
                  <p>
                    Для блочной проверки устойчивости нужно минимум{' '}
                    {report.protocol.minimumStabilityHoldout} контрольных периодов. Сейчас{' '}
                    {selected.holdout.observations}.
                  </p>
                )}
              </div>
              <details className="forecast-validation-detail">
                <summary>Посмотреть каждый прогноз и исходные записи</summary>
                <div
                  className="forecast-validation-table"
                  tabIndex={0}
                  role="region"
                  aria-label="Прогнозы по периодам"
                >
                  <table>
                    <caption>
                      Метод выбран по данным до {selected.training.through}. Для каждой строки
                      доступна только более ранняя история.
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Дата</th>
                        <th scope="col">Факт</th>
                        <th scope="col">Прогноз</th>
                        <th scope="col">База</th>
                        <th scope="col">Ошибка</th>
                        <th scope="col">Ошибка базы</th>
                        <th scope="col">Записи</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.rows.map((row) => (
                        <tr key={row.date}>
                          <th scope="row">{row.date}</th>
                          <td>{format(row.actual, 2)}</td>
                          <td>{format(row.predicted, 2)}</td>
                          <td>{format(row.baseline, 2)}</td>
                          <td>{format(row.absoluteError, 2)}</td>
                          <td>{format(row.baselineError, 2)}</td>
                          <td>
                            {row.sourceIds.length
                              ? row.sourceIds.join(', ')
                              : 'Подтверждён период без событий'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
              <details className="forecast-validation-detail">
                <summary>Как выбран метод</summary>
                <ul>
                  {selected.training.candidates.map((method) => (
                    <li key={method.method}>
                      {method.label}: ошибка {format(method.selectionMae, 3)} {selected.unit} на{' '}
                      {method.folds} шагах только обучающей истории.
                    </li>
                  ))}
                </ul>
              </details>
            </>
          )}
        </>
      )}
      <details className="forecast-validation-detail">
        <summary>Протокол проверки и границы результата</summary>
        <p>{report.protocol.label}</p>
        <p>{report.protocol.updateRule}</p>
        <p>{report.protocol.successRule}</p>
        <p>{report.protocol.limitations}</p>
        <p>
          <a href={report.protocol.references[0]} target="_blank" rel="noreferrer">
            Метод последовательной проверки
          </a>{' '}
          ·{' '}
          <a href={report.protocol.references[1]} target="_blank" rel="noreferrer">
            Оценка ошибок прогноза
          </a>
        </p>
      </details>
    </section>
  );
}

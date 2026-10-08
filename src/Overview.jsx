import { useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { Icon } from './icons.jsx';
import { Button } from './ui.jsx';
import { format } from './api.js';
import { stageImage, stageIcon } from './stage-assets.js';

export default function Overview({ analysis: a, evidence, navigate }) {
  const [selected, select] = useState('painting');
  const reduceMotion = useReducedMotion();
  const stage = a.stages.find((s) => s.id === selected) || a.stages[0];
  const metrics = [
    [
      'Выпуск · ' + a.totals.outputStage,
      a.totals.output,
      `План ${format(a.totals.outputPlan)} операций`,
      'шт'
    ],
    ['Простой оборудования', a.totals.downtimeMinutes, 'Сумма событий по оборудованию', 'мин'],
    ['Дефектные операции', a.totals.defects, 'Не число уникальных автомобилей', 'шт'],
    [
      'Разрыв месячного плана',
      a.totals.planGap,
      `${format(a.totals.monthlyPlanned)} из ${format(a.totals.monthlyTarget)} автомобилей`,
      'шт'
    ]
  ];
  return (
    <>
      <section className="metric-strip" aria-label="Ключевые показатели">
        {metrics.map(([label, value, hint, unit]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>
              {format(value)}
              <small>{unit}</small>
            </strong>
            <p>{hint}</p>
          </div>
        ))}
      </section>
      <div className="overview-grid">
        <section className="process-panel">
          <header className="section-head">
            <div>
              <h2>От детали до автомобиля</h2>
            </div>
            <span className="status-tag">Исторические данные</span>
          </header>
          <div className="production-track" aria-label="Выберите участок">
            {a.stages.map((s, i) => (
              <button
                key={s.id}
                className={stage.id === s.id ? 'production-stage selected' : 'production-stage'}
                onClick={() => select(s.id)}
                aria-pressed={stage.id === s.id}
                aria-controls="stage-inspector"
              >
                <span className="production-stage-heading">
                  <span>{i + 1}</span>
                  <strong>
                    {{ warehouse: 'Склад', quality: 'Контроль', finished: 'Выпуск' }[s.id] ||
                      s.name}
                  </strong>
                </span>
                <motion.img
                  src={stageImage(s.id)}
                  alt=""
                  width="1024"
                  height="1024"
                  animate={{
                    y: !reduceMotion && stage.id === s.id ? -8 : 0,
                    scale: !reduceMotion && stage.id === s.id ? 1.07 : 1
                  }}
                  transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                />
                <span className="production-stage-output">
                  {s.observations ? `${format(s.actual)} / ${format(s.plan)}` : 'Нет наблюдений'}
                </span>
                <span className="production-stage-caption">
                  {s.observations ? 'факт / план' : 'участок цепочки'}
                </span>
              </button>
            ))}
          </div>
          <p className="production-caption">
            Выберите участок, чтобы проверить показатели. AI-иллюстрации передают процесс, а не
            точную геометрию завода.
          </p>
          <div className="process-guide">
            <Icon name="source" size={24} />
            <p>
              За каждым показателем — исходная запись. За каждым изменением — пересчитанный
              сценарий.
            </p>
            <button className="text-button" onClick={() => evidence()}>
              Проверить данные <Icon name="arrow" size={18} />
            </button>
          </div>
        </section>
        <aside
          className="inspector production-inspector"
          id="stage-inspector"
          aria-label="Показатели выбранного участка"
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={stage.id}
              initial={{ opacity: 0, y: reduceMotion ? 0 : 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16 }}
            >
              <div className="inspector-label">
                <span className="eyebrow">
                  УЧАСТОК / {String(a.stages.indexOf(stage) + 1).padStart(2, '0')}
                </span>
                <Icon name={stageIcon(stage.id)} size={38} />
              </div>
              <h2>{stage.name}</h2>
              {stage.observations ? (
                <>
                  <div className="big-reading">
                    <strong>
                      {format(stage.defectPct, 2)}
                      <small>%</small>
                    </strong>
                    <span>доля дефектных операций</span>
                  </div>
                  <div className="meter">
                    <span style={{ width: `${Math.min(100, stage.planPct)}%` }} />
                  </div>
                  <dl className="stat-list">
                    <div>
                      <dt>Выпуск / план</dt>
                      <dd>
                        {format(stage.actual)} / {format(stage.plan)}
                      </dd>
                    </div>
                    <div>
                      <dt>Загрузка по источнику</dt>
                      <dd>{format(stage.utilizationPct, 1)}%</dd>
                    </div>
                    <div>
                      <dt>Простой оборудования</dt>
                      <dd>{format(stage.downtimeMinutes)} мин</dd>
                    </div>
                    <div>
                      <dt>Доля брака</dt>
                      <dd className={stage.defectPct > a.targets.maxDefectPct ? 'negative' : ''}>
                        {format(stage.defectPct, 2)}%
                      </dd>
                    </div>
                    <div>
                      <dt>Дефектные операции</dt>
                      <dd>
                        {format(stage.defects)} / {format(stage.inspected)}
                      </dd>
                    </div>
                  </dl>
                  <p className="inspector-note">
                    {stage.defectPct > a.targets.maxDefectPct
                      ? `Брак выше порога ${a.targets.maxDefectPct}%. Проверьте влияние на конечный поток.`
                      : 'Проверьте источники и сопоставьте показатели с другими участками.'}
                  </p>
                  <Button tone="primary" onClick={() => navigate('lab')} icon="lab">
                    Проверить сценарий
                  </Button>
                  <button className="text-button" onClick={() => evidence(stage.sourceIds)}>
                    Исходные записи <Icon name="arrow" size={16} />
                  </button>
                </>
              ) : (
                <div className="no-observations">
                  <h3>Часть технологической цепочки</h3>
                  <p>
                    В исходном наборе нет наблюдений по этому участку. Его показатели не
                    рассчитываются.
                  </p>
                  <Button onClick={() => navigate('data')}>Посмотреть данные</Button>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </aside>
      </div>
      <div className="bottom-grid">
        <section className="flat-panel">
          <header className="section-head">
            <div>
              <h2>Ритм участков</h2>
            </div>
            <div className="legend">
              <span>
                <i />
                Факт
              </span>
              <span>
                <i />
                План
              </span>
            </div>
          </header>
          <div className="bar-chart">
            {a.stages
              .filter((s) => s.observations)
              .map((s) => (
                <div className="chart-row" key={s.id}>
                  <span>{s.name}</span>
                  <div className="bars">
                    <div
                      className="plan-bar"
                      style={{
                        width: `${(s.plan / Math.max(...a.stages.map((v) => Math.max(v.plan, v.actual)), 1)) * 100}%`
                      }}
                    />
                    <div
                      className="actual-bar"
                      style={{
                        width: `${(s.actual / Math.max(...a.stages.map((v) => Math.max(v.plan, v.actual)), 1)) * 100}%`
                      }}
                    />
                  </div>
                  <b>
                    {format(s.actual)}
                    <small> / {format(s.plan)}</small>
                  </b>
                </div>
              ))}
          </div>
          <p className="small-note">Операции разных участков не суммируются.</p>
        </section>
        <section className="flat-panel">
          <header className="section-head">
            <div>
              <h2>
                Сигналы из данных <span className="count">{a.findings.length}</span>
              </h2>
            </div>
          </header>
          <div className="finding-list">
            {a.findings.slice(0, 3).map((f) => (
              <button key={f.id} onClick={() => evidence(f.sourceIds)}>
                <span className={`signal ${f.severity}`} />
                <span>
                  <strong>{f.title}</strong>
                  <small>{f.detail}</small>
                </span>
                <Icon name="arrow" size={18} />
              </button>
            ))}
          </div>
          <Button onClick={() => navigate('incidents')} tone="quiet">
            Все отклонения
          </Button>
        </section>
      </div>
      <div className="honesty-strip">
        <Icon name="source" />
        <p>
          OEE требует идеального цикла оборудования. В исходных данных его нет, поэтому показатель
          не рассчитывается.
        </p>
        <button className="text-button" onClick={() => evidence()}>
          Методика и источники
        </button>
      </div>
    </>
  );
}

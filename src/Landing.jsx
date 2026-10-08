import { useRef, useState } from 'react';
import { motion, useScroll, useTransform, useReducedMotion } from 'motion/react';
import { Brand, Icon } from './icons.jsx';
import { Button } from './ui.jsx';

const processSteps = [
  {
    id: 'warehouse',
    title: 'Склад',
    image: '/stage-warehouse.png',
    description:
      'Материалы запускают производственный поток. В наборе Allur нет отдельных измерений склада.'
  },
  {
    id: 'welding',
    title: 'Сварка',
    image: '/stage-welding.png',
    description:
      'Сопоставьте выпуск, загрузку оборудования и причины простоя. Проверьте, изменит ли восстановленное время результат всей линии.'
  },
  {
    id: 'painting',
    title: 'Окраска',
    image: '/stage-painting.png',
    description:
      'Проследите связь между качеством операции и конечным выпуском. Каждое отклонение можно проверить по исходным записям.'
  },
  {
    id: 'assembly',
    title: 'Сборка',
    image: '/stage-assembly.png',
    description:
      'Следите за выпуском сборки и сопоставляйте его с планом. Сценарная модель учитывает ограничения предыдущих участков.'
  },
  {
    id: 'quality',
    title: 'Контроль',
    image: '/stage-quality.png',
    description:
      'Проверяйте качество на каждом измеряемом участке. Брак операций показан отдельно от числа уникальных автомобилей.'
  },
  {
    id: 'finished',
    title: 'Выпуск',
    image: '/stage-finished.png',
    description:
      'Соберите последствия решений в один результат. Расчёт конечного потока отделён от фактических данных производства.'
  }
];

function Story({ onOpen, busy }) {
  const [selected, setSelected] = useState('painting');
  const current = processSteps.find((step) => step.id === selected);
  return (
    <section className="process-story" id="mechanism" aria-labelledby="process-title">
      <header className="process-heading">
        <h2 id="process-title">
          Одна линия.
          <br />
          Общая картина.
        </h2>
        <p>Выберите участок и проследите его роль в производстве.</p>
      </header>
      <div className="process-line" aria-label="Участки производственной линии">
        {processSteps.map((step, index) => (
          <button
            type="button"
            key={step.id}
            className="process-stop"
            onClick={() => setSelected(step.id)}
            aria-pressed={selected === step.id}
          >
            <span className="process-order">0{index + 1}</span>
            <img src={step.image} alt="" width="1024" height="1024" loading="lazy" />
            <span className="process-name">{step.title}</span>
            {index < processSteps.length - 1 && (
              <span className="process-arrow" aria-hidden="true">
                <Icon name="arrow" size={18} />
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="process-explanation">
        <h3>{current.title}</h3>
        <p>{current.description}</p>
        <Button onClick={onOpen} disabled={busy} icon="arrow">
          Открыть двойник
        </Button>
      </div>
      <p className="process-source">
        Иллюстративная схема. Измерения в тестовом наборе доступны для сварки, окраски и сборки.
      </p>
    </section>
  );
}

function Hero({ onOpen, busy, error }) {
  const ref = useRef(null);
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end start'] });
  const y = useTransform(scrollYProgress, [0, 1], [0, 100]);
  const scale = useTransform(scrollYProgress, [0, 1], [1, 1.08]);

  return (
    <section className="hero" id="product" ref={ref}>
      <div className="hero-copy">
        <h1>
          Почувствуйте
          <br />
          ритм завода.
        </h1>
        <p>
          Производство, качество и простои.
          <br />
          Одна картина для точных решений.
        </p>
        <Button tone="primary" onClick={onOpen} disabled={busy} icon="arrow">
          {busy ? 'Открываем…' : 'Открыть двойник'}
        </Button>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
      </div>
      <motion.div className="hero-art" style={reduced ? undefined : { y, scale }}>
        <img
          src="/factory-hero.png"
          alt="Авторская изометрическая иллюстрация автомобильного завода: роботы, кузова и сборочная линия"
          width="1536"
          height="1024"
          fetchPriority="high"
        />
      </motion.div>
    </section>
  );
}

export default function Landing({ onOpen, onLogin, busy, error }) {
  return (
    <div className="landing">
      <a className="skip-link" href="#main">
        К содержанию
      </a>
      <header className="landing-nav">
        <a href="#product" aria-label="QARQYN главная">
          <Brand />
        </a>
        <nav aria-label="Основная навигация">
          <a href="#product">Продукт</a>
          <a href="#mechanism">Как это работает</a>
          <Button onClick={onLogin} icon="lock">
            Войти
          </Button>
        </nav>
      </header>
      <main id="main" tabIndex={-1}>
        <Hero onOpen={onOpen} busy={busy} error={error} />
        <div className="landing-source-note">
          <span>Кейс Allur / Qostanai AI Industry Hackathon 2026</span>
          <span>Демо на тестовых данных организаторов. Иллюстрации созданы с ИИ.</span>
        </div>

        <Story onOpen={onOpen} busy={busy} />
        <section className="principles" id="principles" aria-labelledby="principles-title">
          <h2 id="principles-title">
            Знать, откуда
            <br />
            взялся ответ.
          </h2>
          <div className="principle-text">
            <p>
              Каждое решение оставляет след: источник, условия расчёта и результат. Вы можете
              вернуться к нему и проверить логику.
            </p>
            <dl>
              <div>
                <dt>Источник рядом</dt>
                <dd>Показатель открывается вместе с записями, из которых он рассчитан.</dd>
              </div>
              <div>
                <dt>Допущения открыты</dt>
                <dd>
                  Прогноз сценария показан отдельно от фактического выпуска. Двух дней данных
                  недостаточно для обучения надёжной модели отказов.
                </dd>
              </div>
              <div>
                <dt>Решение за вами</dt>
                <dd>
                  ИИ объясняет и предлагает. Изменения сохраняет инженер; команды в оборудование не
                  отправляются.
                </dd>
              </div>
            </dl>
            <Button tone="primary" onClick={onOpen} disabled={busy} icon="arrow">
              Попробовать на данных Allur
            </Button>
          </div>
        </section>
      </main>
      <footer className="landing-footer">
        <Brand />
        <p>Қарқын / темп, движение вперёд</p>
        <button type="button" className="text-button" onClick={onLogin}>
          Вход для команды
        </button>
      </footer>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, useMotionValueEvent, useReducedMotion, useScroll } from 'motion/react';
import './ScrollVideo.css';

export default function ScrollVideo({ src, poster }) {
  const sectionRef = useRef(null);
  const videoRef = useRef(null);
  const stateRef = useRef({ frame: 0, progress: 0, ready: false, disposed: false });
  const [failed, setFailed] = useState(false);
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ['start start', 'end end']
  });

  const scheduleSeek = useCallback(() => {
    const state = stateRef.current;
    if (state.frame || state.disposed || !state.ready) return;
    state.frame = window.requestAnimationFrame(() => {
      state.frame = 0;
      const video = videoRef.current;
      if (!video || video.seeking || !Number.isFinite(video.duration) || video.duration <= 0)
        return;
      const target = Math.min(Math.max(video.duration - 0.04, 0), state.progress * video.duration);
      if (Math.abs(video.currentTime - target) < 1 / 30) return;
      try {
        video.currentTime = target;
      } catch {
        state.ready = false;
        setFailed(true);
      }
    });
  }, []);

  useMotionValueEvent(scrollYProgress, 'change', (progress) => {
    stateRef.current.progress = Math.max(0, Math.min(1, progress));
    if (!reduced) scheduleSeek();
  });

  useEffect(() => {
    const state = stateRef.current;
    state.disposed = false;
    return () => {
      state.disposed = true;
      if (state.frame) window.cancelAnimationFrame(state.frame);
      state.frame = 0;
    };
  }, []);

  useEffect(() => {
    stateRef.current.ready = false;
    setFailed(false);
  }, [src]);

  useEffect(() => {
    if (!reduced) {
      videoRef.current?.pause();
      scheduleSeek();
    }
  }, [reduced, scheduleSeek]);

  function handleReady() {
    const video = videoRef.current;
    if (!video) return;
    stateRef.current.ready = Number.isFinite(video.duration) && video.duration > 0;
    stateRef.current.progress = Math.max(0, Math.min(1, scrollYProgress.get()));
    if (!reduced) {
      video.pause();
      scheduleSeek();
    }
  }

  return (
    <section
      className={`scroll-video${reduced || failed ? ' scroll-video-static' : ''}`}
      id="assembly"
      ref={sectionRef}
      aria-labelledby="assembly-video-title"
    >
      <div className="scroll-video-sticky">
        <header className="scroll-video-heading">
          <h2 id="assembly-video-title">Каждая деталь влияет на целое.</h2>
          <p>Соберите картину производства.</p>
        </header>
        <div className="scroll-video-media">
          {!failed && (
            <video
              ref={videoRef}
              src={src}
              poster={poster}
              muted
              playsInline
              autoPlay={!reduced}
              controls={Boolean(reduced)}
              preload="metadata"
              onLoadedMetadata={handleReady}
              onCanPlay={handleReady}
              onSeeked={() => {
                if (!reduced) scheduleSeek();
              }}
              onPlay={() => {
                if (!reduced) videoRef.current?.pause();
              }}
              onError={() => {
                stateRef.current.ready = false;
                setFailed(true);
              }}
              aria-label="Созданное с ИИ видео сборки автомобиля"
            />
          )}
          {failed && poster && <img src={poster} alt="Визуализация автомобильного производства" />}
          {failed && (
            <p className="scroll-video-fallback">
              Видео не удалось загрузить. Продолжите знакомство с производственной линией.
            </p>
          )}
        </div>
        <footer className="scroll-video-footer">
          <span>
            {reduced ? 'AI-визуализация сборки автомобиля' : 'Прокручивайте, чтобы увидеть сборку'}
          </span>
          <a href="#mechanism">Перейти к производственной линии</a>
        </footer>
        {!reduced && !failed && (
          <motion.div
            className="scroll-video-progress"
            style={{ scaleX: scrollYProgress }}
            aria-hidden="true"
          />
        )}
      </div>
    </section>
  );
}

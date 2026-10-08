import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion, useMotionValueEvent, useReducedMotion, useScroll } from 'motion/react';
import './ScrollVideo.css';

export default function ScrollVideo({ src, fallbackSrc, poster }) {
  const sectionRef = useRef(null);
  const videoRef = useRef(null);
  const stateRef = useRef({
    frame: 0,
    feedbackTimer: 0,
    progress: 0,
    ready: false,
    disposed: false,
    manual: false,
    failed: false
  });
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [aspectRatio, setAspectRatio] = useState(16 / 9);
  const reduced = useReducedMotion();
  const manualPlayback = Boolean(reduced);
  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ['start start', 'end end']
  });

  const clearFeedback = useCallback(() => {
    const state = stateRef.current;
    if (state.feedbackTimer) window.clearTimeout(state.feedbackTimer);
    state.feedbackTimer = 0;
  }, []);

  const cancelSeek = useCallback(() => {
    const state = stateRef.current;
    if (state.frame) window.cancelAnimationFrame(state.frame);
    state.frame = 0;
  }, []);

  const failVideo = useCallback(() => {
    const state = stateRef.current;
    state.ready = false;
    state.failed = true;
    cancelSeek();
    clearFeedback();
    if (!state.disposed) {
      setFailed(true);
      setLoading(false);
    }
  }, [cancelSeek, clearFeedback]);

  const scheduleSeek = useCallback(() => {
    const state = stateRef.current;
    if (state.frame || state.disposed || state.manual || state.failed || !state.ready) return;
    state.frame = window.requestAnimationFrame(() => {
      state.frame = 0;
      const video = videoRef.current;
      if (
        state.disposed ||
        state.manual ||
        state.failed ||
        !state.ready ||
        !video ||
        video.seeking ||
        !Number.isFinite(video.duration) ||
        video.duration <= 0
      )
        return;
      const target = Math.min(Math.max(video.duration - 0.04, 0), state.progress * video.duration);
      if (Math.abs(video.currentTime - target) < 1 / 30) return;
      try {
        video.currentTime = target;
      } catch {
        failVideo();
      }
    });
  }, [failVideo]);

  const showLoadingIfDelayed = useCallback(() => {
    const state = stateRef.current;
    if (state.feedbackTimer || state.failed || state.disposed) return;
    state.feedbackTimer = window.setTimeout(() => {
      state.feedbackTimer = 0;
      const video = videoRef.current;
      if (!state.disposed && !state.failed && video && (video.seeking || video.readyState < 2)) {
        setLoading(true);
      }
    }, 250);
  }, []);

  useMotionValueEvent(scrollYProgress, 'change', (progress) => {
    stateRef.current.progress = Math.max(0, Math.min(1, progress));
    scheduleSeek();
  });

  useEffect(() => {
    const state = stateRef.current;
    state.disposed = false;
    return () => {
      state.disposed = true;
      cancelSeek();
      clearFeedback();
    };
  }, [cancelSeek, clearFeedback]);

  useLayoutEffect(() => {
    stateRef.current.manual = manualPlayback;
    cancelSeek();
    if (manualPlayback) {
      clearFeedback();
      setLoading(false);
    } else {
      videoRef.current?.pause();
      scheduleSeek();
    }
  }, [manualPlayback, cancelSeek, clearFeedback, scheduleSeek]);

  function handleLoadStart() {
    const state = stateRef.current;
    state.ready = false;
    state.failed = false;
    cancelSeek();
    clearFeedback();
    setFailed(false);
    setLoading(true);
  }

  function handleReady() {
    const video = videoRef.current;
    if (!video || stateRef.current.failed) return;
    const state = stateRef.current;
    state.ready = Number.isFinite(video.duration) && video.duration > 0;
    state.progress = Math.max(0, Math.min(1, scrollYProgress.get()));
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      setAspectRatio(video.videoWidth / video.videoHeight);
    }
    if (video.readyState >= 2 && !video.seeking) {
      clearFeedback();
      setLoading(false);
    }
    if (!state.manual) {
      video.pause();
      scheduleSeek();
    } else if (state.ready) {
      const finalFrame = Math.max(0, video.duration - 0.04);
      if (Math.abs(video.currentTime - finalFrame) > 0.05) video.currentTime = finalFrame;
    }
  }

  function handleSeeked() {
    clearFeedback();
    if ((videoRef.current?.readyState ?? 0) >= 2) setLoading(false);
    scheduleSeek();
  }

  function retryVideo() {
    const video = videoRef.current;
    if (!video) return;
    handleLoadStart();
    video.load();
  }

  return (
    <section
      className={`scroll-video${manualPlayback || failed ? ' scroll-video-static' : ''}`}
      style={{ '--scroll-video-aspect': aspectRatio }}
      id="assembly"
      ref={sectionRef}
      aria-labelledby="assembly-video-title"
    >
      <div className="scroll-video-sticky">
        <header className="scroll-video-heading">
          <h2 id="assembly-video-title">Каждая деталь влияет на целое.</h2>
          <p>Соберите картину производства.</p>
        </header>
        <div className="scroll-video-media" aria-busy={loading && !failed}>
          <video
            key={src}
            ref={videoRef}
            poster={poster}
            hidden={failed}
            muted
            playsInline
            preload="metadata"
            onLoadStart={handleLoadStart}
            onLoadedMetadata={handleReady}
            onLoadedData={handleReady}
            onCanPlay={handleReady}
            onSeeking={showLoadingIfDelayed}
            onSeeked={handleSeeked}
            onWaiting={showLoadingIfDelayed}
            onStalled={showLoadingIfDelayed}
            onPlay={() => {
              if (!stateRef.current.manual) videoRef.current?.pause();
            }}
            onError={failVideo}
            aria-label="Созданное с ИИ видео сборки автомобиля"
          >
            <source src={src} type={src.endsWith('.webm') ? 'video/webm' : 'video/mp4'} />
            {fallbackSrc && <source src={fallbackSrc} type="video/mp4" />}
          </video>
          {loading && !failed && (
            <p className="scroll-video-loading" role="status">
              Подготавливаем видеосцену…
            </p>
          )}
          {failed && poster && <img src={poster} alt="Визуализация автомобильного производства" />}
          {failed && (
            <div className="scroll-video-fallback">
              <p role="status">Видео не удалось загрузить.</p>
              <button type="button" className="text-button" onClick={retryVideo}>
                Повторить загрузку
              </button>
            </div>
          )}
        </div>
        <footer className="scroll-video-footer">
          <span>
            {manualPlayback || failed
              ? 'AI-визуализация сборки автомобиля'
              : 'Прокручивайте, чтобы увидеть сборку'}
          </span>
          <a href="#mechanism">Перейти к производственной линии</a>
        </footer>
        {!manualPlayback && !failed && (
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

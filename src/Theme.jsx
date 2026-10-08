import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';

const ThemeContext = createContext(null);
export function useTheme() {
  return useContext(ThemeContext);
}
function preference(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}
function persist(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Browser storage can be disabled. */
  }
}
export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() =>
    preference('qarqyn-theme', 'dark') === 'light' ? 'light' : 'dark'
  );
  const [motion, setMotion] = useState(() => preference('qarqyn-motion', 'on') !== 'off');
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  const previousTheme = useRef(theme);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useLayoutEffect(() => {
    let transitionTimer;
    if (previousTheme.current !== theme && motion && !reduced) {
      document.documentElement.dataset.themeTransition = 'on';
      transitionTimer = setTimeout(() => {
        delete document.documentElement.dataset.themeTransition;
      }, 1100);
    } else {
      delete document.documentElement.dataset.themeTransition;
    }
    previousTheme.current = theme;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.motion = motion && !reduced ? 'on' : 'off';
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'dark' ? '#000000' : '#f1f0eb');
    persist('qarqyn-theme', theme);
    persist('qarqyn-motion', motion ? 'on' : 'off');
    return () => clearTimeout(transitionTimer);
  }, [theme, motion, reduced]);
  return (
    <ThemeContext.Provider value={{ theme, setTheme, motion, setMotion, reduced }}>
      {theme === 'dark' && <NightSky animated={motion && !reduced} />}
      {children}
    </ThemeContext.Provider>
  );
}

export function ThemeTools() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="theme-tools" role="group" aria-label="Оформление">
      <button
        type="button"
        className="orbit-toggle"
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        aria-pressed={theme === 'dark'}
        aria-label={theme === 'dark' ? 'Включить светлую тему' : 'Включить космическую тему'}
        title={theme === 'dark' ? 'Светлая тема' : 'Космическая тема'}
      >
        <span className="orbit-toggle-track" aria-hidden="true">
          <span className="orbit-clouds orbit-clouds-back" />
          <span className="orbit-clouds" />
          <svg className="orbit-stars" viewBox="0 0 92 38" fill="currentColor">
            <path d="M13 8l1.1 3.1L17 12l-2.9.9L13 16l-.9-3.1L9 12l3.1-.9ZM29 21l.7 2.3L32 24l-2.3.7L29 27l-.7-2.3L26 24l2.3-.7ZM36 7l.6 1.9L39 9.5l-2.4.6L36 12l-.6-1.9L33 9.5l2.4-.6Z" />
            <circle cx="23" cy="8" r=".8" />
            <circle cx="10" cy="26" r=".8" />
            <circle cx="38" cy="30" r=".7" />
            <circle cx="21" cy="30" r=".5" />
          </svg>
          <span className="orbit-disc">
            <span className="orbit-sun">
              <span className="orbit-moon">
                <span className="orbit-crater" />
                <span className="orbit-crater" />
                <span className="orbit-crater" />
              </span>
            </span>
          </span>
        </span>
      </button>
    </div>
  );
}

function NightSky({ animated }) {
  const host = useRef(null);
  useEffect(() => {
    let disposed = false,
      disposeScene = () => {};
    const element = host.current;
    if (navigator.connection?.saveData) return;
    import('three')
      .then((THREE) => {
        if (disposed) return;
        let renderer;
        try {
          renderer = new THREE.WebGLRenderer({
            alpha: true,
            antialias: false,
            powerPreference: 'low-power'
          });
        } catch {
          return;
        }
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 200);
        camera.position.z = 40;
        const geometry = new THREE.BufferGeometry();
        const positions = [],
          colors = [];
        let seed = 41817;
        const random = () => {
          seed = (1664525 * seed + 1013904223) >>> 0;
          return seed / 4294967296;
        };
        const count = window.matchMedia('(max-width: 700px)').matches ? 460 : 1100;
        for (let i = 0; i < count; i++) {
          positions.push((random() - 0.5) * 140, (random() - 0.5) * 100, -random() * 65);
          const brightness = 0.6 + random() * 0.4;
          colors.push(brightness, brightness, brightness);
        }
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        const spriteCanvas = document.createElement('canvas');
        spriteCanvas.width = spriteCanvas.height = 32;
        const ctx = spriteCanvas.getContext('2d');
        if (!ctx) {
          geometry.dispose();
          renderer.dispose();
          return;
        }
        const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
        gradient.addColorStop(0, '#ffffff');
        gradient.addColorStop(0.2, '#ffffff');
        gradient.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 32, 32);
        const texture = new THREE.CanvasTexture(spriteCanvas);
        const material = new THREE.PointsMaterial({
          size: 0.36,
          map: texture,
          transparent: true,
          opacity: 0.92,
          vertexColors: true,
          depthWrite: false
        });
        const points = new THREE.Points(geometry, material);
        scene.add(points);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
        element.appendChild(renderer.domElement);
        element.dataset.rendered = 'true';
        let last = 0,
          elapsed = 0,
          targetX = 0,
          targetY = 0;
        const resize = () => {
          camera.aspect = window.innerWidth / window.innerHeight;
          camera.updateProjectionMatrix();
          renderer.setSize(window.innerWidth, window.innerHeight, false);
          renderer.render(scene, camera);
        };
        const pointer = (event) => {
          targetX = (event.clientX / window.innerWidth - 0.5) * 0.018;
          targetY = (event.clientY / window.innerHeight - 0.5) * 0.012;
        };
        const frame = (time) => {
          if (time - last < 34) return;
          elapsed += Math.min(time - last, 100) / 1000;
          last = time;
          points.rotation.y += (targetX - points.rotation.y) * 0.025;
          points.rotation.x += (targetY - points.rotation.x) * 0.025;
          points.rotation.z = Math.sin(elapsed * 0.035) * 0.012;
          renderer.render(scene, camera);
        };
        const visibility = () => {
          last = performance.now();
          renderer.setAnimationLoop(animated && !document.hidden ? frame : null);
          if (!document.hidden) renderer.render(scene, camera);
        };
        resize();
        visibility();
        window.addEventListener('resize', resize);
        document.addEventListener('visibilitychange', visibility);
        if (animated && window.matchMedia('(pointer: fine)').matches)
          window.addEventListener('pointermove', pointer, { passive: true });
        disposeScene = () => {
          window.removeEventListener('resize', resize);
          window.removeEventListener('pointermove', pointer);
          document.removeEventListener('visibilitychange', visibility);
          renderer.setAnimationLoop(null);
          geometry.dispose();
          material.dispose();
          texture.dispose();
          renderer.dispose();
          renderer.domElement.remove();
          delete element.dataset.rendered;
        };
      })
      .catch(() => {});
    return () => {
      disposed = true;
      disposeScene();
    };
  }, [animated]);
  return (
    <div className="night-sky" ref={host} aria-hidden="true">
      <svg className="night-sky-still" viewBox="0 0 1400 900" preserveAspectRatio="xMidYMid slice">
        {Array.from({ length: 170 }, (_, i) => (
          <circle
            key={i}
            cx={(i * 829.37 + 72) % 1400}
            cy={(i * 317.71 + 90) % 900}
            r={i % 11 === 0 ? 2.2 : i % 3 === 0 ? 1.3 : 0.8}
            opacity={i % 3 === 0 ? 1 : 0.55}
            fill="currentColor"
          />
        ))}
      </svg>
    </div>
  );
}

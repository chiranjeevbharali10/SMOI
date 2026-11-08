import { useEffect, useRef, useState, type ReactNode } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/** True when the visitor asked their system for less motion. Scenes then show still frames. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof matchMedia === 'function' && matchMedia(QUERY).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const m = matchMedia(QUERY);
    const on = () => setReduced(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return reduced;
}

/**
 * Becomes true once the element has scrolled into view, and stays true. Without
 * IntersectionObserver (old browsers, tests) everything counts as in view.
 */
export function useInView<T extends Element>(threshold = 0.25) {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (seen || !ref.current) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setSeen(true);
        io.disconnect();
      }
    }, { threshold });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen, threshold]);
  return [ref, seen] as const;
}

/** A page section that rises in (the design's smoi-rise) the first time it is scrolled to. */
export function Scene({ id, tone = 'cream', label, children }: {
  id: string;
  tone?: 'cream' | 'paper' | 'green' | 'blue' | 'lavender' | 'pink';
  label: string;
  children: ReactNode;
}) {
  const [ref, seen] = useInView<HTMLElement>(0.15);
  return (
    <section id={id} ref={ref} aria-label={label} className={`scene tone-${tone}${seen ? ' in' : ''}`}>
      <div className="scene-inner">{children}</div>
    </section>
  );
}

/** Calls `fn` after `ms`, cancelled if the component goes away or the inputs change. */
export function useTimeout(fn: () => void, ms: number | null, deps: unknown[] = []) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const t = setTimeout(() => latest.current(), ms);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps]);
}

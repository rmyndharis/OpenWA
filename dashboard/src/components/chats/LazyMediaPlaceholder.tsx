import { useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';

interface Props {
  /** Label shown while the media loads (e.g. "📷 Photo"). */
  label: string;
  /** Called once when the placeholder approaches the viewport, to start downloading the media. */
  onVisible: () => void;
}

/**
 * Placeholder for an older media message whose payload isn't loaded yet. When it nears the viewport it
 * fires `onVisible` once to lazily download the media. The IntersectionObserver `rootMargin` doubles as
 * a soft prefetch — it starts the fetch a bit before the bubble is actually on screen.
 */
export default function LazyMediaPlaceholder({ label, onVisible }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const firedRef = useRef(false);
  // Keep the latest onVisible in a ref so the observer can mount once (the prop is a fresh closure each
  // render; without this the observer would tear down and re-create on every parent re-render).
  const onVisibleRef = useRef(onVisible);
  useEffect(() => {
    onVisibleRef.current = onVisible;
  }, [onVisible]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0]?.isIntersecting && !firedRef.current) {
          firedRef.current = true;
          onVisibleRef.current();
          observer.disconnect();
        }
      },
      { rootMargin: '300px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className="message-media-placeholder message-media-placeholder--loading">
      <Loader2 className="animate-spin" size={14} />
      <span>{label}</span>
    </div>
  );
}

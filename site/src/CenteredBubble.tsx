import { useLayoutEffect, useRef, useState } from 'react';
import { BubbleView } from '@desktop/renderer/components/BubbleView';
import type { BubbleLine } from '@desktop/shared/panelActions';

/**
 * The app's speech bubble with its tail in the middle, for a companion standing centred below it.
 * The bubble is measured first so the tail lands exactly on the centre.
 */
export function CenteredBubble({ line, onDismiss }: { line: BubbleLine; onDismiss?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    setWidth((box.current?.firstElementChild as HTMLElement | null)?.offsetWidth ?? null);
  }, [line.text, line.tone]);
  return (
    <div ref={box} className="centered-bubble" role="status" aria-live="polite" style={{ visibility: width === null ? 'hidden' : 'visible' }}>
      <BubbleView key={line.text} tone={line.tone} text={line.text} tailX={width === null ? undefined : width / 2} pop onDismiss={onDismiss} />
    </div>
  );
}

import { useLayoutEffect, useRef, useState } from 'react';
import { BubbleView } from '@desktop/renderer/components/BubbleView';
import type { BubbleLine } from '@desktop/shared/panelActions';

/**
 * The app's speech bubble, placed inside a positioned container so its tail points at `anchorX`
 * (pixels from the container's left edge), kept `margin` px inside both edges. The bubble is
 * measured first, the same way the app's bubble window measures itself before it is placed.
 */
export function PointingBubble({ line, anchorX, containerWidth, bottom, margin = 8 }: {
  line: BubbleLine;
  anchorX: number;
  containerWidth: number;
  /** Distance from the container's bottom to the tip of the tail. */
  bottom: number;
  margin?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    setWidth((box.current?.firstElementChild as HTMLElement | null)?.offsetWidth ?? null);
  }, [line.text, line.tone]);

  const w = width ?? 0;
  const left = Math.max(margin, Math.min(anchorX - w / 2, containerWidth - w - margin));
  const tailX = Math.max(22, Math.min(anchorX - left, w - 22));
  return (
    <div
      ref={box}
      className="pointing-bubble"
      role="status"
      aria-live="polite"
      style={{ left, bottom, visibility: width === null ? 'hidden' : 'visible' }}
    >
      <BubbleView key={line.text} tone={line.tone} text={line.text} tailX={width === null ? undefined : tailX} pop />
    </div>
  );
}

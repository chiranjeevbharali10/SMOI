import type { CSSProperties } from 'react';
import type { BubbleTone } from '../../shared/panelActions';

export interface BubbleViewProps {
  tone: BubbleTone;
  text: string;
  /** The tail's centre from the bubble's left edge; undefined while measuring. */
  tailX?: number;
  tail?: 'down' | 'up';
  /** Play smoi-pop. */
  pop?: boolean;
  leaving?: boolean;
  onDismiss?: () => void;
}

/**
 * One speech bubble: blue nudge, lavender finding or pink time-sensitive (with an x button).
 * The text is plain text, never HTML.
 */
export function BubbleView({ tone, text, tailX, tail = 'down', pop, leaving, onDismiss }: BubbleViewProps) {
  const style = {
    '--tail-x': tailX != null ? `${tailX}px` : undefined,
    transformOrigin: `${tailX ?? 0}px ${tail === 'down' ? '100%' : '0%'}`,
  } as CSSProperties;
  const classes = ['smoi-bubble', `tone-${tone}`, `tail-${tail}`, pop && 'pop', leaving && 'leaving'].filter(Boolean).join(' ');
  return (
    <div className={classes} style={style} data-testid="bubble">
      <span>{text}</span>
      {tone === 'urgent' && (
        <button type="button" className="smoi-bubble-dismiss" aria-label="Dismiss" tabIndex={-1} onClick={onDismiss}>×</button>
      )}
      <div className="smoi-bubble-tail" aria-hidden="true" />
    </div>
  );
}

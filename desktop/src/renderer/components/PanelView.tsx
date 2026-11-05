import { forwardRef, useImperativeHandle, useRef, type KeyboardEvent } from 'react';
import type { PanelConfirm, PanelRowView } from '../../shared/bridge';
import { NOT_AVAILABLE, type PanelRowId } from '../../shared/panelActions';
import { RowIcon } from './icons';

export interface PanelViewProps {
  /** The active companion's name (the panel title). */
  name?: string;
  /** Header colour from the companion's palette; the design's green when absent. */
  accent?: string | null;
  mood: string;
  rows: PanelRowView[];
  /** A voice command to confirm, shown instead of the rows. */
  confirm?: PanelConfirm | null;
  onAnswer?: (yes: boolean) => void;
  /** Play smoi-rise. */
  rise?: boolean;
  /** Repeated to screen readers while the panel has focus. */
  announce?: string | null;
  onChoose: (row: PanelRowId) => void;
  onClose: () => void;
}

export interface PanelHandle {
  focusFirst(): void;
}

/**
 * The menu panel: a green header with SMOI and the mood, then six rows. Keyboard: Up/Down (and
 * Home/End) move between rows, Enter or Space chooses, Esc closes. Unavailable rows stay in the
 * tab order with aria-disabled, so keyboard and screen-reader users hear that they exist and
 * aren't available yet.
 */
export const PanelView = forwardRef<PanelHandle, PanelViewProps>(function PanelView(
  { name = 'SMOI', accent, mood, rows, confirm, onAnswer, rise, announce, onChoose, onClose }, ref,
) {
  const list = useRef<HTMLDivElement>(null);
  const buttons = () => Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);

  useImperativeHandle(ref, () => ({ focusFirst: () => buttons()[0]?.focus() }));

  const onKeyDown = (e: KeyboardEvent) => {
    const all = buttons();
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    const move = (to: number) => {
      e.preventDefault();
      all[(to + all.length) % all.length]?.focus();
    };
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') move(i + 1);
    else if (e.key === 'ArrowUp') move(i < 0 ? all.length - 1 : i - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(all.length - 1);
  };

  return (
    <section className={`smoi-panel${rise ? ' rise' : ''}`} aria-label={`${name} panel`} onKeyDown={onKeyDown} data-testid="panel">
      <div className="smoi-panel-header" style={accent ? { background: accent } : undefined}>
        <h1 className="smoi-panel-title">{name}</h1>
        <div className="smoi-panel-mood">{mood}</div>
      </div>
      {confirm ? (
        <div className="smoi-confirm" ref={list}>
          <p className="smoi-confirm-heard">I heard: “{confirm.heard}”</p>
          <p className="smoi-confirm-heading" id="confirm-heading">{confirm.view.heading}</p>
          {confirm.view.details.length > 0 && (
            <ul className="smoi-confirm-details" aria-labelledby="confirm-heading">
              {confirm.view.details.map((d) => <li key={d}>{d}</li>)}
            </ul>
          )}
          <div className="smoi-confirm-actions">
            {confirm.view.actionable && confirm.view.confirmLabel && (
              <button type="button" className="smoi-row primary" onClick={() => onAnswer?.(true)}>{confirm.view.confirmLabel}</button>
            )}
            <button type="button" className="smoi-row" onClick={() => onAnswer?.(false)}>
              {confirm.view.actionable ? 'Cancel' : 'OK'}
            </button>
          </div>
        </div>
      ) : (
      <div className="smoi-panel-rows" ref={list}>
        {rows.map((row) => (
          <button
            key={row.id}
            type="button"
            className="smoi-row"
            aria-disabled={row.available ? undefined : 'true'}
            onClick={() => {
              if (row.available) onChoose(row.id);
            }}
          >
            <RowIcon id={row.id} />
            {row.available ? row.label : (
              <span className="smoi-row-label">
                <span>{row.label}</span>
                <span className="smoi-row-note">{NOT_AVAILABLE}</span>
              </span>
            )}
          </button>
        ))}
      </div>
      )}
      <div role="status" className="visually-hidden">{announce ?? ''}</div>
    </section>
  );
});

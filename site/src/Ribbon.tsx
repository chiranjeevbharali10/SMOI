import { AVAILABLE_ROWS, effectOf } from '@desktop/shared/panelActions';
import { companions } from './roster';

/** Every companion's sample lines plus the panel's lines: all things the app really says. */
const LINES: string[] = [
  ...companions.flatMap((c) => c.lines.map((l) => `${l}  ·  ${c.name}`)),
  ...(['hello', 'closed', 'dashboard'] as const).map((e) => `${effectOf(e, AVAILABLE_ROWS, {})!.bubble!.text}  ·  SMOI`),
];

/** A tilted ticker of lines, like a sticker strip across the page. Static with reduced motion. */
export function Ribbon({ tone = 'green', reverse = false, offset = 0 }: { tone?: 'green' | 'pink' | 'blue'; reverse?: boolean; offset?: number }) {
  const lines = [...LINES.slice(offset), ...LINES.slice(0, offset)];
  const strip = (hidden: boolean) => (
    <span className="ribbon-strip" aria-hidden={hidden || undefined}>
      {lines.map((l) => <span key={l} className="ribbon-item">{l}<i aria-hidden="true">✦</i></span>)}
    </span>
  );
  return (
    <div className={`ribbon ribbon-${tone}${reverse ? ' reverse' : ''}`} role="marquee" aria-label="Things SMOI and friends say">
      <div className="ribbon-track">{strip(false)}{strip(true)}</div>
    </div>
  );
}

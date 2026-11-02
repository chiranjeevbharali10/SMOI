import type { PanelRowId } from '../../shared/panelActions';

/**
 * The menu panel's 22px icons, copied unchanged from the design's "speech bubble and panel" board
 * (24x24 viewBox, 2px round strokes in the current text colour).
 */
const PATHS: Record<PanelRowId, React.ReactNode> = {
  talk: <path d="M4 5h16v11H9l-5 4z" />,
  tasks: <path d="M4 7l2 2 3-4M4 16l2 2 3-4M13 7h7M13 16h7" />,
  calendar: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M9 3v4M15 3v4" /></>,
  inbox: <><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 8l9 6 9-6" /></>,
  brain: <><circle cx="11" cy="11" r="6" /><path d="M16 16l4 4M9 11h4" /></>,
  dashboard: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </>
  ),
};

export function RowIcon({ id }: { id: PanelRowId }) {
  return (
    <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {PATHS[id]}
    </svg>
  );
}

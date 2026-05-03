import { useSaveStatus } from '../editor/PresenceContext.jsx';

export function SavedIndicator() {
  const { state, lastSaved } = useSaveStatus();
  if (state === 'idle' && !lastSaved) {
    return <span className="saved-indicator">No edits yet</span>;
  }
  if (state === 'saving') {
    return <span className="saved-indicator saving">Saving…</span>;
  }
  return (
    <span className="saved-indicator saved">Saved · {timeAgo(lastSaved)}</span>
  );
}

function timeAgo(ts) {
  if (!ts) return 'just now';
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

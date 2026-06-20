// A muted one-line preview of a neighbouring dialog line — the line spoken just
// before ("prev") or just after ("next") the current one. Shown around the line
// being performed so whoever is voicing it has the surrounding context.

export function DialogContextStrip({ dialog, kind }) {
  if (!dialog) return null;
  const label = kind === 'next' ? 'next' : 'prev';
  const speaker = stripMd(dialog.character || '') || '(no speaker)';
  const body = stripMd(dialog.body || '') || '(empty)';
  return (
    <div className={`dialog-context-strip dialog-context-${label}`}>
      <span className="dialog-context-kind">{label}</span>
      <span className="dialog-context-speaker">{speaker}:</span>{' '}
      <span className="dialog-context-body">{body}</span>
    </div>
  );
}

// Local markdown stripper, matching the per-widget helpers used elsewhere in the
// SPA (DialogItemCollapsed, AudioPickerModal, …). Keep in sync with the common
// cases of src/util/markdown.js#stripMarkdown.
function stripMd(s) {
  return String(s)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

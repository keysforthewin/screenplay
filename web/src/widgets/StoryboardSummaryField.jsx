import { useState } from 'react';
import { apiPostJson } from '../api.js';
import { CollabField } from '../editor/CollabField.jsx';

// Single-line CollabField bound to item:<id>:summary, plus an
// Auto-generate button that asks the server to summarize the current
// text_prompt and write the result into the same fragment via the
// gateway. The CollabField below reflects the new text live via the
// open HocuspocusProvider connection.
export function StoryboardSummaryField({ sbId }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function autoGenerate() {
    setBusy(true);
    setError(null);
    try {
      await apiPostJson(`/storyboard/${sbId}/generate-summary`, {});
    } catch (e) {
      let msg = e.message || '';
      try {
        const parsed = JSON.parse(msg);
        if (parsed?.error) msg = parsed.error;
      } catch {
        // not JSON; leave as-is.
      }
      setError(msg || 'Auto-generate failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="storyboard-summary">
      <div className="storyboard-summary-head">
        <div className="field-label">Summary</div>
        <button
          type="button"
          className="storyboard-summary-autogen"
          disabled={busy}
          onClick={autoGenerate}
          title="Generate a 1-sentence summary from the current prompt"
        >
          {busy ? 'Generating…' : 'Auto-generate'}
        </button>
      </div>
      <CollabField
        field={`item:${sbId}:summary`}
        multiline={false}
        placeholder="One-sentence summary of this shot…"
      />
      {error && <div className="error-banner small">{error}</div>}
    </div>
  );
}

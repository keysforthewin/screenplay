// Project-level settings surfaced on the About page: rename the project, and
// the danger zone that deletes it outright.
//
// Both operations end in a FULL page load (location.assign) rather than a
// router navigation — the same reason project switching does: every Hocuspocus
// socket, EventSource, and poller pointed at the old title/project has to be
// torn down.

import { useState } from 'react';
import { Modal } from './Modal.jsx';
import {
  apiPatchJson,
  apiDelete,
  setCurrentProject,
  clearStoredProject,
  projectHomeUrl,
  appRootUrl,
} from '../api.js';

// Renames the project — the name in the header brand and in the /p/<title>/
// URL. Distinct from the screenplay's cover title, which is a collaborative
// field on the plot doc.
export function ProjectRenameField({ project }) {
  const [title, setTitle] = useState(project.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const trimmed = title.trim();
  const changed = trimmed && trimmed !== project.title;

  async function save(e) {
    e?.preventDefault();
    if (!changed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await apiPatchJson(`/projects/${project.id}`, { title: trimmed });
      setCurrentProject({ id: project.id, title: updated.title });
      location.assign(projectHomeUrl(updated.title));
      // No state reset — location.assign tears this page down.
    } catch (err) {
      // 400 invalid / 409 duplicate surface here: api.js check() extracts the
      // JSON {error} body into err.message.
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <form className="field-block" onSubmit={save}>
      <label className="field-label" htmlFor="project-title-input">Project title</label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          id="project-title-input"
          type="text"
          value={title}
          maxLength={120}
          disabled={busy}
          onChange={(e) => setTitle(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button type="submit" className="primary" disabled={!changed || busy}>
          {busy ? 'Renaming…' : 'Rename'}
        </button>
      </div>
      <p style={{ color: 'var(--fg-muted)', fontSize: 12, margin: '6px 0 0' }}>
        The project's name in the header and in this page's URL. Renaming changes
        the URL, so any links you've shared to this project will need updating.
      </p>
      {error && <div className="error-banner" style={{ marginTop: 8 }}>{error}</div>}
    </form>
  );
}

// Irreversible delete of the whole project. The confirm button stays disabled
// until the exact project title is typed — the only backup is a whole-database
// mongodump, so a stray double-click must not be enough.
export function ProjectDangerZone({ project }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const confirmed = typed.trim() === project.title;

  function openDialog() {
    setTyped('');
    setError(null);
    setOpen(true);
  }

  async function destroy() {
    if (!confirmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiDelete(`/projects/${project.id}`);
      clearStoredProject();
      location.assign(appRootUrl());
    } catch (err) {
      // 409 "cannot delete the only project" surfaces here.
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <section className="danger-zone">
      <h2>Danger zone</h2>
      <p>
        Deleting <strong>{project.title}</strong> permanently removes its beats,
        characters, storyboards, dialogue, director's notes, chat history, every
        image and attachment, and all of its editor history. Other projects are
        untouched. This cannot be undone.
      </p>
      <button type="button" className="danger" onClick={openDialog}>
        Delete this project
      </button>

      <Modal
        open={open}
        title={`Delete "${project.title}"?`}
        onClose={() => { if (!busy) setOpen(false); }}
        footer={(
          <>
            <button type="button" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="danger" onClick={destroy} disabled={!confirmed || busy}>
              {busy ? 'Deleting…' : 'Delete project'}
            </button>
          </>
        )}
      >
        {error && <div className="error-banner">{error}</div>}
        <p>
          This deletes everything in the project and cannot be undone. Type the
          project title to confirm:
        </p>
        <p><code>{project.title}</code></p>
        <input
          type="text"
          value={typed}
          disabled={busy}
          placeholder={project.title}
          onChange={(e) => setTyped(e.target.value)}
          style={{ width: '100%' }}
        />
      </Modal>
    </section>
  );
}

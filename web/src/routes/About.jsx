import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet } from '../api.js';
import { CollabSurface } from '../editor/CollabSurface.jsx';
import { CollabField } from '../editor/CollabField.jsx';
import { DownloadAllButton } from '../widgets/DownloadAllButton.jsx';
import { NotesPanel } from '../widgets/NotesPanel.jsx';
import { useProject } from '../project/ProjectContext.jsx';

const TABS = [
  { id: 'about', label: 'About' },
  { id: 'dialogue', label: 'Dialogue' },
  { id: 'notes', label: "Director's Notes" },
];

// Project-level "About" page, organised into three tabs:
//   About            → project name + synopsis
//   Dialogue         → global dialogue style & influences
//   Director's Notes → the project's director's notes (moved here off the TOC)
// About/Dialogue edit the singleton `plot` y-doc room; Director's Notes lives in
// its own `notes` room via <NotesPanel>. The header offers a full-screenplay PDF.
export function About({ session }) {
  const navigate = useNavigate();
  const { id: projectId } = useProject();
  const [activeTab, setActiveTab] = useState('about');
  const [notesData, setNotesData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiGet('/notes');
        if (!cancelled) setNotesData(r);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function refetchNotes() {
    try {
      const r = await apiGet('/notes');
      setNotesData(r);
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <main className="app">
      <p>
        <a href="#" onClick={(e) => { e.preventDefault(); navigate('/'); }}>← Back to TOC</a>
      </p>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
        <h1 style={{ marginTop: 0 }}>About this project</h1>
        <DownloadAllButton
          path="/export/pdf"
          filename="screenplay.pdf"
          label="Download Screenplay"
          busyLabel="Preparing PDF…"
          title="Download the full screenplay as a PDF (cover, director's notes, characters, plot, library)"
        />
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="tab-nav" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={activeTab === t.id}
            className={`tab-button${activeTab === t.id ? ' is-active' : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <CollabSurface room={`plot:${projectId}`} session={session}>
        <div className="tab-panel" hidden={activeTab !== 'about'}>
          <CollabField label="Project name" field="title" />
          <div style={{ marginTop: 20 }}>
            <CollabField
              label="Synopsis"
              field="synopsis"
              multiline
              placeholder="The logline and overview of the whole project."
            />
          </div>
        </div>

        <div className="tab-panel" hidden={activeTab !== 'dialogue'}>
          <CollabField
            label="Global dialogue style & influences"
            field="dialogue_style"
            multiline
            placeholder="Genre, era, comparable films, do/don'ts. Steers every Generate, Regenerate, and Critique across the whole script. Add film samples with the agent."
          />
        </div>
      </CollabSurface>

      <div className="tab-panel" hidden={activeTab !== 'notes'}>
        {notesData ? (
          <NotesPanel
            notes={notesData.notes || []}
            session={session}
            onChange={refetchNotes}
          />
        ) : (
          <p style={{ color: 'var(--fg-muted)' }}>Loading notes…</p>
        )}
      </div>
    </main>
  );
}

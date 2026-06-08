import { useNavigate } from 'react-router-dom';
import { CollabSurface } from '../editor/CollabSurface.jsx';
import { CollabField } from '../editor/CollabField.jsx';

// Project-level "About" page: the project name, synopsis, and GLOBAL dialogue
// style, all edited collaboratively through the singleton `plot` y-doc room.
// (Per-beat dialogue notes live on each /dialog/:order page instead.)
export function About({ session }) {
  const navigate = useNavigate();

  return (
    <main className="app">
      <p>
        <a href="#" onClick={(e) => { e.preventDefault(); navigate('/'); }}>← Back to TOC</a>
      </p>
      <h1 style={{ marginTop: 0 }}>About this project</h1>
      <p style={{ color: 'var(--fg-muted)', marginTop: 0 }}>
        Project name, synopsis, and the global dialogue style. Changes save and
        sync automatically.
      </p>

      <CollabSurface room="plot" session={session}>
        <CollabField label="Project name" field="title" />

        <div style={{ marginTop: 20 }}>
          <CollabField
            label="Synopsis"
            field="synopsis"
            multiline
            placeholder="The logline and overview of the whole project."
          />
        </div>

        <div style={{ marginTop: 20 }}>
          <CollabField
            label="Global dialogue style & influences"
            field="dialogue_style"
            multiline
            placeholder="Genre, era, comparable films, do/don'ts. Steers every Generate, Regenerate, and Critique across the whole script. Add film samples with the agent."
          />
        </div>
      </CollabSurface>
    </main>
  );
}

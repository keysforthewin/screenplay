// ProjectContext
//
// Resolves the /p/:projectTitle URL segment to { id, title } via
// GET /api/projects (title match is case-insensitive, mirroring the
// /character/Steve human-identifier convention), then:
//   - publishes it to the module store in api.js (authHeaders →
//     X-Project-Id, apiSseUrl → &project_id=) BEFORE any child renders, so
//     every child fetch is project-scoped;
//   - persists it to localStorage 'screenplay_project_v1' as this browser's
//     last-used project (read back by RedirectToProject);
//   - sets document.title to the project title.
// Unknown titles render a "project not found" screen instead of children.
// Modeled on editor/PresenceContext.jsx.

import { createContext, useContext, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiGet, setCurrentProject, projectHomeUrl } from '../api.js';

const ProjectContext = createContext(null);

export function useProject() {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProject must be inside <ProjectProvider>');
  return ctx; // { id, title }
}

export function ProjectProvider({ children }) {
  const { projectTitle } = useParams();
  const [state, setState] = useState({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    (async () => {
      let projects;
      try {
        const data = await apiGet('/projects');
        projects = data?.projects || [];
      } catch (e) {
        if (!cancelled) setState({ status: 'error', message: e.message });
        return;
      }
      if (cancelled) return;
      const wanted = String(projectTitle || '').trim().toLowerCase();
      const match = projects.find(
        (p) => String(p.title).trim().toLowerCase() === wanted,
      );
      if (!match) {
        setState({ status: 'not_found', projects });
        return;
      }
      const project = { id: String(match.id), title: String(match.title) };
      setCurrentProject(project);
      document.title = project.title;
      setState({ status: 'ready', project });
    })();
    return () => { cancelled = true; };
  }, [projectTitle]);

  if (state.status === 'loading') {
    return <div className="app"><p style={{ color: 'var(--fg-muted)' }}>Loading project…</p></div>;
  }
  if (state.status === 'error') {
    return <div className="app"><div className="error-banner">Could not load projects: {state.message}</div></div>;
  }
  if (state.status === 'not_found') {
    return <ProjectNotFound title={projectTitle} projects={state.projects} />;
  }
  return (
    <ProjectContext.Provider value={state.project}>
      {children}
    </ProjectContext.Provider>
  );
}

function ProjectNotFound({ title, projects }) {
  return (
    <main className="app">
      <h1>Project not found</h1>
      <p style={{ color: 'var(--fg-muted)' }}>
        No project is titled "{title}".
      </p>
      {projects.length > 0 && (
        <>
          <p>Available projects:</p>
          <ul>
            {projects.map((p) => (
              <li key={p.id}>
                <a href={projectHomeUrl(p.title)}>{p.title}</a>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

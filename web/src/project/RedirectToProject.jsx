// RedirectToProject
//
// Catch-all target for every path that is NOT under /p/:projectTitle/* —
// both legacy shared URLs (/beat/2, /character/Steve, bare /) and the
// app's own absolute internal links (navigate('/'), <Link to="/about">),
// which intentionally still use legacy paths. Re-enters the project tree,
// preserving the path, by this priority:
//   1. getCurrentProject() — per-TAB module store, set by ProjectProvider.
//      Keeps in-app clicks inside their own project even when another tab
//      viewed a different project more recently (two-tab isolation).
//   2. loadStoredProject() — this browser's last-used project (localStorage).
//   3. First project from GET /api/projects (the backend lazily creates a
//      default project, so the list is never empty in practice).
// Uses react-router navigate (no reload): location.pathname from
// useLocation() is already basename-relative, and navigate() re-applies
// the basename.

import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { apiGet, getCurrentProject, loadStoredProject } from '../api.js';

export function RedirectToProject() {
  const location = useLocation();
  const navigate = useNavigate();
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let target = getCurrentProject() || loadStoredProject();
      if (!target) {
        try {
          const data = await apiGet('/projects');
          const first = data?.projects?.[0];
          target = first ? { id: String(first.id), title: String(first.title) } : null;
        } catch (e) {
          if (!cancelled) setError(e.message);
          return;
        }
      }
      if (cancelled) return;
      if (!target) {
        setError('No projects exist yet.');
        return;
      }
      const suffix = `${location.pathname}${location.search}${location.hash}`;
      navigate(`/p/${encodeURIComponent(target.title)}${suffix}`, { replace: true });
    })();
    return () => { cancelled = true; };
    // Run once for the location we mounted with; a successful run navigates away.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return <div className="app"><div className="error-banner">{error}</div></div>;
  }
  return <div className="app"><p style={{ color: 'var(--fg-muted)' }}>Loading…</p></div>;
}

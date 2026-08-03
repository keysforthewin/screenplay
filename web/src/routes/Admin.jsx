import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPutJson } from '../api.js';

// Admin page: every user who has ever been approved, with checkboxes for
// which projects they can access. Admin-only — the route in App.jsx redirects
// everyone else away, and the /api/admin endpoints 403 non-admins regardless.
// Saves use set semantics: the full checkbox state replaces the user's grants.
export function Admin({ session }) {
  const navigate = useNavigate();
  const [users, setUsers] = useState(null); // null = loading
  const [projects, setProjects] = useState([]);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(null); // Set of project ids for the selected user
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [usersRes, projectsRes] = await Promise.all([
          apiGet('/admin/users'),
          apiGet('/projects'),
        ]);
        if (cancelled) return;
        setUsers(usersRes.users || []);
        setProjects(projectsRes.projects || []);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const selected = users?.find((u) => u.id === selectedId) || null;

  function select(user) {
    setSelectedId(user.id);
    setDraft(new Set(user.project_ids));
    setSaved(false);
    setError(null);
  }

  function toggle(projectId) {
    setSaved(false);
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  async function save() {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await apiPutJson(`/admin/users/${selected.id}/projects`, {
        project_ids: Array.from(draft),
      });
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      setDraft(new Set(updated.project_ids));
      setSaved(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const isAdminUser = (u) =>
    session?.username && u.name.toLowerCase() === session.username.toLowerCase();

  return (
    <main className="app">
      <p>
        <a href="#" onClick={(e) => { e.preventDefault(); navigate('/'); }}>← Back to TOC</a>
      </p>
      <h1 style={{ marginTop: 0 }}>Admin — project access</h1>
      <p style={{ color: 'var(--fg-muted)' }}>
        Pick a user, check the projects they may see and edit, then save. Users
        with no checked projects can log in but see nothing.
      </p>

      {error && <div className="error-banner">{error}</div>}

      {!users && !error && <p style={{ color: 'var(--fg-muted)' }}>Loading users…</p>}

      {users && users.length === 0 && (
        <p style={{ color: 'var(--fg-muted)' }}>
          No users yet — accounts appear here after their first approved login.
        </p>
      )}

      {users && users.length > 0 && (
        <div style={{ display: 'flex', gap: 32, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 220 }}>
            {users.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  onClick={() => select(u)}
                  style={{ width: '100%', textAlign: 'left' }}
                  className={u.id === selectedId ? 'primary' : undefined}
                  title={`Manage project access for ${u.name}`}
                >
                  {u.name}
                  <span style={{ color: u.id === selectedId ? 'inherit' : 'var(--fg-muted)', marginLeft: 8, fontSize: 12 }}>
                    {isAdminUser(u)
                      ? 'admin'
                      : `${u.project_ids.length} project${u.project_ids.length === 1 ? '' : 's'}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {selected && (
            <div style={{ flex: 1, minWidth: 260 }}>
              <h2 style={{ marginTop: 0 }}>{selected.name}</h2>
              {isAdminUser(selected) ? (
                <p style={{ color: 'var(--fg-muted)' }}>
                  That's you — the admin always has access to every project.
                </p>
              ) : (
                <>
                  {projects.length === 0 && (
                    <p style={{ color: 'var(--fg-muted)' }}>No projects exist yet.</p>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {projects.map((p) => (
                      <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={draft?.has(p.id) || false}
                          onChange={() => toggle(p.id)}
                        />
                        {p.title}
                      </label>
                    ))}
                  </div>
                  <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
                    <button type="button" className="primary" onClick={save} disabled={busy}>
                      {busy ? 'Saving…' : 'Save access'}
                    </button>
                    {saved && <span style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Saved.</span>}
                  </div>
                  {selected.last_granted_by && (
                    <p style={{ color: 'var(--fg-muted)', fontSize: 12, marginTop: 12 }}>
                      Last changed by {selected.last_granted_by}
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </main>
  );
}

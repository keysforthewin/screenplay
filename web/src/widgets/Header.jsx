import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useConnectedUsers } from '../editor/PresenceContext.jsx';
import { useProject } from '../project/ProjectContext.jsx';
import { SavedIndicator } from './SavedIndicator.jsx';
import { ProjectManagerDialog } from './ProjectManagerDialog.jsx';

function colorForUser(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 70% 55%)`;
}

function Dot({ user }) {
  const initial = (user?.name || '?').slice(0, 1).toUpperCase();
  const isBot = !!user?.isBot;
  const bg = user?.color || colorForUser(user?.name || '');
  return (
    <span
      className="presence-dot"
      title={user?.name || 'unknown'}
      style={{ background: bg, boxShadow: isBot ? '0 0 0 2px rgba(255,255,255,0.2)' : 'none' }}
    >
      {isBot ? '🤖' : initial}
    </span>
  );
}

export function Header({ session, onLogout }) {
  const users = useConnectedUsers();
  const project = useProject();
  const [managerOpen, setManagerOpen] = useState(false);
  const seen = new Map();
  for (const u of users) {
    const key = u?.name || Math.random();
    if (!seen.has(key)) seen.set(key, u);
  }
  const list = Array.from(seen.values());
  const brand = project.title;
  return (
    <header className="app-header">
      <button
        type="button"
        className="brand"
        title={`${brand} — switch or create projects`}
        onClick={() => setManagerOpen(true)}
      >
        {brand}
      </button>
      <div className="meta">
        <Link to="/about" title="Project name, synopsis & global dialogue style">About</Link>
        <SavedIndicator />
        <div className="presence-dots">{list.map((u, i) => <Dot key={i} user={u} />)}</div>
        <span>signed in as <strong>{session.username}</strong></span>
        <button onClick={onLogout} title="Clear local session">Logout</button>
      </div>
      <ProjectManagerDialog
        open={managerOpen}
        onClose={() => setManagerOpen(false)}
        currentProjectId={project.id}
      />
    </header>
  );
}

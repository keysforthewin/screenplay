import { useEffect, useState } from 'react';
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

// On small screens (≤900px, .meta hidden via CSS) everything but the brand
// and the ✨ chat toggle collapses into the hamburger menu; on desktop the
// burger is hidden and .meta renders inline as before.
export function Header({ session, onLogout, chatOpen, onToggleChat }) {
  const users = useConnectedUsers();
  const project = useProject();
  const [managerOpen, setManagerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const seen = new Map();
  for (const u of users) {
    const key = u?.name || Math.random();
    if (!seen.has(key)) seen.set(key, u);
  }
  const list = Array.from(seen.values());
  const brand = project.title;
  const closeMenu = () => setMenuOpen(false);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const navLinks = (
    <>
      {session?.is_admin && (
        <Link to="/admin" onClick={closeMenu} title="Manage user project access">Admin</Link>
      )}
      <Link to="/about" onClick={closeMenu} title="Project name, synopsis & global dialogue style">About</Link>
      <Link to="/" onClick={closeMenu} title="Table of contents — all beats in this project">TOC</Link>
      <Link to="/playground" onClick={closeMenu} title="Try any fal.ai model with your own reference media">Playground</Link>
    </>
  );

  return (
    <header className="app-header">
      <button
        type="button"
        className="brand"
        aria-haspopup="dialog"
        title={`${brand} — switch or create projects`}
        onClick={() => setManagerOpen(true)}
      >
        {brand}
      </button>
      <div className="meta">
        {navLinks}
        <SavedIndicator />
        <div className="presence-dots">{list.map((u, i) => <Dot key={i} user={u} />)}</div>
        <span>signed in as <strong>{session.username}</strong></span>
        <button onClick={onLogout} title="Clear local session">Logout</button>
      </div>
      <div className="header-actions">
        <button
          type="button"
          className={'nav-burger' + (menuOpen ? ' is-active' : '')}
          aria-expanded={menuOpen}
          aria-controls="mobile-menu"
          aria-label="Menu"
          onClick={() => setMenuOpen((o) => !o)}
        >
          ☰
        </button>
        <button
          type="button"
          className={'chat-toggle' + (chatOpen ? ' is-active' : '')}
          aria-pressed={chatOpen}
          aria-label="Toggle AI chat panel"
          title={chatOpen ? 'Close AI chat panel' : 'Chat with the AI agent about this project'}
          onClick={onToggleChat}
        >
          ✨
        </button>
      </div>
      {menuOpen && (
        <>
          <div className="mobile-menu-backdrop" onClick={closeMenu} />
          <nav id="mobile-menu" className="mobile-menu">
            {navLinks}
            <div className="mobile-menu-row">
              <SavedIndicator />
              <div className="presence-dots">{list.map((u, i) => <Dot key={i} user={u} />)}</div>
            </div>
            <div className="mobile-menu-row">
              <span>signed in as <strong>{session.username}</strong></span>
              <button onClick={() => { closeMenu(); onLogout(); }} title="Clear local session">Logout</button>
            </div>
          </nav>
        </>
      )}
      <ProjectManagerDialog
        open={managerOpen}
        onClose={() => setManagerOpen(false)}
        currentProjectId={project.id}
      />
    </header>
  );
}

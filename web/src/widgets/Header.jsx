import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet } from '../api.js';
import { useConnectedUsers } from '../editor/PresenceContext.jsx';
import { SavedIndicator } from './SavedIndicator.jsx';

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
  const [title, setTitle] = useState('');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await apiGet('/info');
        if (!cancelled) setTitle(info?.screenplay_title || '');
      } catch {
        // Header just falls back to "Screenplay" if /info fails.
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const seen = new Map();
  for (const u of users) {
    const key = u?.name || Math.random();
    if (!seen.has(key)) seen.set(key, u);
  }
  const list = Array.from(seen.values());
  const brand = title.trim() || 'Screenplay';
  return (
    <header className="app-header">
      <Link to="/" className="brand" title={brand}>{brand}</Link>
      <div className="meta">
        <SavedIndicator />
        <div className="presence-dots">{list.map((u, i) => <Dot key={i} user={u} />)}</div>
        <span>signed in as <strong>{session.username}</strong></span>
        <button onClick={onLogout} title="Clear local session">Logout</button>
      </div>
    </header>
  );
}

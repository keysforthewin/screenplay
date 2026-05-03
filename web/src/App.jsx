import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Login } from './routes/Login.jsx';
import { Toc } from './routes/Toc.jsx';
import { Beat } from './routes/Beat.jsx';
import { Character } from './routes/Character.jsx';
import { Notes } from './routes/Notes.jsx';
import { Library } from './routes/Library.jsx';
import { Header } from './widgets/Header.jsx';
import { loadSession, validateSession, clearSession } from './auth/session.js';

export function App() {
  const [session, setSession] = useState(undefined); // undefined = checking, null = none, object = active

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = loadSession();
      if (!stored) {
        if (!cancelled) setSession(null);
        return;
      }
      const ok = await validateSession(stored.session_id);
      if (cancelled) return;
      if (ok?.valid) {
        setSession({ session_id: stored.session_id, username: ok.username });
      } else {
        clearSession();
        setSession(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (session === undefined) {
    return <div className="app"><p style={{ color: 'var(--fg-muted)' }}>Loading…</p></div>;
  }

  if (!session) {
    return (
      <Routes>
        <Route
          path="*"
          element={<Login onAuthed={(s) => setSession(s)} />}
        />
      </Routes>
    );
  }

  return (
    <>
      <Header session={session} onLogout={() => { clearSession(); setSession(null); }} />
      <Routes>
        <Route path="/" element={<Toc session={session} />} />
        <Route path="/beat/:order" element={<Beat session={session} />} />
        <Route path="/character/:name" element={<Character session={session} />} />
        <Route path="/notes" element={<Notes session={session} />} />
        <Route path="/library" element={<Library session={session} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}

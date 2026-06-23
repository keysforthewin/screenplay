import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Login } from './routes/Login.jsx';
import { Toc } from './routes/Toc.jsx';
import { Beat } from './routes/Beat.jsx';
import { Character } from './routes/Character.jsx';
import { Library } from './routes/Library.jsx';
import { StoryboardIndex } from './routes/StoryboardIndex.jsx';
import { StoryboardBeat } from './routes/StoryboardBeat.jsx';
import { DialogIndex } from './routes/DialogIndex.jsx';
import { DialogBeat } from './routes/DialogBeat.jsx';
import { About } from './routes/About.jsx';
import { ChatWindow } from './routes/ChatWindow.jsx';
import { Header } from './widgets/Header.jsx';
import { ProjectProvider } from './project/ProjectContext.jsx';
import { RedirectToProject } from './project/RedirectToProject.jsx';
import { loadSession, validateSession, clearSession } from './auth/session.js';

// Everything project-scoped lives under /p/:projectTitle/*. ProjectProvider
// resolves the title (and blocks children until the api.js store is set);
// the descendant <Routes> match against the splat remainder, so the
// existing route paths are unchanged. The Header moves inside the provider
// because it shows the project title (Task 17).
function ProjectShell({ session, onLogout }) {
  return (
    <ProjectProvider>
      <Header session={session} onLogout={onLogout} />
      <Routes>
        <Route path="/" element={<Toc session={session} />} />
        <Route path="/beat/:order" element={<Beat session={session} section="writing" />} />
        <Route path="/artwork/:order" element={<Beat session={session} section="artwork" />} />
        <Route path="/character/:name" element={<Character session={session} />} />
        <Route path="/library" element={<Library session={session} />} />
        <Route path="/storyboard" element={<StoryboardIndex session={session} />} />
        <Route path="/storyboard/:order" element={<StoryboardBeat session={session} />} />
        <Route path="/dialog" element={<DialogIndex session={session} />} />
        <Route path="/dialog/:order" element={<DialogBeat session={session} />} />
        <Route path="/about" element={<About session={session} />} />
        {/* Unknown subpath: bounce via the app-root catch-all
            (RedirectToProject re-enters this project from the per-tab store). */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ProjectProvider>
  );
}

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
    <Routes>
      <Route
        path="/p/:projectTitle/chat"
        element={
          <ProjectProvider>
            <ChatWindow />
          </ProjectProvider>
        }
      />
      <Route
        path="/p/:projectTitle/*"
        element={
          <ProjectShell
            session={session}
            onLogout={() => { clearSession(); setSession(null); }}
          />
        }
      />
      <Route path="*" element={<RedirectToProject />} />
    </Routes>
  );
}

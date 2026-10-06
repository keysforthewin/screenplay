import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useParams } from 'react-router-dom';
import { Login } from './routes/Login.jsx';
import { Toc } from './routes/Toc.jsx';
import { Beat } from './routes/Beat.jsx';
import { Character } from './routes/Character.jsx';
import { Set } from './routes/Set.jsx';
import { Library } from './routes/Library.jsx';
import { DialogIndex } from './routes/DialogIndex.jsx';
import { ScenesIndex } from './routes/ScenesIndex.jsx';
import { About } from './routes/About.jsx';
import { Playground } from './routes/Playground.jsx';
import { Header } from './widgets/Header.jsx';
import { ChatSidePanel } from './widgets/ChatSidePanel.jsx';
import { loadChatOpen, saveChatOpen } from './widgets/chatPanelState.js';
import { ProjectProvider } from './project/ProjectContext.jsx';
import { RedirectToProject } from './project/RedirectToProject.jsx';
import { loadSession, saveSession, validateSession, clearSession } from './auth/session.js';
import { Admin } from './routes/Admin.jsx';
import { TtsMiniPlayer } from './widgets/TtsMiniPlayer.jsx';
import { stopPlayback } from './tts/nowPlaying.js';

// Everything project-scoped lives under /p/:projectTitle/*. ProjectProvider
// resolves the title (and blocks children until the api.js store is set);
// the descendant <Routes> match against the splat remainder, so the
// existing route paths are unchanged. The Header moves inside the provider
// because it shows the project title (Task 17).
// Old bookmarks point at the popup-era /p/:title/chat route. Flip the
// persisted flag and bounce to the project root — the redirect remounts
// ProjectShell, whose useState(loadChatOpen) initializer opens the panel.
function LegacyChatRedirect() {
  useEffect(() => {
    saveChatOpen(true);
  }, []);
  return <Navigate to="/" replace />;
}

// Beat artwork is retired — sets own artwork now. Old /artwork/:order
// bookmarks bounce to the beat's writing page. `to` has no leading /p/ prefix
// so it resolves relative to this nested <Routes>, same as the other routes
// here — preserving the project prefix without knowing the project title.
function ArtworkRedirect() {
  const { order } = useParams();
  return <Navigate to={`/beat/${order}`} replace />;
}

// The Storyboard and Prompts tabs were retired in favour of Scenes; old links
// land there.
function ScenesRedirect() {
  const { order } = useParams();
  return <Navigate to={order ? `/scenes/${order}` : '/scenes'} replace />;
}

function ProjectShell({ session, onLogout }) {
  const [chatOpen, setChatOpen] = useState(() => loadChatOpen());
  // Mount the chat on first open, then keep it mounted (hidden via CSS) so an
  // in-flight SSE run survives toggling and history isn't refetched.
  const [chatMounted, setChatMounted] = useState(chatOpen);
  useEffect(() => {
    saveChatOpen(chatOpen);
    if (chatOpen) setChatMounted(true);
  }, [chatOpen]);
  return (
    <ProjectProvider>
      <Header
        session={session}
        onLogout={onLogout}
        chatOpen={chatOpen}
        onToggleChat={() => setChatOpen((o) => !o)}
      />
      <div className={'chat-shell' + (chatOpen ? ' chat-open' : '')}>
        <Routes>
          <Route path="/" element={<Toc session={session} />} />
          {/* One beat page behind three paths: <Beat> stays mounted while its
              tabs move between them (see routes/Beat.jsx). */}
          <Route path="/beat/:order" element={<Beat session={session} />} />
          <Route path="/artwork/:order" element={<ArtworkRedirect />} />
          <Route path="/character/:name" element={<Character session={session} />} />
          <Route path="/set/:name" element={<Set session={session} />} />
          <Route path="/library" element={<Library session={session} />} />
          <Route path="/dialog" element={<DialogIndex session={session} />} />
          <Route path="/dialog/:order" element={<Beat session={session} />} />
          <Route path="/storyboard" element={<ScenesRedirect />} />
          <Route path="/storyboard/:order" element={<ScenesRedirect />} />
          <Route path="/prompts" element={<ScenesRedirect />} />
          <Route path="/prompts/:order" element={<ScenesRedirect />} />
          <Route path="/scenes" element={<ScenesIndex session={session} />} />
          <Route path="/scenes/:order" element={<Beat session={session} />} />
          <Route path="/about" element={<About session={session} />} />
          <Route
            path="/admin"
            element={session?.is_admin ? <Admin session={session} /> : <Navigate to="/" replace />}
          />
          <Route path="/playground" element={<Playground />} />
          <Route path="/chat" element={<LegacyChatRedirect />} />
          {/* Unknown subpath: bounce via the app-root catch-all
              (RedirectToProject re-enters this project from the per-tab store). */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
      {chatMounted && (
        <ChatSidePanel open={chatOpen} onClose={() => setChatOpen(false)} />
      )}
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
        const fresh = {
          session_id: stored.session_id,
          username: ok.username,
          is_admin: !!ok.is_admin,
          permissions_enabled: ok.permissions_enabled !== false,
        };
        // Re-save: refreshes legacy localStorage entries that predate is_admin
        // and keeps the flag current if ADMIN_USERNAME changed server-side.
        saveSession(fresh);
        setSession(fresh);
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

  // The read-aloud player sits beside the routes, not inside them, so it (and
  // the playback it controls) survives every navigation.
  return (
    <>
    <TtsMiniPlayer />
    <Routes>
      <Route
        path="/p/:projectTitle/*"
        element={
          <ProjectShell
            session={session}
            onLogout={() => { stopPlayback(); clearSession(); setSession(null); }}
          />
        }
      />
      <Route path="*" element={<RedirectToProject />} />
    </Routes>
    </>
  );
}

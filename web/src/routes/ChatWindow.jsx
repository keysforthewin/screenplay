// Route page for the AI chat popup (/p/:projectTitle/chat). Renders the chat
// panel full-window with no app Header — this document lives in its own browser
// window beside the editor. Project + auth are resolved by the wrappers in
// App.jsx (ProjectProvider + the top-level session gate).
import { ChatPanel } from '../widgets/ChatPanel.jsx';

export function ChatWindow() {
  return <ChatPanel />;
}

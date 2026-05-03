import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.jsx';
import { PresenceProvider } from './editor/PresenceContext.jsx';
import './styles.css';

// Vite injects BASE_URL from vite.config.js's `base` (always ends with '/').
// React Router wants the basename without the trailing slash.
const basename = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');

const root = createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <PresenceProvider>
      <BrowserRouter basename={basename}>
        <App />
      </BrowserRouter>
    </PresenceProvider>
  </React.StrictMode>,
);

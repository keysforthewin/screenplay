import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.jsx';
import { PresenceProvider } from './editor/PresenceContext.jsx';
import './styles.css';

const root = createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <PresenceProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </PresenceProvider>
  </React.StrictMode>,
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';

// Players cannot undo / redo / cut / print during the game (Ctrl or Cmd + Z, Y, X, P).
const BLOCKED_SHORTCUTS = new Set(['z', 'y', 'x', 'p']);
window.addEventListener(
  'keydown',
  (e) => {
    if ((e.ctrlKey || e.metaKey) && BLOCKED_SHORTCUTS.has(String(e.key).toLowerCase())) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true,
);
// Undo / redo can also arrive through the browser's Edit menu or the context menu.
window.addEventListener(
  'beforeinput',
  (e) => {
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo' || e.inputType === 'deleteByCut') {
      e.preventDefault();
    }
  },
  true,
);

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

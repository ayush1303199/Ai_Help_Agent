import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import Overlay from './Overlay.tsx';
import { AppErrorBoundary } from './ui/AppErrorBoundary';
import './index.css';

const isOverlay = new URLSearchParams(window.location.search).get('overlay') === '1';

if (isOverlay) {
  document.documentElement.classList.add('overlay-document');
  document.body.classList.add('overlay-body');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary overlay={isOverlay}>
      {isOverlay ? <Overlay /> : <App />}
    </AppErrorBoundary>
  </StrictMode>
);

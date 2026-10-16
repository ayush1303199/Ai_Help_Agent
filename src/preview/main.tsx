import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PREVIEW_FIXTURES } from './fixtures';
import { PreviewApp } from './PreviewApp';
import './preview.css';

const root = document.getElementById('root');
if (!root) throw new Error('The preview root element is missing.');

createRoot(root).render(
  <StrictMode>
    <PreviewApp
      fixtures={PREVIEW_FIXTURES}
    />
  </StrictMode>,
);

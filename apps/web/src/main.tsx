import '@wallx-play/ui/tokens.css';
import '@wallx-play/ui/base.css';
import './shell/shell.css';
import './content/content.css';
import './i18n';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { router } from './router';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);

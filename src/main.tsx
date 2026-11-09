import React from 'react';
import { createRoot } from 'react-dom/client';
import Platform from './Platform';
import './styles/index.css';
import { applyPreferences } from './preferences';
applyPreferences();
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <React.Suspense
      fallback={
        <div className="loading-screen" role="status">
          Abriendo GymPASS…
        </div>
      }
    >
      <Platform />
    </React.Suspense>
  </React.StrictMode>,
);

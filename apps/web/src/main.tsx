import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

document.documentElement.dataset.appVersion = __APP_VERSION__;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/pwa-worker.js', { updateViaCache: 'none' }).catch(() => {
      // The app remains fully usable when service-worker registration is unavailable.
    });
  });
}

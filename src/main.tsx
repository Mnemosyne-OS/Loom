import React from 'react';
import ReactDOM from 'react-dom/client';
import { onHostConfig } from './sdk/mnemo-sdk';
import App from './App';
import './app.css';
import { adoptHostLang } from './i18n/useI18n';

/** The SDK applies the host's theme and tokens on its own; Loom takes the language. */
onHostConfig((cfg) => {
  adoptHostLang(cfg.lang);
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

import { initApp } from './app';
import './style.css';

void initApp();

/** Regista PWA (produção) para poder instalar como app no telemóvel ou PC. */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

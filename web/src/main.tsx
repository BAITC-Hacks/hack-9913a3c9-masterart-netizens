import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './app/App';
import './styles/index.css';

// Тема следует системной настройке; ?theme=light|dark фиксирует её для показа и проверки.
const forced = new URLSearchParams(window.location.search).get('theme');
const media = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => {
  document.documentElement.dataset.theme = forced === 'light' || forced === 'dark' ? forced : media.matches ? 'dark' : 'light';
};
applyTheme();
media.addEventListener('change', applyTheme);

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

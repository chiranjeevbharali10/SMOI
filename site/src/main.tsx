import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@desktop/renderer/theme/tokens.css';
import '@desktop/renderer/components/smoi.css';
import './site.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

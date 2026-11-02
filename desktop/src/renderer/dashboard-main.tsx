import { createRoot } from 'react-dom/client';
import { App } from './dashboard/App';
import './theme/tokens.css';
import './components/smoi.css';
import './dashboard/dashboard.css';

createRoot(document.getElementById('root')!).render(<App />);

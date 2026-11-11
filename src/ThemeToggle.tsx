import { Moon, Sun } from 'lucide-react';
import { updatePreferences, usePreferences } from './preferences';

export default function ThemeToggle() {
  const { theme } = usePreferences();
  const dark = theme === 'dark';
  const label = dark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro';
  return <button type="button" className="icon-btn theme-toggle" aria-label={label} title={label} aria-pressed={dark}
    onClick={() => updatePreferences({ theme: dark ? 'light' : 'dark' })}>
    {dark ? <Sun size={19} /> : <Moon size={19} />}
  </button>;
}

import { Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { saveAppearance, usePreferences } from './preferences';

export default function ThemeToggle() {
  const { theme, appearanceEditable } = usePreferences();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dark = theme === 'dark';
  const label = dark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro';
  return <button type="button" className="icon-btn theme-toggle" aria-label={label} title={error || label} aria-pressed={dark} disabled={saving || appearanceEditable === false}
    onClick={async () => { if (saving) return; setSaving(true); setError(''); try { await saveAppearance({ theme: dark ? 'light' : 'dark' }); } catch (cause) { setError((cause as Error).message); } finally { setSaving(false); } }}>
    {dark ? <Sun size={19} /> : <Moon size={19} />}
  </button>;
}

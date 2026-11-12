import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../server/database.ts';
import { Service } from '../lib/service.ts';
import { gymAppearance, defaultGymAppearance } from '../lib/gym-appearance.ts';
import { componentHarness } from './component-harness.ts';

test('la apariencia se guarda por gimnasio, se valida y respeta los permisos de configuración', async t => {
  const a = new SqliteDatabase(':memory:'), b = new SqliteDatabase(':memory:');
  t.after(() => { a.close(); b.close(); });
  for (const db of [a, b]) db.raw.exec("INSERT INTO settings(id,owner,name) VALUES(1,'admin','Gym')");
  const actor = { id: 'admin', email: 'admin@example.test', name: 'Admin', role: 'admin' as const };
  const service = new Service(a, actor);
  await service.updateSettings({ ui_theme: 'dark', ui_accent: '#2455A4', ui_density: 'compact' });
  assert.deepEqual(gymAppearance(a.raw.prepare('SELECT * FROM settings').get()!), { theme: 'dark', accent: '#2455a4', density: 'compact' });
  assert.deepEqual(gymAppearance(b.raw.prepare('SELECT * FROM settings').get()!), defaultGymAppearance);
  for (const patch of [{ ui_theme: 'system' }, { ui_accent: 'red' }, { ui_density: 'wide' }]) await assert.rejects(service.updateSettings(patch));
  await assert.rejects(new Service(a, { ...actor, role: 'operator' }).updateSettings({ ui_theme: 'light' }), /permiso|administrador|rol/i);
  assert.equal(a.raw.prepare('SELECT COUNT(*) n FROM audit').get()!.n, 1);
});

test('cada dispositivo recibe el gimnasio activo y una respuesta tardía no cambia otro gimnasio', async t => {
  const h = componentHarness({ Event, window: { addEventListener() {}, dispatchEvent() {} }, localStorage: { getItem: () => JSON.stringify({ theme: 'dark', accent: '#75516f' }), setItem() {} }, document: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null } });
  t.after(() => h.cleanup());
  const p = h.load('../src/preferences.ts');
  let release!: () => void;
  const written: unknown[] = [];
  p.setGymAppearance({ ui_theme: 'light', ui_accent: '#2455a4', ui_density: 'compact' }, 'gym-a', async (patch: unknown) => { written.push(patch); await new Promise<void>(resolve => { release = resolve; }); });
  assert.equal((h.render(p.usePreferences) as any).theme, 'light');
  assert.equal((h.render(p.usePreferences) as any).accent, '#2455a4');
  p.updatePreferences({ theme: 'dark', accent: '#75516f' });
  assert.equal((h.render(p.usePreferences) as any).theme, 'light', 'Una preferencia del dispositivo no sobrescribe el gimnasio');
  const pending = p.saveAppearance({ theme: 'dark' });
  p.setGymAppearance({ ui_theme: 'light', ui_accent: '#356653' }, 'gym-b');
  release(); await pending;
  assert.equal((h.render(p.usePreferences) as any).accent, '#356653');
  assert.equal((h.render(p.usePreferences) as any).theme, 'light');
  assert.deepEqual(JSON.parse(JSON.stringify(written)), [{ theme: 'dark' }]);
  await assert.rejects(p.saveAppearance({ theme: 'dark' }), /administrador/);
});

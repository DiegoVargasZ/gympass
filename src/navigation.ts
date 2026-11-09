import type { Role } from '../lib/domain';

export type Page =
  'dashboard' | 'access' | 'pos' | 'people' | 'credentials' | 'renewals' | 'history' | 'attendance' | 'settings';
export type NavigationItem = {
  id: Page;
  label: string;
  href: string;
  roles: readonly Role[];
  group: string;
};
const all: readonly Role[] = ['admin', 'operator', 'viewer'];
/** El cajero solo ve Inicio, Recepción, Socios y Caja: los reportes son del administrador y de consulta. */
const reporting: readonly Role[] = ['admin', 'viewer'];
export const navigation: readonly NavigationItem[] = [
  { id: 'dashboard', label: 'Inicio', href: '#dashboard', roles: all, group: 'Inicio' },
  { id: 'access', label: 'Recepción', href: '#access', roles: ['admin', 'operator'], group: 'Recepción' },
  { id: 'people', label: 'Socios', href: '#people', roles: all, group: 'Socios' },
  { id: 'credentials', label: 'Credenciales QR', href: '#credentials', roles: ['admin', 'operator'], group: 'Socios' },
  { id: 'renewals', label: 'Planes por vencer', href: '#renewals', roles: ['admin'], group: 'Socios' },
  { id: 'pos', label: 'Caja y planes', href: '#pos', roles: ['admin', 'operator'], group: 'Caja y planes' },
  { id: 'history', label: 'Historial de accesos', href: '#history', roles: reporting, group: 'Asistencia e informes' },
  {
    id: 'attendance',
    label: 'Asistencia y horas',
    href: '#attendance',
    roles: reporting,
    group: 'Asistencia e informes',
  },
  { id: 'settings', label: 'Configuración', href: '#settings', roles: all, group: 'Configuración' },
];
export function navigationFor(role: Role) {
  return navigation.filter((item) => item.roles.includes(role));
}
export type SectionId = 'dashboard' | 'access' | 'people' | 'pos' | 'reports' | 'settings';
const sectionPages: readonly { id: SectionId; label: string; pages: readonly Page[] }[] = [
  { id: 'dashboard', label: 'Inicio', pages: ['dashboard'] },
  { id: 'access', label: 'Recepción', pages: ['access'] },
  { id: 'people', label: 'Socios', pages: ['people', 'credentials', 'renewals'] },
  { id: 'pos', label: 'Caja y planes', pages: ['pos'] },
  { id: 'reports', label: 'Asistencia e informes', pages: ['history', 'attendance'] },
  { id: 'settings', label: 'Configuración', pages: ['settings'] },
];
export type Section = { id: SectionId; label: string; href: string; tabs: readonly NavigationItem[] };
export function sectionsFor(role: Role): Section[] {
  const items = navigationFor(role);
  return sectionPages.flatMap(({ id, label, pages }) => {
    const tabs = pages.flatMap((page) => items.filter((item) => item.id === page));
    return tabs.length ? [{ id, label, href: tabs[0].href, tabs }] : [];
  });
}
export function sectionOf(page: Page): SectionId {
  return sectionPages.find((section) => section.pages.includes(page))?.id ?? 'dashboard';
}
export function pageFromHash(hash: string): Page {
  const key = hash.replace(/^#/, '').split('?')[0];
  return navigation.find((item) => item.id === key)?.id ?? 'dashboard';
}

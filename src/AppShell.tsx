import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  BarChart3,
  Home,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  Settings,
  ScanLine,
  Users,
  X,
  ShoppingCart,
} from 'lucide-react';
import { type Bootstrap, roleLabels } from '../lib/domain';
import { api } from './api';
import { Avatar, type Notify } from './ui';
import { sectionOf, sectionsFor, type Page, type SectionId } from './navigation';
import MobileNavigation from './MobileNavigation';
import Alerts from './Alerts';
import BrandLogo from './BrandLogo';
import ConnectionStatus from './ConnectionStatus';
import ThemeToggle from './ThemeToggle';
import ScopedImage from './ScopedImage';
import { logoUrl } from './branding';

const icons: Record<SectionId, typeof Home> = {
  dashboard: Home,
  access: ScanLine,
  people: Users,
  pos: ShoppingCart,
  reports: BarChart3,
  settings: Settings,
};
export default function AppShell({
  data,
  page,
  children,
  onSearch,
  reload,
  notify,
  onLogout,
}: {
  data: Bootstrap;
  page: Page;
  children: ReactNode;
  onSearch: () => void;
  reload: () => Promise<void>;
  notify: Notify;
  onLogout: () => void;
}) {
  const [menu, setMenu] = useState(false),
    [busy, setBusy] = useState(false),
    [loggingOut, setLoggingOut] = useState(false);
  const logoutPending = useRef(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('gympass.sidebar-collapsed') === 'true';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('gympass.sidebar-collapsed', String(collapsed));
    } catch {
      /* The menu still works when storage is unavailable. */
    }
  }, [collapsed]);
  const sidebar = useRef<HTMLElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const sections = sectionsFor(data.user.role),
    current = sectionOf(page);
  useEffect(() => {
    const close = () => setMenu(false);
    window.addEventListener('hashchange', close);
    return () => window.removeEventListener('hashchange', close);
  }, []);
  useEffect(() => {
    if (!menu) return;
    const previous = document.activeElement as HTMLElement;
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    sidebar.current?.querySelector<HTMLButtonElement>('.sidebar-close')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(false);
      if (event.key !== 'Tab') return;
      const nodes = Array.from(
        sidebar.current?.querySelectorAll<HTMLElement>('a[href],button:not(:disabled)') || [],
      ).filter((node) => node.getClientRects().length);
      if (event.shiftKey && document.activeElement === nodes[0]) {
        event.preventDefault();
        nodes.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === nodes.at(-1)) {
        event.preventDefault();
        nodes[0]?.focus();
      }
    };
    const resize = () => setMenu(false);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', resize);
    return () => {
      document.body.style.overflow = old;
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', resize);
      if (previous?.isConnected) previous.focus();
    };
  }, [menu]);
  return (
    <div className={'app-shell' + (collapsed ? ' sidebar-collapsed' : '')}>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        Saltar al contenido
      </a>
      <aside
        ref={sidebar}
        id="main-navigation"
        className={'sidebar ' + (menu ? 'open' : '')}
        aria-label="Navegación principal"
        role={menu ? 'dialog' : undefined}
        aria-modal={menu || undefined}
      >
        <div className="sidebar-brand">
          <a href="#dashboard" className="brand" aria-label={data.settings.name + ' · Inicio'}>
            <span className="brand-text">
              <strong className="brand-name">{data.settings.name}</strong>
            </span>
          </a>
          <button className="icon-btn sidebar-close" aria-label="Cerrar navegación" onClick={() => setMenu(false)}>
            <X size={22} />
          </button>
        </div>
        <nav aria-label="Secciones">
          {sections.map((section) => {
            const Icon = icons[section.id];
            return (
              <a
                href={section.href}
                key={section.id}
                title={section.label}
                className={current === section.id ? 'active' : ''}
                aria-current={current === section.id ? 'page' : undefined}
              >
                <Icon size={20} aria-hidden="true" />
                <span>{section.label}</span>
              </a>
            );
          })}
        </nav>
        <div className="user-box">
          <Avatar name={data.user.name} />
          <div>
            <strong>{data.user.name}</strong>
            <small>{roleLabels[data.user.role]}</small>
          </div>
          <button
            className="icon-btn"
            aria-label="Cerrar sesión"
            disabled={loggingOut}
            aria-busy={loggingOut}
            onClick={async () => {
              if (logoutPending.current) return;
              if (
                document.querySelector('[data-dirty="true"]') &&
                !confirm('Hay cambios sin guardar. ¿Descartarlos y cerrar sesión?')
              )
                return;
              logoutPending.current = true;
              setLoggingOut(true);
              try {
                await api('auth/logout', 'POST');
                onLogout();
              } catch (error) {
                notify((error as Error).message, true);
              } finally {
                logoutPending.current = false;
                setLoggingOut(false);
              }
            }}
          >
            <LogOut size={18} />
          </button>
        </div>
      </aside>
      {menu && <button className="sidebar-overlay" aria-label="Cerrar navegación" onClick={() => setMenu(false)} />}
      <div className="workspace" inert={menu}>
        {data.settings.logo_path && (
          <div
            className="gym-watermark"
            aria-hidden="true"
            style={{ '--gym-watermark-size': data.settings.logo_watermark_size ?? 45 } as CSSProperties}
          >
            <ScopedImage src={logoUrl(data.settings.logo_path)} alt="" />
          </div>
        )}
        <header className="topbar">
          <button
            type="button"
            className="icon-btn sidebar-toggle"
            aria-label={collapsed ? 'Expandir navegación' : 'Contraer navegación'}
            title={collapsed ? 'Expandir navegación' : 'Contraer navegación'}
            aria-expanded={!collapsed}
            aria-controls="main-navigation"
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? <PanelLeftOpen size={21} /> : <PanelLeftClose size={21} />}
          </button>
          <button
            ref={trigger}
            className="icon-btn mobile-menu"
            aria-label="Abrir navegación"
            aria-expanded={menu}
            aria-controls="main-navigation"
            onClick={() => setMenu(true)}
          >
            <Menu size={22} />
          </button>
          <BrandLogo />
          <button
            type="button"
            className="topbar-search"
            aria-label="Buscar un socio o ir a una pantalla"
            onClick={onSearch}
          >
            <Search size={18} aria-hidden="true" />
            <span>Buscar un socio o ir a una pantalla</span>
            <kbd>Ctrl K</kbd>
          </button>
          <div className="topbar-right">
            <ConnectionStatus platform={!!data.platform} replica={!!data.replica?.linked} />
            <Alerts timezone={data.settings.timezone} />
            <ThemeToggle />
            <button
              className="icon-btn"
              disabled={busy}
              aria-label="Actualizar datos"
              onClick={async () => {
                setBusy(true);
                try {
                  await reload();
                  notify('Datos actualizados');
                } catch (error) {
                  notify((error as Error).message, true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <RefreshCw size={18} className={busy ? 'spin' : ''} />
            </button>
          </div>
        </header>
        {children}
        <footer className="app-footer">
          GymPASS {data.version && `v${data.version}`}
          <span>Entradas y salidas del gimnasio</span>
        </footer>
      </div>
      <MobileNavigation sections={sections} current={current} more={menu} onMore={() => setMenu((value) => !value)} />
    </div>
  );
}

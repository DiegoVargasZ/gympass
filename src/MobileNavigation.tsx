import { BarChart3, Home, MoreHorizontal, ScanLine, ShoppingCart, Users } from 'lucide-react';
import type { Section, SectionId } from './navigation';

const primary = [
  ['dashboard', Home],
  ['access', ScanLine],
  ['people', Users],
  ['pos', ShoppingCart],
] as const satisfies readonly (readonly [SectionId, typeof BarChart3])[];
export default function MobileNavigation({
  sections,
  current,
  more,
  onMore,
}: {
  sections: readonly Section[];
  current: SectionId;
  more: boolean;
  onMore: () => void;
}) {
  return (
    <nav className="mobile-navigation" aria-label="Navegación del teléfono">
      {primary.flatMap(([id, Icon]) => {
        const section = sections.find((item) => item.id === id);
        return section
          ? [
              <a key={id} href={section.href} aria-current={current === id && !more ? 'page' : undefined}>
                <Icon size={22} aria-hidden="true" />
                <span>{section.label}</span>
              </a>,
            ]
          : [];
      })}
      <button
        type="button"
        aria-expanded={more}
        aria-controls="main-navigation"
        onClick={onMore}
        className={more || !primary.some(([id]) => id === current) ? 'active' : ''}
      >
        <MoreHorizontal size={22} aria-hidden="true" />
        <span>Más</span>
      </button>
    </nav>
  );
}

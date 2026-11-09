import { sectionOf, type Page, type Section } from './navigation';

/** Related pages of one sidebar section, shown as tabs above the page content. */
export default function SectionTabs({ sections, page }: { sections: readonly Section[]; page: Page }) {
  const section = sections.find((item) => item.id === sectionOf(page));
  if (!section || section.tabs.length < 2) return null;
  return (
    <nav className="section-tabs" aria-label={section.label}>
      {section.tabs.map((tab) => (
        <a
          key={tab.id}
          href={tab.href}
          aria-current={tab.id === page ? 'page' : undefined}
          className={tab.id === page ? 'active' : ''}
        >
          {tab.label}
        </a>
      ))}
    </nav>
  );
}

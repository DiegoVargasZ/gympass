import type { ReactNode } from 'react';
export default function FilterBar({
  children,
  onClear,
  activeCount = 0,
}: {
  children: ReactNode;
  onClear?: () => void;
  activeCount?: number;
}) {
  return (
    <div className="filter-bar">
      <div className="filter-fields">{children}</div>
      {onClear && activeCount > 0 && (
        <button type="button" className="btn secondary small" onClick={onClear}>
          Limpiar filtros ({activeCount})
        </button>
      )}
    </div>
  );
}

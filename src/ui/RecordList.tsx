import type { ReactNode, Key } from 'react';
import { Empty, Skeleton } from '../ui';
export type RecordListState = { status: 'loading' | 'ready' | 'error'; error?: string };
export default function RecordList<T>({
  rows,
  getKey,
  headers,
  renderDesktopRow,
  renderMobileItem,
  state,
  emptyText,
}: {
  rows: readonly T[];
  getKey: (row: T) => Key;
  headers: ReactNode;
  renderDesktopRow: (row: T) => ReactNode;
  renderMobileItem: (row: T) => ReactNode;
  state: RecordListState;
  emptyText: string;
}) {
  if (state.status === 'loading') return <Skeleton />;
  if (state.status === 'error')
    return (
      <p className="error-message" role="alert">
        {state.error || 'No pudimos cargar los registros.'}
      </p>
    );
  if (!rows.length) return <Empty text={emptyText} />;
  return (
    <div className="record-list">
      <div className="record-desktop table-scroll">
        <table>
          <thead>{headers}</thead>
          <tbody>
            {rows.map((row) => (
              <tr key={getKey(row)}>{renderDesktopRow(row)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="record-mobile">
        {rows.map((row) => (
          <article className="record-item" key={getKey(row)}>
            {renderMobileItem(row)}
          </article>
        ))}
      </div>
    </div>
  );
}

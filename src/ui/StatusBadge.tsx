import type { ReactNode } from 'react';
export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
const tones = { neutral: 'gray', info: 'blue', success: 'green', warning: 'amber', danger: 'red' };
export default function StatusBadge({ tone = 'neutral', children }: { tone?: StatusTone; children: ReactNode }) {
  return <span className={'badge ' + tones[tone]}>{children}</span>;
}

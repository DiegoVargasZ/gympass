import type { Bootstrap } from '../lib/domain';
export type ResourceProps = { data: Bootstrap; admin: boolean; saved: () => Promise<void> };
export type AuditEntry = { id: number; actor: string; action: string; entity_id?: string; occurred_at: number };

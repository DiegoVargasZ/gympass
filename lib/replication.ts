import { appearanceColumns } from './gym-appearance.ts';
export type SyncValue = string | number | null;
export type SyncRow = Record<string, SyncValue>;
export type SyncColumn = { name: string; type: string; pk: number };
export type SyncTable = {
  name: string;
  sql?: string;
  columns: SyncColumn[];
  rows: SyncRow[];
};
export type SyncSnapshot = {
  protocol: 1;
  gym_id: string;
  installation_id: string;
  revision: string;
  issued_at: number;
  expires_at: number;
  kind: "desktop" | "mobile";
  scope?: "management";
  user: { id: string; name: string; email: string; role: "admin" | "operator" };
  tables: SyncTable[];
  triggers: string[];
  assets?: Record<string, string>;
};
export type SyncUnchanged = Pick<
  SyncSnapshot,
  | "gym_id"
  | "installation_id"
  | "revision"
  | "issued_at"
  | "expires_at"
  | "user"
> & { unchanged: true };
/** Upgrade cached copies without creating edits or changing an in-flight batch. */
export function upgradeAppearanceSnapshot(snapshot: SyncSnapshot): SyncSnapshot {
  return { ...snapshot, tables: snapshot.tables.map(table => {
    if (table.name !== 'settings') return table;
    const missing = appearanceColumns.filter(field => !table.columns.some(column => column.name === field.name));
    if (!missing.length) return table;
    return { ...table, columns: [...table.columns, ...missing.map(field => ({ name: field.name, type: 'TEXT', pk: 0 }))],
      rows: table.rows.map(row => ({ ...Object.fromEntries(missing.map(field => [field.name, field.value])), ...row })) };
  }) };
}
export function renewSyncSnapshot(
  base: SyncSnapshot,
  update: SyncUnchanged,
): SyncSnapshot {
  if (
    update.gym_id !== base.gym_id ||
    update.installation_id !== base.installation_id ||
    update.revision !== base.revision ||
    update.user.id !== base.user.id ||
    !Number.isFinite(update.issued_at) ||
    !Number.isFinite(update.expires_at) ||
    update.expires_at <= update.issued_at ||
    update.expires_at - update.issued_at > 7 * 86400000
  )
    throw Error("La renovación no corresponde a la copia de este gimnasio.");
  return {
    ...base,
    issued_at: update.issued_at,
    expires_at: update.expires_at,
    user: update.user,
  };
}
export type SyncChange = {
  table: string;
  before: SyncRow | null;
  after: SyncRow | null;
};
export type SyncPatch = {
  id: string;
  gym_id: string;
  installation_id: string;
  base_revision: string;
  issued_at: number;
  expires_at: number;
  changes: SyncChange[];
  assets?: Record<string, { before: string | null; after: string | null }>;
};
export const syncTables = [
  "settings",
  "zones",
  "schedules",
  "people",
  "person_zones",
  "credentials",
  "devices",
  "invitation_batches",
  "invitation_templates",
  "visits",
  "invitation_operations",
  "blocklist",
  "calendar_exceptions",
  "attendance_periods",
  "saved_reports",
  "alert_reads",
  "pos_products",
  "pos_plans",
  "pos_sales",
  "pos_sale_lines",
  "pos_memberships",
  "events",
  "pos_membership_uses",
  "pos_stock_movements",
  "audit",
] as const;
export const mobileSyncTables = new Set<string>([
  "settings",
  "zones",
  "schedules",
  "people",
  "person_zones",
  "credentials",
  "visits",
  "blocklist",
  "pos_memberships",
  "events",
  "pos_membership_uses",
]);
export const syncKey = (table: SyncTable, row: SyncRow) =>
  JSON.stringify(
    (table.name === "events"
      ? ["request_key"]
      : table.columns
          .filter((c) => c.pk)
          .sort((a, b) => a.pk - b.pk)
          .map((c) => c.name)
    ).map((key) => row[key]),
  );
export const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export function syncChanges(
  base: SyncSnapshot,
  tables: SyncTable[],
): SyncChange[] {
  const changes: SyncChange[] = [];
  for (const original of base.tables) {
    const current = tables.find((t) => t.name === original.name);
    if (!current)
      throw Error("Falta una tabla de la copia local: " + original.name);
    const before = new Map(
      original.rows.map((row) => [syncKey(original, row), row]),
    );
    for (const after of current.rows) {
      const key = syncKey(original, after),
        previous = before.get(key) || null;
      before.delete(key);
      if (
        !previous ||
        original.columns.some(
          (c) => !sameValue(previous[c.name], after[c.name]),
        )
      )
        changes.push({ table: original.name, before: previous, after });
    }
    for (const row of before.values())
      changes.push({ table: original.name, before: row, after: null });
  }
  return changes;
}
export function validSyncSnapshot(
  snapshot: SyncSnapshot,
  gym: string,
  user: string,
  installation?: string,
) {
  if (
    !snapshot ||
    snapshot.protocol !== 1 ||
    snapshot.gym_id !== gym ||
    snapshot.user?.id !== user ||
    (installation && snapshot.installation_id !== installation) ||
    !Array.isArray(snapshot.tables) ||
    !Number.isFinite(snapshot.expires_at) ||
    snapshot.expires_at <= snapshot.issued_at ||
    !/^[a-f0-9]{64}$/.test(snapshot.installation_id)
  )
    throw Error("La copia no pertenece a esta cuenta y gimnasio.");
  for (const table of snapshot.tables) {
    if (
      !syncTables.includes(table.name as (typeof syncTables)[number]) ||
      !Array.isArray(table.rows) ||
      !table.columns.every(
        (c) =>
          /^[a-z_][a-z0-9_]*$/.test(c.name) &&
          /^(TEXT|INTEGER|REAL|BLOB|NUMERIC)$/i.test(c.type),
      )
    )
      throw Error("La copia contiene una tabla no compatible.");
    if (table.sql && (!new RegExp('^CREATE TABLE(?: IF NOT EXISTS)? ["`]?'+table.name+'["`]?\\s*\\(', 'i').test(table.sql) || /;\s*\S/.test(table.sql)))
      throw Error("El esquema de la copia no es compatible.");
  }
}
export async function mappedSyncPatch(
  patch: SyncPatch,
  ids: Record<string, number>,
  hash: (value: string) => Promise<string>,
): Promise<SyncPatch> {
  const copy: SyncPatch = JSON.parse(JSON.stringify(patch));
  for (const change of copy.changes) {
    if (change.table === "pos_membership_uses")
      for (const row of [change.before, change.after])
        if (row && ids[String(row.event_id)] !== undefined)
          row.event_id = ids[String(row.event_id)];
    if (change.table === "events")
      for (const row of [change.before, change.after]) {
        if (!row || !String(row.request_key).startsWith("auto-close:"))
          continue;
        const entry = String(row.request_key).slice(11),
          id = ids[entry];
        if (id !== undefined) {
          row.request_key = "auto-close:" + id;
          row.payload_hash = await hash(
            JSON.stringify(["AUTO_CLOSE", id, row.occurred_at]),
          );
        }
      }
  }
  return copy;
}

import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import type { ServerResponse } from 'node:http';
import type { TenantContext } from './tenant-manager.ts';
import { ApiError } from '../lib/service.ts';
import { legacyProductCostTable, type SyncRow, type SyncTable } from '../lib/replication.ts';
import { authorizeReplica, replicaSchema, replicaMetadata } from './replication.ts';
import type { PlatformStore } from './platform-store.ts';
import { sendStream } from './stream-transfer.ts';
import { fileChunks } from './file-chunks.ts';

type Metadata = Awaited<ReturnType<typeof replicaMetadata>>;

function mobileRow(name: string, row: SyncRow): SyncRow {
  if (name === 'settings') return { ...row, recovery_hash: '' };
  if (name === 'credentials') return { ...row, code_cipher: null };
  if (name === 'pos_memberships') return { ...row, price_cents: 0 };
  return row;
}

/** Keep the latest 10k events and the last allowed entry of each person/zone, directly in SQLite. */
const mobileEvents = `SELECT * FROM events WHERE rowid IN (SELECT rowid FROM events ORDER BY rowid DESC LIMIT 10000)
  OR (direction='entry' AND id IN (
    SELECT (SELECT l.id FROM events l WHERE l.person_id IS k.person_id AND l.zone_id IS k.zone_id AND l.allowed=1
      ORDER BY l.occurred_at DESC,l.id DESC LIMIT 1)
    FROM (SELECT DISTINCT person_id,zone_id FROM events WHERE allowed=1) k)) ORDER BY rowid`;

async function* assetFiles(root: string, name: string): AsyncGenerator<string> {
  const path = join(root, name);
  if (!existsSync(path)) return;
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new ApiError(409, 'No se sincronizan enlaces de archivos.');
  if (info.isDirectory()) for (const child of readdirSync(path).sort()) yield* assetFiles(root, name + '/' + child);
  else if (info.isFile()) yield name;
}

async function* snapshotChunks(ctx: TenantContext, metadata: Metadata, productCosts: boolean) {
  const management = metadata.kind === 'desktop' || metadata.scope === 'management';
  const schema = replicaSchema(ctx.db.raw, management ? 'desktop' : 'mobile');
  const triggers = ctx.db.raw.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name NOT LIKE 'sync_%' ORDER BY name").all().map(row => row.sql);
  yield JSON.stringify(metadata).slice(0, -1) + ',"triggers":' + JSON.stringify(triggers) + ',"tables":[';
  let firstTable = true;
  for (const original of schema) {
    const table = productCosts ? original : legacyProductCostTable(original);
    yield (firstTable ? '' : ',') + JSON.stringify({ ...table, rows: undefined }).slice(0, -1) + ',"rows":[';
    firstTable = false;
    let batch = '', firstRow = true, count = 0;
    const query = !management && original.name === 'events' ? mobileEvents : `SELECT * FROM "${original.name}" ORDER BY rowid`;
    for (const value of ctx.db.raw.prepare(query).iterate()) {
      let row = management ? value as SyncRow : mobileRow(original.name, value as SyncRow);
      if (!productCosts && ['pos_products', 'pos_sale_lines'].includes(original.name)) {
        const { cost_cents: _cost, ...compatible } = row;
        row = compatible;
      }
      batch += (firstRow ? '' : ',') + JSON.stringify(row);
      firstRow = false;
      if (++count % 128 === 0 || batch.length >= 32768) {
        yield batch;
        batch = '';
        await setImmediate();
      }
    }
    if (batch) yield batch;
    yield ']}';
    await setImmediate();
  }
  yield ']';
  if (management) {
    yield ',"assets":{';
    let first = true;
    for (const name of ['credentials.key', 'photos', 'branding', 'backgrounds']) {
      for await (const file of assetFiles(ctx.root, name)) {
        yield (first ? '' : ',') + JSON.stringify(file) + ':"';
        first = false;
        // Each non-final chunk is a multiple of three bytes, so concatenated base64 remains valid.
        let remainder = Buffer.alloc(0);
        for await (const chunk of fileChunks(join(ctx.root, file))) {
          const bytes = remainder.length ? Buffer.concat([remainder, chunk]) : chunk as Buffer;
          const complete = bytes.length - bytes.length % 3;
          yield bytes.subarray(0, complete).toString('base64');
          remainder = Buffer.from(bytes.subarray(complete));
        }
        if (remainder.length) yield remainder.toString('base64');
        yield '"';
      }
    }
    yield '}';
  }
  yield '}';
}

/** Preserves protocol 1: installed Android and Windows clients need no update. */
export async function sendReplicaSnapshot(
  ctx: TenantContext, res: ServerResponse, metadata: Metadata, productCosts: boolean,
  authorize: () => void, envelope?: Record<string, unknown>,
) {
  const chunks = async function* () {
    if (envelope) yield JSON.stringify(envelope).slice(0, -1) + ',"snapshot":';
    yield* snapshotChunks(ctx, metadata, productCosts);
    if (envelope) yield '}';
  };
  await sendStream(res, chunks(), { 'Content-Type': 'application/json; charset=utf-8' }, authorize, true);
}

/** Pin a WAL read transaction and immutable assets, then release the gym queue before network I/O. */
export async function prepareReplicaSnapshot(
  ctx: TenantContext, res: ServerResponse, device: Parameters<typeof replicaMetadata>[1],
  auth: Parameters<typeof replicaMetadata>[2], store: PlatformStore, token: string,
  productCosts: boolean, envelope?: Record<string, unknown>,
) {
  const metadata = await replicaMetadata(ctx, device, auth, productCosts);
  const file = ctx.db.raw.location()!;
  const reader = new DatabaseSync(file, { readOnly: true });
  let authorization: DatabaseSync | undefined;
  let frozen: string | undefined;
  const dispose = () => {
    reader.close(); authorization?.close();
    if (frozen && dirname(resolve(frozen)) === resolve(ctx.root)) rmSync(frozen, { recursive: true, force: true });
  };
  try {
    reader.exec('BEGIN');
    reader.prepare('SELECT version FROM sync_revision WHERE id=1').get();
    authorization = new DatabaseSync(file, { readOnly: true });
    const authorizeContext = { ...ctx, db: { raw: authorization } as TenantContext['db'] };
    if (metadata.kind === 'desktop' || metadata.scope === 'management') {
      frozen = mkdtempSync(join(ctx.root, '.sync-transfer-'));
      for (const name of ['credentials.key', 'photos', 'branding', 'backgrounds'])
        for await (const asset of assetFiles(ctx.root, name)) {
          const target = join(frozen, asset);
          mkdirSync(dirname(target), { recursive: true });
          try { linkSync(join(ctx.root, asset), target); }
          catch { cpSync(join(ctx.root, asset), target, { errorOnExist: true, force: false }); }
        }
    }
    const snapshotContext = { ...ctx, root: frozen || ctx.root, db: { raw: reader } as TenantContext['db'] };
    return async () => {
      try {
        await sendReplicaSnapshot(snapshotContext, res, metadata, productCosts, () => { authorizeReplica(store, authorizeContext, token, false); }, envelope);
      } finally { dispose(); }
    };
  } catch (error) { dispose(); throw error; }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream, ftruncateSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout } from 'node:timers/promises';
import { get, type IncomingMessage } from 'node:http';
import { startPlatform } from '../server/platform.ts';
import { TenantManager } from '../server/tenant-manager.ts';
import { PlatformStore } from '../server/platform-store.ts';
import { replicaSnapshot, authorizeReplica, pairReplica } from '../server/replication.ts';
import { streamBackupCopy } from '../server/backup-transfer.ts';
import { backupJob } from '../server/backup-jobs.ts';
import { maxBackupTransferBytes } from '../lib/backup-limits.ts';

function temporary(_t: any) {
  return mkdtempSync(join(tmpdir(), 'gympass-resources-'));
}
function cleanup(root: string) {
  const child = relative(tmpdir(), root);
  assert.ok(child.startsWith('gympass-resources-') && !child.includes(sep));
  rmSync(root, { recursive: true, force: true });
}

async function fixture(t: any) {
  const root = temporary(t);
  const app = await startPlatform({ dataDirectory: root, port: 0, allowHttp: true });
  t.after(async () => { await app.close(); cleanup(root); });
  const owner = await app.store.bootstrap({ name: 'Owner', email: 'owner@example.test', password: 'Prueba123456' });
  const gym = app.store.createGym(owner, { name: 'Recursos', slug: 'recursos' });
  app.tenants.provision(gym); app.store.markGymProvisioned(gym.id);
  await app.store.createMember(owner, gym.id, { name: 'Admin', email: 'admin@example.test', password: 'Prueba123456', role: 'admin' });
  const login = await app.store.login({ email: 'admin@example.test', password: 'Prueba123456' });
  const auth = app.store.authorizeSync(login.token, gym.id);
  const pair = await app.tenants.withTenant(gym, async ctx => pairReplica(ctx, auth, { name: 'Windows', kind: 'desktop' }, app.store.linkedCredentialRevision(auth.user.id)));
  const request = (revision?: string, costs = true) => fetch(app.url + `/api/gyms/${gym.id}/sync/snapshot` + (revision ? '?revision=' + revision : ''), {
    headers: { Authorization: 'Bearer ' + pair.token, ...(costs ? { 'X-GymPASS-Product-Costs': '1' } : {}) },
  });
  return { root, app, gym, pair, request };
}

test('la renovación no consulta el historial y funciona aunque otra transferencia ocupe el cupo', async t => {
  const f = await fixture(t);
  const first = await (await f.request()).json();
  let release!: () => void;
  const held = f.app.tenants.withHeavyOperation(() => new Promise<void>(done => { release = done; }));
  let restore!: () => void;
  await f.app.tenants.withTenant(f.gym, async ctx => {
    const prepare = ctx.db.raw.prepare;
    ctx.db.raw.prepare = function(this: typeof ctx.db.raw, sql: string) {
      assert.doesNotMatch(sql, /SELECT\s+\*\s+FROM\s+"?(events|people|pos_sales)\b/i, 'La revisión no debe materializar datos de negocio.');
      return prepare.call(this, sql);
    } as typeof prepare;
    restore = () => { ctx.db.raw.prepare = prepare; };
  });
  try {
    const response = await f.request(first.revision);
    assert.equal(response.status, 200);
    const same = await response.json();
    assert.equal(same.unchanged, true);
    assert.equal(same.issued_at, first.issued_at);
    assert.equal(same.expires_at, first.expires_at);
    assert.equal(same.tables, undefined);
    const rejected = await f.request();
    assert.equal(rejected.status, 429);
    assert.equal(rejected.headers.get('retry-after'), '5');
    assert.equal((await fetch(f.app.url + '/api/health')).status, 200);
  } finally { restore(); release(); await held; }
  const recovered = await f.request();
  assert.equal(recovered.status, 200); await recovered.arrayBuffer();
});

test('el stream conserva las tablas, las fotos, el formato anterior y las renovaciones revocables', async t => {
  const f = await fixture(t);
  const photo = crypto.randomUUID() + '.webp';
  const bytes = Buffer.alloc(48 * 1024 + 2, 97);
  await f.app.tenants.withTenant(f.gym, async ctx => {
    mkdirSync(join(ctx.root, 'photos'));
    writeFileSync(join(ctx.root, 'photos', photo), bytes);
  });
  for (const costs of [true, false]) {
    const expected = await f.app.tenants.withTenant(f.gym, async ctx => {
      const { device, auth } = authorizeReplica(f.app.store, ctx, f.pair.token);
      return replicaSnapshot(ctx, device, auth, costs);
    });
    const response = await f.request(undefined, costs);
    assert.equal(response.status, 200);
    const actual = await response.json();
    assert.deepEqual(actual, JSON.parse(JSON.stringify(expected)));
    assert.deepEqual(Buffer.from(actual.assets!['photos/' + photo], 'base64'), bytes);
    const previous = actual.revision;
    await f.app.tenants.withTenant(f.gym, async ctx => {
      ctx.db.raw.prepare('UPDATE settings SET name=? WHERE id=1').run('Otro ' + costs);
    });
    const changed = await (await f.request(previous, costs)).json();
    assert.ok(changed.tables); assert.notEqual(changed.revision, previous);
  }
  const current = await (await f.request()).json();
  writeFileSync(join(f.root, 'tenants', f.gym.id, 'photos', photo), Buffer.alloc(bytes.length, 98));
  utimesSync(join(f.root, 'tenants', f.gym.id, 'photos', photo), new Date(), new Date(Date.now() + 60000));
  const photoChanged = await (await f.request(current.revision)).json();
  assert.notEqual(photoChanged.revision, current.revision);
  f.app.store.raw.prepare('UPDATE gym_memberships SET active=0 WHERE gym_id=?').run(f.gym.id);
  const denied = await f.request(photoChanged.revision);
  assert.equal(denied.status, 403);
});

test('los respaldos mayores de 256 MiB se exportan por partes y se importan con verificación de identidad', async t => {
  const root = temporary(t), manager = new TenantManager(root);
  t.after(async () => { await manager.close(); cleanup(root); });
  const gym = { id: crypto.randomUUID(), name: 'Grande' };
  manager.provision(gym);
  await manager.withTenant(gym, async ctx => {
    mkdirSync(join(ctx.root, 'photos'));
    const photo = join(ctx.root, 'photos', crypto.randomUUID() + '.webp');
    const fd = openSync(photo, 'wx');
    try { ftruncateSync(fd, 260 * 1024 * 1024); } finally { closeSync(fd); }
    let ticks = 0;
    const clock = setInterval(() => { ticks++; }, 1);
    try {
      const copy = await ctx.backups.createAsync();
      const schema = Number(ctx.db.raw.prepare('SELECT MAX(version) n FROM schema_version').get()!.n);
      await ctx.backups.inspectAsync(copy.id, gym.id);
      const stream = streamBackupCopy(ctx.backups.directory, copy.id, schema);
      assert.ok(stream.size > 256 * 1024 * 1024 && stream.size < maxBackupTransferBytes);
      const archive = join(root, 'large.gympassbackup');
      let largest = 0, total = 0;
      const measured = async function* () {
        for await (const chunk of stream.chunks) { largest = Math.max(largest, chunk.length); total += chunk.length; yield chunk; }
      };
      await pipeline(Readable.from(measured(), { objectMode: false }), createWriteStream(archive));
      assert.equal(total, stream.size);
      assert.ok(largest <= 64 * 1024, 'El archivo grande no debe convertirse en un solo buffer.');
      const imported = await backupJob<{ id: string }>('import', { directory: join(root, 'imported'), file: archive, maxSchema: schema, owner: gym.id });
      assert.equal(imported.id, copy.id);
      await assert.rejects(backupJob('inspect', { directory: join(root, 'imported'), id: copy.id, maxSchema: schema, owner: crypto.randomUUID() }), /otro gimnasio/);
      assert.ok(ticks > 0, 'La creación y verificación deben ceder el hilo principal.');
    } finally { clearInterval(clock); }
  });
});

test('una descarga detenida conserva su instantánea y permite escribir en el mismo gimnasio', async t => {
  const f = await fixture(t);
  await f.app.tenants.withTenant(f.gym, async ctx => {
    const insert = ctx.db.raw.prepare("INSERT INTO people(id,name,document,kind,status,created_at,notes) VALUES(?,?,?,'employee','active',?,?)");
    ctx.db.raw.exec('BEGIN');
    for (let i = 0; i < 20000; i++) insert.run('p' + i, 'Persona ' + i, 'D' + i, Date.now(), 'x'.repeat(512));
    ctx.db.raw.exec('COMMIT');
  });
  let incoming!: IncomingMessage;
  const ready = new Promise<void>((resolve, reject) => {
    const call = get(f.app.url + `/api/gyms/${f.gym.id}/sync/snapshot`, {
      headers: { Authorization: 'Bearer ' + f.pair.token, 'Accept-Encoding': 'identity', 'X-GymPASS-Product-Costs': '1' },
    }, response => { incoming = response; incoming.pause(); resolve(); });
    call.on('error', reject);
  });
  await ready;
  assert.equal(incoming.statusCode, 200);
  const write = f.app.tenants.withTenant(f.gym, async ctx => { ctx.db.raw.prepare("UPDATE settings SET name='Durante descarga' WHERE id=1").run(); });
  const writable = await Promise.race([write.then(() => true), setTimeout(2000, false)]);
  const chunks: Buffer[] = [];
  const finished = new Promise<void>((resolve, reject) => {
    incoming.on('data', chunk => chunks.push(chunk)); incoming.once('end', resolve); incoming.once('error', reject);
  });
  incoming.resume();
  await finished; await write;
  assert.equal(writable, true, 'Una descarga lenta no debe retener la cola de recepción.');
  const snapshot = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(snapshot.tables.find((table: any) => table.name === 'settings').rows[0].name, f.gym.name);
  assert.equal(snapshot.tables.find((table: any) => table.name === 'people').rows.length, 20000);
});

test('el lector móvil limita eventos desde SQL y conserva las entradas vigentes fuera de los últimos diez mil', async t => {
  const f = await fixture(t);
  const mobile = await f.app.tenants.withTenant(f.gym, async ctx => {
    const { auth } = authorizeReplica(f.app.store, ctx, f.pair.token);
    const pair = pairReplica(ctx, auth, { name: 'Lector', kind: 'mobile' }, f.app.store.linkedCredentialRevision(auth.user.id));
    const insert = ctx.db.raw.prepare("INSERT INTO events(request_key,payload_hash,person_name,zone_id,zone_name,direction,method,allowed,reason,actor,occurred_at,local_date) VALUES(?,?,'Persona','general','General',?,'qr',1,'OK','Prueba',?,'2026-11-13')");
    ctx.db.raw.exec('BEGIN');
    for (let i = 0; i < 10020; i++) insert.run('reader-' + i, 'a'.repeat(64), i === 0 ? 'entry' : 'exit', i === 0 ? Date.now() + 86400000 : Date.now() + i);
    ctx.db.raw.exec('COMMIT');
    return pair;
  });
  const expected = await f.app.tenants.withTenant(f.gym, async ctx => {
    const { device, auth } = authorizeReplica(f.app.store, ctx, mobile.token);
    return replicaSnapshot(ctx, device, auth, true);
  });
  const response = await fetch(f.app.url + `/api/gyms/${f.gym.id}/sync/snapshot`, {
    headers: { Authorization: 'Bearer ' + mobile.token, 'X-GymPASS-Product-Costs': '1' },
  });
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  const events = snapshot.tables.find((table: any) => table.name === 'events').rows;
  assert.equal(events.length, 10001);
  assert.ok(events.some((row: any) => row.request_key === 'reader-0'));
  assert.deepEqual(events.map((row: any) => row.id).sort((a: number, b: number) => a - b), expected.tables.find(table => table.name === 'events')!.rows.map(row => row.id).sort((a, b) => Number(a) - Number(b)));
  assert.equal(snapshot.assets, undefined);
  assert.equal(snapshot.tables.find((table: any) => table.name === 'settings').rows[0].recovery_hash, '');
});

test('la plataforma reutiliza archivos inmutables sin enlazar los datos activos ni duplicar el programa diario', async t => {
  const root = temporary(t), manager = new TenantManager(root), store = new PlatformStore(root);
  t.after(async () => { await manager.close(); store.close(); cleanup(root); });
  const gym = { id: crypto.randomUUID(), name: 'Copias' };
  manager.provision(gym);
  const photo = crypto.randomUUID() + '.webp';
  const live = join(root, 'tenants', gym.id, 'photos', photo);
  mkdirSync(join(root, 'tenants', gym.id, 'photos'));
  writeFileSync(live, 'Foto original');
  const first = await manager.snapshotPlatform(store.raw);
  await setTimeout(2);
  const second = await manager.snapshotPlatform(store.raw);
  const path = (id: string) => join(root, 'platform-backups', id, 'tenants', gym.id, 'photos', photo);
  assert.equal(statSync(path(first.id)).ino, statSync(path(second.id)).ino);
  assert.notEqual(statSync(path(first.id)).ino, statSync(live).ino);
  writeFileSync(live, 'Foto cambiada');
  assert.equal(readFileSync(path(first.id), 'utf8'), 'Foto original');
  await manager.maintain([gym]);
  await manager.withTenant(gym, async ctx => assert.equal(ctx.backups.list().filter(copy => copy.kind === 'automatic').length, 0));
  const manifest = JSON.parse(readFileSync(join(root, 'platform-backups', second.id, 'complete.json'), 'utf8'));
  assert.equal(createHash('sha256').update(readFileSync(path(second.id))).digest('hex'), manifest.files['tenants/' + gym.id + '/photos/' + photo]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteDatabase, migrateDatabase } from '../server/database.ts';

const migrationsDirectory = fileURLToPath(new URL('../server/migrations/', import.meta.url));
// Read every migration from disk so adding one does not require editing these tests.
const migrations = readdirSync(migrationsDirectory)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => ({
    name,
    version: Number(name.slice(0, 3)),
    sql: readFileSync(join(migrationsDirectory, name), 'utf8'),
  }));
const base = migrations[0].sql;
const latestVersion = migrations.at(-1)!.version;
const output = fileURLToPath(new URL('../output/', import.meta.url));

function fixture(t: { after: (fn: () => void) => void }) {
  mkdirSync(output, { recursive: true });
  const directory = mkdtempSync(join(output, 'migrations-'));
  t.after(() => {
    if (!resolve(directory).startsWith(resolve(output) + sep + 'migrations-')) throw Error('Ruta temporal inválida');
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  writeFileSync(join(directory, '001_base.sql'), base);
  return directory;
}

test('Migraciones: una base nueva tiene el esquema actual y conserva las claves foráneas', (t) => {
  const db = new SqliteDatabase(':memory:');
  const original = new DatabaseSync(':memory:');
  t.after(() => {
    db.close();
    original.close();
  });
  for (const migration of migrations) {
    original.exec(migration.sql);
    original.prepare('INSERT OR IGNORE INTO schema_version VALUES(?)').run(migration.version);
  }
  const schema = 'SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name';
  assert.deepEqual(db.raw.prepare(schema).all(), original.prepare(schema).all());
  assert.equal(db.raw.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
  assert.deepEqual(
    db.raw
      .prepare('SELECT version FROM schema_version')
      .all()
      .map((row) => row.version),
    migrations.map((migration) => migration.version),
  );
});

test('Migraciones: una base existente versión 1 conserva personas, eventos y sesiones al reabrir', (t) => {
  const directory = fixture(t);
  const filename = join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec(base);
  legacy.exec(`
    INSERT INTO settings(id,owner,name) VALUES(1,'owner','Organización existente');
    INSERT INTO members(email,user_id,name,role,password_hash) VALUES('admin@example.test','owner','Admin','admin','hash');
    INSERT INTO sessions(hash,user_id,expires) VALUES('session','owner',9999999999999);
    INSERT INTO zones(id,name) VALUES('main','Principal');
    INSERT INTO people(id,name,document,created_at) VALUES('ana','Ana','123',1);
    INSERT INTO events(request_key,payload_hash,person_id,person_name,zone_id,zone_name,direction,method,allowed,reason,actor,occurred_at,local_date)
      VALUES('request','payload','ana','Ana','main','Principal','entry','manual',1,'OK','owner',1,'2026-10-25');
  `);
  legacy.close();
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = new SqliteDatabase(filename);
    try {
      assert.equal(db.raw.prepare('SELECT name FROM settings').get()?.name, 'Organización existente');
      assert.equal(db.raw.prepare('SELECT name FROM people').get()?.name, 'Ana');
      assert.equal(db.raw.prepare('SELECT person_name FROM events').get()?.person_name, 'Ana');
      assert.equal(db.raw.prepare('SELECT hash FROM sessions').get()?.hash, 'session');
      assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM schema_version').get()?.n, latestVersion);
      assert.equal(db.raw.prepare('SELECT photo_path FROM people').get()?.photo_path, null);
      assert.equal(db.raw.prepare('SELECT brand_color FROM settings').get()?.brand_color, '#2563eb');
      assert.equal(db.raw.prepare('SELECT auto_close_hours FROM settings').get()?.auto_close_hours, 24);
      assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM calendar_exceptions').get()?.n, 0);
      assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM attendance_periods').get()?.n, 0);
    } finally {
      db.close();
    }
  }
});

test('Migraciones: aplica pendientes por número y solo una vez', (t) => {
  const directory = fixture(t);
  writeFileSync(join(directory, '003_name_index.sql'), 'CREATE INDEX people_test_name ON people(name);');
  writeFileSync(join(directory, '002_photo.sql'), 'ALTER TABLE people ADD COLUMN photo_path TEXT;');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(base);
  migrateDatabase(db, directory);
  migrateDatabase(db, directory);
  assert.deepEqual(
    db
      .prepare('SELECT version FROM schema_version ORDER BY version')
      .all()
      .map((row) => row.version),
    [1, 2, 3],
  );
  assert.ok(
    db
      .prepare('PRAGMA table_info(people)')
      .all()
      .some((row) => row.name === 'photo_path'),
  );
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='people_test_name'").get());
});

test('Migraciones: un fallo revierte todas las pendientes y permite reintentar', (t) => {
  const directory = fixture(t);
  writeFileSync(join(directory, '002_photo.sql'), 'ALTER TABLE people ADD COLUMN photo_path TEXT;');
  writeFileSync(join(directory, '003_invalid.sql'), 'INSERT INTO missing_table VALUES(1);');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(base);
  assert.throws(() => migrateDatabase(db, directory), /missing_table/);
  assert.equal(db.prepare('SELECT MAX(version) version FROM schema_version').get()?.version, 1);
  assert.ok(
    !db
      .prepare('PRAGMA table_info(people)')
      .all()
      .some((row) => row.name === 'photo_path'),
  );
  writeFileSync(join(directory, '003_invalid.sql'), 'CREATE INDEX people_test_name ON people(name);');
  migrateDatabase(db, directory);
  assert.equal(db.prepare('SELECT MAX(version) version FROM schema_version').get()?.version, 3);
});

test('Migraciones: una instalación nueva fallida tampoco deja un esquema parcial', (t) => {
  const directory = fixture(t);
  writeFileSync(join(directory, '002_invalid.sql'), 'SELECT * FROM missing_table;');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  assert.throws(() => migrateDatabase(db, directory), /missing_table/);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length, 0);
});

test('Migraciones: rechaza bases futuras sin modificarlas y libera la conexión', (t) => {
  const directory = fixture(t);
  const filename = join(directory, 'future.sqlite');
  const future = new DatabaseSync(filename);
  future.exec(base);
  future.exec("INSERT INTO schema_version VALUES(99); INSERT INTO zones(id,name) VALUES('future','Conservar');");
  future.close();
  assert.throws(() => new SqliteDatabase(filename), /versión más reciente/);
  const check = new DatabaseSync(filename);
  try {
    assert.equal(check.prepare('SELECT MAX(version) version FROM schema_version').get()?.version, 99);
    assert.equal(check.prepare('SELECT name FROM zones').get()?.name, 'Conservar');
    check.exec('BEGIN EXCLUSIVE; ROLLBACK;');
  } finally {
    check.close();
  }
});

test('Migraciones: rechaza huecos, versiones duplicadas y nombres inválidos antes de escribir', (t) => {
  const directory = fixture(t);
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  writeFileSync(join(directory, '003_gap.sql'), 'SELECT 1;');
  assert.throws(() => migrateDatabase(db, directory), /consecutivas/);
  rmSync(join(directory, '003_gap.sql'));
  writeFileSync(join(directory, '001_duplicate.sql'), 'SELECT 1;');
  assert.throws(() => migrateDatabase(db, directory), /consecutivas/);
  rmSync(join(directory, '001_duplicate.sql'));
  writeFileSync(join(directory, 'invalid.sql'), 'SELECT 1;');
  assert.throws(() => migrateDatabase(db, directory), /Nombre de migración inválido/);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length, 0);
});

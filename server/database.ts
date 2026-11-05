import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database, Statement } from '../lib/database.ts';
import { searchFold } from '../lib/domain.ts';

export function migrateDatabase(
  db: DatabaseSync,
  directory = fileURLToPath(new URL('./migrations/', import.meta.url)),
) {
  const migrations = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => {
      const match = /^(\d{3,})_[a-z0-9_]+\.sql$/.exec(name);
      if (!match) throw Error(`Nombre de migración inválido: ${name}`);
      return { name, version: Number(match[1]) };
    })
    .sort((a, b) => a.version - b.version);

  if (!migrations.length || migrations.some((migration, index) => migration.version !== index + 1)) {
    throw Error('Las migraciones deben ser consecutivas, sin duplicados, empezando por 001.');
  }

  // Read the version after acquiring the write lock: another process may have migrated while we waited.
  db.exec('BEGIN IMMEDIATE');
  try {
    const hasVersion = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get();
    const currentVersion = hasVersion
      ? Number(db.prepare('SELECT MAX(version) version FROM schema_version').get()?.version ?? 0)
      : 0;
    if (currentVersion > migrations.at(-1)!.version) {
      throw Error('La base de datos pertenece a una versión más reciente.');
    }

    db.exec('CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY)');
    for (const migration of migrations) {
      if (migration.version <= currentVersion) continue;
      db.exec(readFileSync(join(directory, migration.name), 'utf8'));
      // 001 retains the original schema verbatim, including its version-1 INSERT.
      db.prepare('INSERT OR IGNORE INTO schema_version(version) VALUES(?)').run(migration.version);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

class Prepared implements Statement {
  db: DatabaseSync;
  sql: string;
  args: SQLInputValue[];
  constructor(db: DatabaseSync, sql: string, args: SQLInputValue[] = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args: SQLInputValue[]) {
    return new Prepared(this.db, this.sql, args);
  }
  async all<T>() {
    return { results: this.db.prepare(this.sql).all(...this.args) as T[] };
  }
  async first<T>() {
    return (this.db.prepare(this.sql).get(...this.args) as T) || null;
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(r.changes) } };
  }
  execute() {
    return this.db.prepare(this.sql).run(...this.args);
  }
}
export class SqliteDatabase implements Database {
  raw: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.raw = new DatabaseSync(filename);
    try {
      this.raw.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      migrateDatabase(this.raw);
      this.raw.function('search_fold', { deterministic: true }, (value) => searchFold(String(value ?? '')));
    } catch (error) {
      this.raw.close();
      throw error;
    }
  }
  prepare(sql: string) {
    return new Prepared(this.raw, sql);
  }
  async batch(statements: Statement[]) {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((s) => (s as Prepared).execute());
      this.raw.exec('COMMIT');
      return results;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.raw.close();
  }
}

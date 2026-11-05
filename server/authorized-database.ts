import type { Database, Statement } from '../lib/database.ts';

// Recheck immediately before executing SQL: request bodies and image uploads may outlive a permission.
export function authorizedDatabase(database: Database, authorize: () => void): Database {
  const originals = new WeakMap<Statement, Statement>();
  const wrap = (statement: Statement): Statement => {
    const wrapped: Statement = {
      bind: (...args) => wrap(statement.bind(...args)),
      async all<T>() {
        authorize();
        return statement.all<T>();
      },
      async first<T>() {
        authorize();
        return statement.first<T>();
      },
      async run() {
        authorize();
        return statement.run();
      },
    };
    originals.set(wrapped, statement);
    return wrapped;
  };
  return {
    prepare: (sql) => wrap(database.prepare(sql)),
    async batch(statements) {
      authorize();
      return database.batch(
        statements.map((statement) => {
          const original = originals.get(statement);
          if (!original) throw Error('La sentencia no pertenece al contexto autorizado.');
          return original;
        }),
      );
    },
  };
}

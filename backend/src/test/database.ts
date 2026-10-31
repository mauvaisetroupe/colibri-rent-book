import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import pg from 'pg'

import { MIGRATIONS_DIR } from '../schemaVersion.js'

/**
 * Database used by integration tests.
 *
 * Only TEST_DATABASE_URL is used, never the DATABASE_* variables of .env: tests drop and recreate the whole
 * schema. As a second safety net, the database name must end with `_test`.
 */
export const skipWithoutDatabase = process.env.TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set'

export function createTestPool() {
  const url = process.env.TEST_DATABASE_URL
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set')
  }
  const name = new URL(url).pathname.slice(1)
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to run tests on database "${name}": its name must end with _test`)
  }
  return new pg.Pool({ connectionString: url })
}

/**
 * Recreates the database from the versioned migrations (V<n>__*.sql, in the order of their number, as Flyway does,
 * without its history table), then loads TEST_SEED_FILES (SQL files separated by « : », the data of the operations
 * that run the tests, e.g. its buildings, invoices, stays and extractors).
 */
export async function resetDatabase(pool: pg.Pool) {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  const migrations = (await readdir(MIGRATIONS_DIR))
    .filter((name) => /^V\d+__.+\.sql$/.test(name))
    .sort((a, b) => Number(a.slice(1, a.indexOf('__'))) - Number(b.slice(1, b.indexOf('__'))))
  for (const name of migrations) {
    await pool.query(await readFile(join(MIGRATIONS_DIR, name), 'utf8'))
  }
  for (const file of (process.env.TEST_SEED_FILES ?? '').split(':').filter(Boolean)) {
    await pool.query(await readFile(isAbsolute(file) ? file : resolve(file), 'utf8'))
  }
}

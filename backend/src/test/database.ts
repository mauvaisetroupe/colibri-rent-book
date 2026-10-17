import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import pg from 'pg'

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

const backendDir = new URL('../../', import.meta.url)

/**
 * Recreates the database from schema.sql, then loads TEST_SEED_FILES (SQL files separated by « : », the data of the
 * operations that run the tests, e.g. its buildings, invoices and stays) and the extractors shipped as models.
 */
export async function resetDatabase(pool: pg.Pool) {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await pool.query(await readFile(new URL('schema.sql', backendDir), 'utf8'))
  for (const file of (process.env.TEST_SEED_FILES ?? '').split(':').filter(Boolean)) {
    await pool.query(await readFile(isAbsolute(file) ? file : resolve(file), 'utf8'))
  }
  await pool.query(await readFile(new URL('seed/extracteurs.sql', backendDir), 'utf8'))
}

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, beforeEach, describe, test } from 'node:test'

import pg from 'pg'

import { checkSchemaVersion, expectedSchemaVersion, SchemaVersionError } from './schemaVersion.js'
import { createTestPool, skipWithoutDatabase } from './test/database.js'

describe('expected schema version', () => {
  test('is the highest migration of the repository', async () => {
    assert.ok(await expectedSchemaVersion() >= 1)
  })

  test('counts the versioned and baseline migrations only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'migrations-'))
    try {
      for (const name of ['V001__a.sql', 'B003__schema.sql', 'V004__b.sql', 'R__extractors.sql', 'README.md', '005_old.sql']) {
        await writeFile(join(dir, name), '')
      }
      assert.equal(await expectedSchemaVersion(dir), 4)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// A schema of its own (search_path), with a stand-in for the history table of Flyway: only the columns the API reads
const SCHEMA = 'schema_version_test'

describe('schema version check', { skip: skipWithoutDatabase }, () => {
  let admin: pg.Pool
  let pool: pg.Pool

  beforeEach(async () => {
    admin ??= createTestPool()
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`)
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${SCHEMA}` })
  })

  afterEach(async () => {
    await pool.end()
  })

  after(async () => {
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await admin?.end()
  })

  const history = async (rows: [string | null, boolean][]) => {
    await pool.query('CREATE TABLE flyway_schema_history (version text, success boolean NOT NULL)')
    for (const [version, success] of rows) {
      await pool.query('INSERT INTO flyway_schema_history (version, success) VALUES ($1, $2)', [version, success])
    }
  }

  test('refuses a database never migrated by Flyway', async () => {
    await assert.rejects(checkSchemaVersion(pool, 1),
      (error: Error) => error instanceof SchemaVersionError && error.message.includes('image de migration'))
  })

  test('accepts the expected version', async () => {
    // Baseline at 1, then a repeatable migration (no version)
    await history([['1', true], [null, true]])
    assert.deepEqual(await checkSchemaVersion(pool, 1), { current: 1, warning: undefined })
  })

  test('compares versions as numbers', async () => {
    await history([['1', true], ['10', true]])
    assert.equal((await checkSchemaVersion(pool, 10)).current, 10)
  })

  test('refuses an older database', async () => {
    await history([['1', true]])
    await assert.rejects(checkSchemaVersion(pool, 2), /version 1, cette API demande 2/)
  })

  test('refuses a failed migration', async () => {
    await history([['1', true], ['2', false]])
    await assert.rejects(checkSchemaVersion(pool, 1), /Migration 2 en échec/)
  })

  test('accepts a newer database with a warning', async () => {
    await history([['1', true], ['2', true]])
    const result = await checkSchemaVersion(pool, 1)
    assert.equal(result.current, 2)
    assert.match(result.warning!, /plus récent/)
  })
})

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import type pg from 'pg'

import { buildApp } from '../app.js'
import { createTestPool, skipWithoutDatabase } from '../test/database.js'

describe('GET /api/health', { skip: skipWithoutDatabase }, () => {
  let pool: pg.Pool
  let app: Awaited<ReturnType<typeof buildApp>>

  before(async () => {
    pool = createTestPool()
    app = await buildApp({ db: pool, storageDir: 'unused' })
  })

  after(async () => {
    await app.close()
    await pool.end()
  })

  test('answers ok', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().status, 'ok')
    assert.match(response.json().version, /^(dev|[0-9a-f]{7}|\d+\.\d+\.\d+)$/)
  })

  test('reaches the database', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health/db' })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().status, 'ok')
  })
})

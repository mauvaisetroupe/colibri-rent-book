import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import type pg from 'pg'

import { buildApp } from '../app.js'
import { createTestPool, resetDatabase, skipWithoutDatabase } from '../test/database.js'

// The deposit of a stay (ADR 0021): paid, then kept to cover an unpaid month and two regularisations (a retention, made
// of payments « depot »), the rest refunded. The retention settles the regularisations, lowers the deposit held, is
// changed from the stay only, never seen at the bank, and is the deposit kept of the tax summary.

describe('deposit of a stay', { skip: skipWithoutDatabase }, () => {
  let pool: pg.Pool
  let app: Awaited<ReturnType<typeof buildApp>>
  let storageDir: string
  let building: number
  let tenancy: number
  const regul: number[] = []

  const sejourLu = async () => (await app.inject(`/api/sejours?building=${building}`)).json()[0]
  const regulLue = async (id: number) => (await app.inject(`/api/regularisations/${id}`)).json()
  const retenue = (lines: object[], date = '2024-12-31') =>
    app.inject({ method: 'PUT', url: `/api/sejours/${tenancy}/retenue`, payload: { date, lines } })

  before(async () => {
    pool = createTestPool()
    await resetDatabase(pool)
    storageDir = await mkdtemp(join(tmpdir(), 'crb-pdf-'))
    app = await buildApp({ db: pool, storageDir })
    building = (await pool.query<{ id: number }>('INSERT INTO building (code, name) VALUES (\'IMM1\', \'Immeuble fictif\') RETURNING id')).rows[0]!.id
    const unit = (await pool.query<{ id: number }>('INSERT INTO unit (building_id, code, charge_shares) VALUES ($1, \'L1\', 100) RETURNING id', [building])).rows[0]!.id
    const tenant = (await pool.query<{ id: number }>('INSERT INTO tenant (name) VALUES (\'Bob Exemple\') RETURNING id')).rows[0]!.id
    tenancy = (await pool.query<{ id: number }>(
      `INSERT INTO tenancy (unit_id, tenant_id, period, security_deposit) VALUES ($1, $2, '[2022-01-01,2025-01-01)', 500) RETURNING id`,
      [unit, tenant])).rows[0]!.id
    // Two regularisations sent: 2023 (300, 100 paid by cheque), 2024 (400)
    for (const [period, balance, envoi] of [['[2023-01-01,2024-01-01)', 300, '2024-03-01'], ['[2024-01-01,2025-01-01)', 400, '2025-03-01']]) {
      regul.push((await pool.query<{ id: number }>(
        `INSERT INTO charge_adjustment (tenancy_id, period, amount_due, advances, sent_on) VALUES ($1, $2, $3, 0, $4) RETURNING id`,
        [tenancy, period, balance, envoi])).rows[0]!.id)
    }
    await pool.query(`INSERT INTO payment (tenancy_id, payment_date, charge_adjustment_id, charge_adjustment, method) VALUES ($1, '2024-04-01', $2, 100, 'cheque')`,
      [tenancy, regul[0]])
  })

  after(async () => {
    await app.close()
    await pool.end()
    await rm(storageDir, { recursive: true, force: true })
  })

  test('a deposit paid without a transfer, then kept for a month and the regularisations', async () => {
    assert.equal((await app.inject({ method: 'POST', url: '/api/depots', payload: { tenancy_id: tenancy, payment_date: '2022-01-01', amount: '500', note: 'agency' } })).statusCode, 201)
    assert.equal((await sejourLu()).deposit_held, '500.00')

    // More than the deposit, or than what a regularisation lacks: refused
    assert.equal((await retenue([{ charge_adjustment_id: regul[1], charge_adjustment: '600' }])).statusCode, 400)
    assert.match((await retenue([{ charge_adjustment_id: regul[0], charge_adjustment: '250' }])).json().message, /reste est 200\.00/)
    assert.match((await retenue([{ month: '2025-02', rent: '10' }])).json().message, /hors du séjour/)

    const r = await retenue([
      { month: '2024-12', rent: '80', charge_advance: '20' },
      { charge_adjustment_id: regul[0], charge_adjustment: '200' },
      { charge_adjustment_id: regul[1], charge_adjustment: '150' },
    ])
    assert.equal(r.statusCode, 200, r.body)
    assert.equal(r.json().length, 3)
    const s = await sejourLu()
    assert.deepEqual([s.deposit_held, s.deposit_retained], ['50.00', '450.00'])
    assert.deepEqual([(await regulLue(regul[0]!)).state, (await regulLue(regul[1]!)).amount_received], ['settled', '150.00'])

    // Replaced as a whole: the same call again does not add up
    assert.equal((await retenue([
      { month: '2024-12', rent: '80', charge_advance: '20' },
      { charge_adjustment_id: regul[0], charge_adjustment: '200' },
      { charge_adjustment_id: regul[1], charge_adjustment: '150' },
    ])).statusCode, 200)
    assert.equal((await sejourLu()).deposit_retained, '450.00')
  })

  test('a retention payment is changed from the stay only, and never linked to the bank', async () => {
    const { rows: [p] } = await pool.query<{ id: number }>(`SELECT id FROM payment WHERE method = 'deposit' LIMIT 1`)
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/paiements/${p!.id}` })).statusCode, 400)
    assert.equal((await app.inject({ method: 'PUT', url: `/api/paiements/${p!.id}`, payload: { tenancy_id: tenancy, payment_date: '2024-12-31', month: '2024-12', rent: '1' } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'POST', url: '/api/paiements', payload: { tenancy_id: tenancy, payment_date: '2024-12-31', month: '2024-11', rent: '1', method: 'deposit' } })).statusCode, 400)
    await assert.rejects(pool.query('UPDATE payment SET bank_transaction_id = 1 WHERE id = $1', [p!.id]))
  })

  test('the deposit cannot fall below the retention; the rest is refunded', async () => {
    const [paid] = (await app.inject(`/api/depots?building=${building}`)).json()
    assert.match((await app.inject({ method: 'DELETE', url: `/api/depots/${paid.id}` })).json().message, /dépasserait le dépôt versé/)
    assert.equal((await app.inject({ method: 'POST', url: '/api/depots', payload: { tenancy_id: tenancy, payment_date: '2025-01-15', amount: '-50' } })).statusCode, 201)
    assert.equal((await sejourLu()).deposit_held, '0.00')
    assert.equal((await app.inject({ method: 'POST', url: '/api/depots', payload: { tenancy_id: tenancy, payment_date: '2025-01-16', amount: '-1' } })).statusCode, 400)
  })

  test('the tax summary of the departure: the retention toward regularisations is the deposit kept, not a payment', async () => {
    const f = (await app.inject(`/api/fiscal?building=${building}&year=2024`)).json()
    const d = f.departs[0]
    assert.equal(d.deposit_retained, '350.00')
    assert.equal(d.versements, '100.00')
  })

  test('the start of the management of the building: the years before are not counted (ADR 0023)', async () => {
    const majImmeuble = (managed_from: string | null) => app.inject({
      method: 'PUT', url: `/api/immeubles/${building}`, payload: { name: 'Immeuble fictif', address: null, managed_from },
    })
    assert.equal((await majImmeuble('2024-01-01')).json().managed_from, '2024-01-01')
    const d = (await app.inject(`/api/fiscal?building=${building}&year=2024`)).json().departs[0]
    // The cheque paid the regularisation 2023, before the start: not counted any more
    assert.deepEqual([d.calculation_start, d.versements], ['2024-01-01', '0'])
    await majImmeuble(null)
    assert.equal((await app.inject(`/api/fiscal?building=${building}&year=2024`)).json().departs[0].calculation_start, '2022-01-01')
  })

  test('removed: the regularisations open again, the deposit is held again', async () => {
    assert.equal((await retenue([])).statusCode, 200)
    const s = await sejourLu()
    assert.deepEqual([s.deposit_held, s.deposit_retained], ['450.00', null])
    assert.equal((await regulLue(regul[0]!)).state, 'pending')
  })
})

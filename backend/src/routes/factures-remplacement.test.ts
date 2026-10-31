import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import Big from 'big.js'
import type pg from 'pg'

import { buildApp } from '../app.js'
import { createTestPool, resetDatabase, skipWithoutDatabase } from '../test/database.js'

// A validated invoice is never changed: it is replaced by another one, or corrected through a draft copy that replaces
// it once validated (ADR 0017). Made-up building, one tenant all year, one sent regularisation.

describe('replacing a validated invoice', { skip: skipWithoutDatabase }, () => {
  let pool: pg.Pool
  let app: Awaited<ReturnType<typeof buildApp>>
  let storageDir: string
  let building: number
  let charge_adjustment: number

  const ligne = (amount: string, end = '2025-12-31') => ({
    category: 'subscription', label: 'Abonnement', start: '2025-01-01', end, kwh: null, amount_excl_tax: null,
    vat_rate: null, amount_incl_tax: amount, allocation: 'recoverable', note: null,
  })

  /** A validated invoice with one line of this amount. */
  async function invoice(number: string, amount: string) {
    const created = await app.inject({
      method: 'POST', url: `/api/factures?building=${building}`,
      payload: { supplier: 'Eau Exemple', energy: 'water', number, invoice_date: '2025-12-31', total_incl_tax: amount },
    })
    assert.equal(created.statusCode, 201, created.body)
    const id = created.json().invoice.id
    const saved = await app.inject({
      method: 'PUT', url: `/api/factures/${id}`,
      payload: { number, invoice_date: '2025-12-31', total_incl_tax: amount, energy: 'water', note: null, lines: [ligne(amount)] },
    })
    assert.equal(saved.statusCode, 200, saved.body)
    const validated = await app.inject({ method: 'POST', url: `/api/factures/${id}/valider` })
    assert.equal(validated.statusCode, 200, validated.body)
    return id as number
  }

  const charges = async () => {
    const d = (await app.inject(`/api/decompte?building=${building}&start=2025-01-01&end=2025-12-31`)).json()
    return d.tenancies.map((s: { balance: string }) => new Big(s.balance).toString())
  }

  before(async () => {
    pool = createTestPool()
    await resetDatabase(pool)
    storageDir = await mkdtemp(join(tmpdir(), 'crb-pdf-'))
    app = await buildApp({ db: pool, storageDir })
    building = (await pool.query<{ id: number }>(
      'INSERT INTO building (code, name) VALUES (\'IMM1\', \'Immeuble fictif\') RETURNING id')).rows[0]!.id
    const unit = (await pool.query<{ id: number }>(
      'INSERT INTO unit (building_id, code, charge_shares) VALUES ($1, \'L1\', 100) RETURNING id', [building])).rows[0]!.id
    const tenant = (await pool.query<{ id: number }>(
      'INSERT INTO tenant (name) VALUES (\'Locataire Exemple\') RETURNING id')).rows[0]!.id
    const tenancy = (await pool.query<{ id: number }>(
      `INSERT INTO tenancy (unit_id, tenant_id, period) VALUES ($1, $2, '[2025-01-01,2026-01-01)') RETURNING id`,
      [unit, tenant])).rows[0]!.id
    charge_adjustment = (await pool.query<{ id: number }>(
      `INSERT INTO charge_adjustment (tenancy_id, period, amount_due, advances, sent_on)
       VALUES ($1, '[2025-01-01,2026-01-01)', 300, 0, '2026-02-01') RETURNING id`, [tenancy])).rows[0]!.id
  })

  after(async () => {
    await app.close()
    await pool.end()
    await rm(storageDir, { recursive: true, force: true })
  })

  test('replaced by another invoice: out of the statement, linked both ways, regularisation to check', async () => {
    const saisie = await invoice('SAISIE-2025', '300')
    const vraie = await invoice('F-2025-1', '320')
    assert.deepEqual(await charges(), ['620'])

    assert.equal((await app.inject({ method: 'POST', url: `/api/factures/${saisie}/remplacer`, payload: { par: vraie } })).statusCode, 400)
    const replaced = await app.inject({
      method: 'POST', url: `/api/factures/${saisie}/remplacer`, payload: { par: vraie, motif: 'Saisie à la main, remplacée par le PDF' },
    })
    assert.equal(replaced.statusCode, 200, replaced.body)
    const r = replaced.json()
    assert.equal(r.invoice.status, 'replaced')
    assert.equal(r.liens.remplacante.id, vraie)
    assert.deepEqual(r.charge_adjustments.map((x: { id: number }) => x.id), [charge_adjustment])
    assert.deepEqual(await charges(), ['320'])
    assert.equal((await app.inject(`/api/factures/${vraie}`)).json().liens.remplacees[0].id, saisie)

    // Never changed nor deleted, never replaced twice
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/factures/${saisie}` })).statusCode, 409)
    assert.equal((await app.inject({
      method: 'POST', url: `/api/factures/${saisie}/remplacer`, payload: { par: vraie, motif: 'encore' },
    })).statusCode, 409)
    // The number of a replaced invoice can be typed again
    const again = await app.inject({
      method: 'POST', url: `/api/factures?building=${building}`,
      payload: { supplier: 'Eau Exemple', energy: 'water', number: 'SAISIE-2025', invoice_date: '2025-12-31', total_incl_tax: '1' },
    })
    assert.equal(again.statusCode, 201, again.body)
    await app.inject({ method: 'DELETE', url: `/api/factures/${again.json().invoice.id}` })
  })

  test('corrected: a draft copy with the same number replaces it once validated', async () => {
    const vraie = (await pool.query<{ id: number }>('SELECT id FROM invoice WHERE number = \'F-2025-1\'')).rows[0]!.id
    const draft = await app.inject({ method: 'POST', url: `/api/factures/${vraie}/corriger` })
    assert.equal(draft.statusCode, 201, draft.body)
    const copie = draft.json()
    assert.deepEqual([copie.invoice.status, copie.invoice.number, copie.liens.corrige.id], ['draft', 'F-2025-1', vraie])
    assert.equal(copie.lines.length, 1)
    // One correction at a time; the original still counts until the draft is validated
    assert.equal((await app.inject({ method: 'POST', url: `/api/factures/${vraie}/corriger` })).statusCode, 409)
    assert.deepEqual(await charges(), ['320'])

    const id = copie.invoice.id
    await app.inject({
      method: 'PUT', url: `/api/factures/${id}`,
      payload: { ...copie.invoice, note: 'période corrigée', lines: [ligne('320', '2025-06-30')] },
    })
    const validated = await app.inject({ method: 'POST', url: `/api/factures/${id}/valider` })
    assert.equal(validated.statusCode, 200, validated.body)
    assert.deepEqual(validated.json().charge_adjustments.map((x: { id: number }) => x.id), [charge_adjustment])
    const ancienne = (await app.inject(`/api/factures/${vraie}`)).json().invoice
    assert.deepEqual([ancienne.status, ancienne.replaced_by, ancienne.replacement_reason], ['replaced', id, 'Corrigée : période corrigée'])
    assert.deepEqual(await charges(), ['320'])
  })

  test('an abandoned correction leaves the original validated', async () => {
    const id = await invoice('F-2025-2', '10')
    const draft = (await app.inject({ method: 'POST', url: `/api/factures/${id}/corriger` })).json()
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/factures/${draft.invoice.id}` })).statusCode, 204)
    assert.equal((await app.inject(`/api/factures/${id}`)).json().invoice.status, 'validated')
  })
})

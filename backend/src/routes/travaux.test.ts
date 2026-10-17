import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { PDFDocument } from 'pdf-lib'
import type pg from 'pg'

import { buildApp } from '../app.js'
import { createTestPool, resetDatabase, skipWithoutDatabase } from '../test/database.js'

// Works paid by the owner (ADR 0015), on a made-up building: deductible according to their nature, in the tax year
// of their payment, with their PDF.

describe('works invoices', { skip: skipWithoutDatabase }, () => {
  let pool: pg.Pool
  let app: Awaited<ReturnType<typeof buildApp>>
  let storageDir: string
  let immeuble: number
  let lot: number

  const creer = (payload: object) => app.inject({ method: 'POST', url: '/api/travaux', payload })
  const base = () => ({
    immeuble_id: immeuble, lot_id: null, fournisseur: 'Menuiserie Exemple', description: 'Fenêtre du séjour',
    nature: 'entretien', date_facture: '2025-11-20', date_paiement: '2025-12-05', montant_ttc: '1250.40', note: null,
  })

  before(async () => {
    pool = createTestPool()
    await resetDatabase(pool)
    storageDir = await mkdtemp(join(tmpdir(), 'crb-pdf-'))
    app = await buildApp({ db: pool, storageDir })
    immeuble = (await pool.query<{ id: number }>(
      'INSERT INTO immeuble (code, nom) VALUES (\'IMM1\', \'Immeuble fictif\') RETURNING id')).rows[0]!.id
    lot = (await pool.query<{ id: number }>(
      'INSERT INTO lot (immeuble_id, code, tantiemes) VALUES ($1, \'L1\', 100) RETURNING id', [immeuble])).rows[0]!.id
  })

  after(async () => {
    await app.close()
    await pool.end()
    await rm(storageDir, { recursive: true, force: true })
  })

  test('works are recorded, checked, changed and listed', async () => {
    const created = await creer(base())
    assert.equal(created.statusCode, 201, created.body)
    assert.equal(created.json().deductible, true)
    assert.equal((await creer({ ...base(), nature: 'agrandissement' })).statusCode, 400)
    assert.equal((await creer({ ...base(), date_paiement: '2025-10-01' })).statusCode, 400)
    assert.equal((await creer({ ...base(), lot_id: 999999 })).statusCode, 400)

    const changed = await app.inject({
      method: 'PUT', url: `/api/travaux/${created.json().id}`, payload: { ...base(), lot_id: lot, montant_ttc: '1300' },
    })
    assert.equal(changed.statusCode, 200, changed.body)
    assert.deepEqual([changed.json().lot, changed.json().montant_ttc], ['L1', '1300.00'])
    assert.equal((await app.inject(`/api/travaux?immeuble=${immeuble}`)).json().length, 1)
  })

  test('the tax summary of the year: paid works, deductible ones for line 224, unpaid ones apart', async () => {
    await creer({ ...base(), description: 'Extension', nature: 'construction', montant_ttc: '20000' })
    await creer({ ...base(), description: 'Toiture', nature: 'amelioration', montant_ttc: '3000.50' })
    await creer({ ...base(), description: 'Devis accepté', date_paiement: null, montant_ttc: '500' })
    await creer({ ...base(), description: 'Payé l\'année suivante', date_facture: '2025-12-20', date_paiement: '2026-01-10' })

    const fiscal = (await app.inject(`/api/fiscal?immeuble=${immeuble}&annee=2025`)).json()
    assert.deepEqual(fiscal.travaux.map((t: { description: string }) => t.description).sort(),
      ['Extension', 'Fenêtre du séjour', 'Toiture'])
    assert.equal(fiscal.total_travaux_deductibles, '4300.5')
    assert.deepEqual(fiscal.travaux_non_payes.map((t: { description: string }) => t.description), ['Devis accepté'])
  })

  test('the PDF of the invoice is attached, served, and removed with the works', async () => {
    const id = (await creer(base())).json().id
    const pdf = await PDFDocument.create()
    pdf.addPage()
    const content = Buffer.from(await pdf.save())
    const boundary = 'b'
    const attached = await app.inject({
      method: 'POST', url: `/api/travaux/${id}/pdf`,
      payload: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="f.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
        content, Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    })
    assert.equal(attached.json().pdf, true, attached.body)
    assert.deepEqual((await app.inject(`/api/travaux/${id}/pdf`)).rawPayload, content)

    assert.equal((await app.inject({ method: 'DELETE', url: `/api/travaux/${id}` })).statusCode, 204)
    assert.equal((await app.inject(`/api/travaux/${id}/pdf`)).statusCode, 404)
  })
})

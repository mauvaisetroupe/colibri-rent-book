import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { PDFDocument } from 'pdf-lib'
import type pg from 'pg'

import { buildApp } from '../app.js'
import { createTestPool, resetDatabase, skipWithoutDatabase } from '../test/database.js'

// Works paid by the owner (ADR 0015, 0019), on a made-up building: deductible according to their nature, paid by bank
// movements only, each in the tax year of its movement, with their PDF.

describe('works invoices', { skip: skipWithoutDatabase }, () => {
  let pool: pg.Pool
  let app: Awaited<ReturnType<typeof buildApp>>
  let storageDir: string
  let building: number
  let unit: number
  let releve: number
  let position = 0

  const creer = (payload: object) => app.inject({ method: 'POST', url: '/api/travaux', payload })
  const base = () => ({
    building_id: building, unit_id: null, supplier: 'Menuiserie Exemple', description: 'Fenêtre du séjour',
    nature: 'maintenance', invoice_date: '2025-11-20', total_incl_tax: '1250.40', note: null,
  })
  /** A debit of the bank statement, linked to the invoice: its payment. */
  async function payer(works_invoice: number, date: string, amount: string) {
    const m = (await pool.query<{ id: number }>(
      'INSERT INTO bank_transaction (bank_statement_id, position, transaction_date, label, amount) VALUES ($1, $2, $3, \'VIR ARTISAN\', $4) RETURNING id',
      [releve, position++, date, `-${amount}`])).rows[0]!.id
    const r = await app.inject({ method: 'POST', url: `/api/mouvements/${m}/lier`, payload: { works_invoice_id: works_invoice } })
    assert.equal(r.statusCode, 200, r.body)
    return m
  }

  before(async () => {
    pool = createTestPool()
    await resetDatabase(pool)
    storageDir = await mkdtemp(join(tmpdir(), 'crb-pdf-'))
    app = await buildApp({ db: pool, storageDir })
    building = (await pool.query<{ id: number }>(
      'INSERT INTO building (code, name) VALUES (\'IMM1\', \'Immeuble fictif\') RETURNING id')).rows[0]!.id
    unit = (await pool.query<{ id: number }>(
      'INSERT INTO unit (building_id, code, charge_shares) VALUES ($1, \'L1\', 100) RETURNING id', [building])).rows[0]!.id
    await pool.query('INSERT INTO supplier (name) VALUES (\'Banque Exemple\')')
    releve = (await pool.query<{ id: number }>(
      `INSERT INTO bank_statement (supplier_id, account, statement_date, previous_balance, new_balance)
       SELECT id, '001', '2030-01-01', 0, 0 FROM supplier WHERE name = 'Banque Exemple' RETURNING id`)).rows[0]!.id
  })

  after(async () => {
    await app.close()
    await pool.end()
    await rm(storageDir, { recursive: true, force: true })
  })

  test('works are recorded, checked, changed and listed', async () => {
    const created = await creer(base())
    assert.equal(created.statusCode, 201, created.body)
    assert.deepEqual([created.json().deductible, created.json().remaining, created.json().payments], [true, '1250.40', []])
    assert.equal((await creer({ ...base(), nature: 'agrandissement' })).statusCode, 400)
    assert.equal((await creer({ ...base(), unit_id: 999999 })).statusCode, 400)

    const changed = await app.inject({
      method: 'PUT', url: `/api/travaux/${created.json().id}`, payload: { ...base(), unit_id: unit, total_incl_tax: '1300' },
    })
    assert.equal(changed.statusCode, 200, changed.body)
    assert.deepEqual([changed.json().unit, changed.json().total_incl_tax], ['L1', '1300.00'])
    assert.equal((await app.inject(`/api/travaux?building=${building}`)).json().length, 1)
    await payer(created.json().id, '2025-12-05', '1300')
  })

  test('the tax summary of the year: paid works, deductible ones for line 224, unpaid ones apart', async () => {
    await payer((await creer({ ...base(), description: 'Extension', nature: 'construction', total_incl_tax: '20000' })).json().id, '2025-12-05', '20000')
    await payer((await creer({ ...base(), description: 'Toiture', nature: 'improvement', total_incl_tax: '3000.50' })).json().id, '2025-12-06', '3000.50')
    await creer({ ...base(), description: 'Devis accepté', total_incl_tax: '500' })
    const suivante = (await creer({ ...base(), description: 'Payé l\'année suivante', invoice_date: '2025-12-20' })).json().id
    await payer(suivante, '2026-01-10', '1250.40')

    const fiscal = (await app.inject(`/api/fiscal?building=${building}&year=2025`)).json()
    assert.deepEqual(fiscal.works_invoice.map((t: { description: string }) => t.description).sort(),
      ['Extension', 'Fenêtre du séjour', 'Toiture'])
    assert.equal(fiscal.total_deductible_works, '4300.5')
    // Unpaid at the end of 2025: the quote, and the invoice paid in January 2026
    assert.deepEqual(fiscal.unpaid_works.map((t: { description: string }) => t.description), ['Devis accepté', 'Payé l\'année suivante'])
  })

  test('works paid by two transfers: each payment in its year, no more than the invoice', async () => {
    const id = (await creer({ ...base(), description: 'Ravalement', invoice_date: '2027-03-01', total_incl_tax: '5000' })).json().id
    await payer(id, '2027-02-15', '1500')
    // The balance: a transfer of more than what remains pays only the rest (the other part for another invoice)
    const balance = await payer(id, '2028-01-10', '4000')
    const lu = (await app.inject(`/api/travaux?building=${building}`)).json().find((t: { id: number }) => t.id === id)
    assert.deepEqual([lu.paid, lu.remaining, lu.payments.map((r: { amount: string }) => r.amount)], ['5000.00', '0.00', ['1500.00', '3500.00']])
    const fiscal = async (year: number) => (await app.inject(`/api/fiscal?building=${building}&year=${year}`)).json()
    const a2027 = await fiscal(2027)
    assert.deepEqual(a2027.works_invoice.map((t: { amount: string }) => t.amount), ['1500.00'])
    assert.deepEqual(a2027.unpaid_works.filter((t: { id: number }) => t.id === id).map((t: { amount: string }) => t.amount), ['3500.00'])
    assert.equal((await fiscal(2028)).total_deductible_works, '3500')

    // Paid in full: nothing more; a lower amount than what was paid is refused
    assert.equal((await app.inject({ method: 'POST', url: `/api/mouvements/${balance}/lier`, payload: { works_invoice_id: id } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'PUT', url: `/api/travaux/${id}`, payload: { ...base(), total_incl_tax: '4000' } })).statusCode, 400)
    // Detached: the payment goes, the invoice has a rest again
    const reglement = lu.payments[1].id
    await app.inject({ method: 'POST', url: `/api/mouvements/${balance}/delier`, payload: { works_invoice_payment_id: reglement } })
    assert.equal((await app.inject(`/api/travaux?building=${building}`)).json().find((t: { id: number }) => t.id === id).remaining, '3500.00')
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

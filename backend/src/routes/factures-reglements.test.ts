import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import type pg from 'pg'

import { buildApp } from '../app.js'
import { createTestPool, resetDatabase, skipWithoutDatabase } from '../test/database.js'

// Invoices of charges paid by bank movements (ADR 0022), on a made-up building with made-up amounts: a debit of the
// same amount, a water invoice paid in two transfers naming it, the payments of a replaced invoice moving to the one replacing it.

describe('payments of invoices', { skip: skipWithoutDatabase }, () => {
  let pool: pg.Pool
  let app: Awaited<ReturnType<typeof buildApp>>
  let storageDir: string
  let building: number
  let releve: number
  let position = 0

  /** A validated invoice with one line of this amount. */
  async function invoice(supplier: string, energy: string, number: string, amount: string) {
    const created = await app.inject({
      method: 'POST', url: `/api/factures?building=${building}`,
      payload: { supplier, energy, number, invoice_date: '2026-03-20', total_incl_tax: amount },
    })
    assert.equal(created.statusCode, 201, created.body)
    const id = created.json().invoice.id as number
    const saved = await app.inject({
      method: 'PUT', url: `/api/factures/${id}`,
      payload: {
        number, invoice_date: '2026-03-20', total_incl_tax: amount, energy, note: null,
        lines: [{ category: 'consumption', label: 'Consommation', start: '2026-01-01', end: '2026-02-28', kwh: null,
          amount_excl_tax: null, vat_rate: null, amount_incl_tax: amount, allocation: 'recoverable', note: null }],
      },
    })
    assert.equal(saved.statusCode, 200, saved.body)
    assert.equal((await app.inject({ method: 'POST', url: `/api/factures/${id}/valider` })).statusCode, 200)
    return id
  }

  async function debit(date: string, label: string, amount: string, category: string | null = null) {
    return (await pool.query<{ id: number }>(
      `INSERT INTO bank_transaction (bank_statement_id, position, transaction_date, label, amount, category)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [releve, position++, date, label, `-${amount}`, category])).rows[0]!.id
  }

  const bank_transaction = async (id: number) =>
    (await app.inject(`/api/mouvements?status=tous`)).json().find((m: { id: number }) => m.id === id)
  const resume = async (id: number) =>
    (await app.inject(`/api/factures?building=${building}`)).json().find((f: { id: number }) => f.id === id)

  before(async () => {
    pool = createTestPool()
    await resetDatabase(pool)
    storageDir = await mkdtemp(join(tmpdir(), 'crb-pdf-'))
    app = await buildApp({ db: pool, storageDir })
    building = (await pool.query<{ id: number }>(
      'INSERT INTO building (code, name) VALUES (\'IMM1\', \'Immeuble fictif\') RETURNING id')).rows[0]!.id
    await pool.query('INSERT INTO supplier (name) VALUES (\'Banque Exemple\'), (\'Énergie Exemple\'), (\'Eau Exemple\')')
    releve = (await pool.query<{ id: number }>(
      `INSERT INTO bank_statement (supplier_id, account, statement_date, previous_balance, new_balance)
       SELECT id, '001', '2030-01-01', 0, 0 FROM supplier WHERE name = 'Banque Exemple' RETURNING id`)).rows[0]!.id
  })

  after(async () => {
    await app.close()
    await pool.end()
    await rm(storageDir, { recursive: true, force: true })
  })

  test('a debit of the same amount is proposed, linked, categorised; the invoice is paid', async () => {
    const f = await invoice('Énergie Exemple', 'electricity', '90000000001', '1234.56')
    const m = await debit('2026-04-02', 'PRLV SEPA ENERGIE', '1234.56')
    assert.deepEqual((await resume(f)).remaining, '1234.56')
    const avant = await bank_transaction(m)
    assert.deepEqual(avant.candidates.map((p: { type: string, id: number }) => [p.type, p.id]), [['invoice', f]])
    assert.equal(avant.status, 'to_categorise')
    // Categorised without its invoice, it is to link (« incomplet »)
    assert.equal((await app.inject({ method: 'PUT', url: `/api/mouvements/${m}/categorie`, payload: { category: 'energy' } })).json().status, 'incomplet')

    const lie = await app.inject({ method: 'POST', url: `/api/mouvements/${m}/lier`, payload: { invoice_id: f } })
    assert.equal(lie.statusCode, 200, lie.body)
    assert.deepEqual([lie.json().category, lie.json().status, lie.json().covered], ['energy', 'categorise', '1234.56'])
    assert.deepEqual(lie.json().invoices.map((x: { number: string, total: string, remaining: string }) => [x.number, x.total, x.remaining]),
      [['90000000001', '1234.56', '0.00']])
    const r = await resume(f)
    assert.deepEqual([r.paid, r.remaining, r.payment_date], ['1234.56', '0.00', '2026-04-02'])

    // Its category is kept while it pays an invoice; detached, the invoice is to pay again
    assert.equal((await app.inject({ method: 'PUT', url: `/api/mouvements/${m}/categorie`, payload: { category: 'insurance' } })).statusCode, 409)
    const reglement = lie.json().invoices[0].invoice_payment_id
    await app.inject({ method: 'POST', url: `/api/mouvements/${m}/delier`, payload: { invoice_payment_id: reglement } })
    assert.equal((await resume(f)).remaining, '1234.56')
  })

  test('a water invoice paid by two transfers naming it; never more than the invoice', async () => {
    const f = await invoice('Eau Exemple', 'water', '2030-XY-00-55501', '700.00')
    const m1 = await debit('2026-03-25', 'VIR EAU EXEMPLE-2030-XY-00-55501', '250.00')
    const m2 = await debit('2026-08-11', 'VIR EAU EXEMPLE-2030-XY-00-55501', '500.00')
    // Proposed by its number, though the amount differs
    assert.ok((await bank_transaction(m1)).candidates.some((p: { type: string, id: number }) => p.type === 'invoice' && p.id === f))

    // From the invoice: its candidate movements, then linked
    const candidats = (await app.inject(`/api/factures/${f}/mouvements`)).json()
    assert.ok(candidats.some((c: { id: number }) => c.id === m1))
    const regle = await app.inject({ method: 'POST', url: `/api/factures/${f}/reglements`, payload: { bank_transaction_id: m1 } })
    assert.equal(regle.statusCode, 200, regle.body)
    assert.deepEqual(regle.json().payments.map((x: { amount: string }) => x.amount), ['250.00'])
    assert.equal((await bank_transaction(m1)).category, 'water')

    // The second transfer pays the rest only (450); the 50 left of it stays free
    const balance = await app.inject({ method: 'POST', url: `/api/mouvements/${m2}/lier`, payload: { invoice_id: f } })
    assert.equal(balance.statusCode, 200, balance.body)
    assert.deepEqual([balance.json().covered, balance.json().status], ['450.00', 'incomplet'])
    assert.equal((await resume(f)).remaining, '0.00')
    const encore = await app.inject({ method: 'POST', url: `/api/mouvements/${m2}/lier`, payload: { invoice_id: f } })
    assert.equal(encore.statusCode, 400)
  })

  test('a tenant credit, a works debit are refused', async () => {
    const f = await invoice('Énergie Exemple', 'gas', '90000000002', '111.11')
    const credit = (await pool.query<{ id: number }>(
      `INSERT INTO bank_transaction (bank_statement_id, position, transaction_date, label, amount, category) VALUES ($1, $2, '2026-04-01', 'VIR LOCATAIRE', 111.11, 'tenant')
       RETURNING id`, [releve, position++])).rows[0]!.id
    assert.equal((await app.inject({ method: 'POST', url: `/api/mouvements/${credit}/lier`, payload: { invoice_id: f } })).statusCode, 400)
    const works_invoice = await debit('2026-04-01', 'VIR ARTISAN', '111.11', 'works')
    assert.equal((await app.inject({ method: 'POST', url: `/api/mouvements/${works_invoice}/lier`, payload: { invoice_id: f } })).statusCode, 400)
  })

  test('a draft whose total is known is paid (an invoice still to find); its total stays above what is linked', async () => {
    const creer = (number: string, total_incl_tax: string) => app.inject({
      method: 'POST', url: `/api/factures?building=${building}`,
      payload: { supplier: 'Eau Exemple', energy: 'water', number, invoice_date: '2026-03-20', total_incl_tax },
    })
    // Without a total: what remains is unknown
    const sansTotal = (await creer('A-TROUVER-0', '')).json().invoice.id
    const m0 = await debit('2026-04-01', 'VIR EAU EXEMPLE', '77.00')
    assert.equal((await app.inject({ method: 'POST', url: `/api/mouvements/${m0}/lier`, payload: { invoice_id: sansTotal } })).statusCode, 400)

    const brouillon = (await creer('A-TROUVER-1', '88.00')).json().invoice.id
    const m = await debit('2026-04-01', 'VIR EAU EXEMPLE A-TROUVER-1', '88.00')
    assert.ok((await bank_transaction(m)).candidates.some((p: { id: number, status: string }) => p.id === brouillon && p.status === 'draft'))
    const lie = await app.inject({ method: 'POST', url: `/api/mouvements/${m}/lier`, payload: { invoice_id: brouillon } })
    assert.deepEqual([lie.statusCode, lie.json().status, lie.json().category], [200, 'categorise', 'water'])
    assert.equal((await resume(brouillon)).remaining, '0.00')

    // Its total no lower than what is linked; then completed and validated, its payment stays
    const enregistrer = (total_incl_tax: string) => app.inject({
      method: 'PUT', url: `/api/factures/${brouillon}`,
      payload: {
        number: 'A-TROUVER-1', invoice_date: '2026-03-20', total_incl_tax, energy: 'water', note: null,
        lines: [{ category: 'consumption', label: 'Consommation', start: '2026-01-01', end: '2026-02-28', kwh: null,
          amount_excl_tax: null, vat_rate: null, amount_incl_tax: total_incl_tax, allocation: 'recoverable', note: null }],
      },
    })
    assert.equal((await enregistrer('80.00')).statusCode, 422)
    assert.equal((await enregistrer('88.00')).statusCode, 200)
    assert.equal((await app.inject({ method: 'POST', url: `/api/factures/${brouillon}/valider` })).statusCode, 200)
    assert.deepEqual([(await resume(brouillon)).status, (await resume(brouillon)).paid], ['validated', '88.00'])
  })

  test('a monthly payment plan above the yearly invoice: the refund is a negative payment', async () => {
    const f = await invoice('Énergie Exemple', 'electricity', '90000000004', '300.00')
    const credit = (await pool.query<{ id: number }>(
      `INSERT INTO bank_transaction (bank_statement_id, position, transaction_date, label, amount) VALUES ($1, $2, '2026-03-01', 'VIR RBT ENERGIE', 60)
       RETURNING id`, [releve, position++])).rows[0]!.id
    const mensualites = [await debit('2026-01-10', 'PRLV MENSUALITE', '120.00'), await debit('2026-02-10', 'PRLV MENSUALITE', '120.00'),
      await debit('2026-02-25', 'PRLV MENSUALITE', '120.00')]
    // The refund first: the invoice has 60 more to pay, the three monthly payments then pay it in full
    const rembourse = await app.inject({ method: 'POST', url: `/api/mouvements/${credit}/lier`, payload: { invoice_id: f } })
    assert.equal(rembourse.statusCode, 200, rembourse.body)
    assert.deepEqual([rembourse.json().category, rembourse.json().status, rembourse.json().invoices[0].total], ['energy', 'categorise', '-60.00'])
    for (const m of mensualites) {
      assert.equal((await app.inject({ method: 'POST', url: `/api/mouvements/${m}/lier`, payload: { invoice_id: f } })).statusCode, 200)
    }
    const r = await resume(f)
    assert.deepEqual([r.paid, r.remaining], ['300.00', '0.00'])
    assert.deepEqual((await app.inject(`/api/factures/${f}`)).json().payments.map((x: { amount: string }) => x.amount),
      ['120.00', '120.00', '120.00', '-60.00'])
  })

  test('a balance rounded by the supplier: the debit is linked in full, the gap shown', async () => {
    const f = await invoice('Énergie Exemple', 'electricity', '90000000005', '25.07')
    const m = await debit('2026-03-25', 'PRLV SOLDE', '25.08')
    const lie = await app.inject({ method: 'POST', url: `/api/mouvements/${m}/lier`, payload: { invoice_id: f } })
    assert.deepEqual([lie.json().covered, lie.json().status], ['25.08', 'categorise'])
    assert.deepEqual([(await resume(f)).paid, (await resume(f)).remaining], ['25.08', '-0.01'])
    // More than 1 euro above: no more than the invoice
    const g = await invoice('Énergie Exemple', 'electricity', '90000000006', '20.00')
    const n = await debit('2026-03-25', 'PRLV SOLDE', '25.00')
    assert.equal((await app.inject({ method: 'POST', url: `/api/mouvements/${n}/lier`, payload: { invoice_id: g } })).json().covered, '20.00')
  })

  test('the payments of a corrected invoice go to its correction', async () => {
    const f = await invoice('Énergie Exemple', 'electricity', '90000000003', '222.22')
    const m = await debit('2026-04-02', 'PRLV SEPA ENERGIE', '222.22')
    await app.inject({ method: 'POST', url: `/api/mouvements/${m}/lier`, payload: { invoice_id: f } })
    const copie = (await app.inject({ method: 'POST', url: `/api/factures/${f}/corriger` })).json().invoice.id
    assert.equal((await app.inject({ method: 'POST', url: `/api/factures/${copie}/valider` })).statusCode, 200)
    assert.deepEqual([(await resume(f)).paid, (await resume(copie)).paid], ['0', '222.22'])
    assert.equal((await bank_transaction(m)).invoices[0].id, copie)
  })
})

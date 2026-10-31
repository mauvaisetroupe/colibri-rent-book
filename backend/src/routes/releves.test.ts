import assert from 'node:assert/strict'
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { PDFDocument } from 'pdf-lib'
import type pg from 'pg'

import { buildApp } from '../app.js'
import { rangerStockage } from '../pdfStorage.js'
import { createTestPool, resetDatabase, skipWithoutDatabase } from '../test/database.js'

// Bank statements (ADR 0018) of a made-up bank: balances checked, duplicates refused, a missing statement seen, then
// movements matched with payments, ignored, or linked to a payment recorded by hand. PDFs stored by kind.

describe('bank statements', { skip: skipWithoutDatabase }, () => {
  let pool: pg.Pool
  let app: Awaited<ReturnType<typeof buildApp>>
  let storageDir: string
  let extractor: number
  let tenancy: number
  let building: number
  let pdfNumero = 0

  // A different PDF each time (its content gives its name in the storage)
  async function pdf() {
    const doc = await PDFDocument.create()
    doc.addPage().drawText(`releve ${++pdfNumero}`)
    return Buffer.from(await doc.save())
  }

  async function importer(releve: object) {
    const boundary = 'b'
    return app.inject({
      method: 'POST', url: '/api/releves/import',
      payload: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="bank_statement"\r\n\r\n${JSON.stringify(releve)}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="r.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
        await pdf(), Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    })
  }

  const releve = (date: string, previous: string, nouveau: string, transactions: object[]) => ({
    extractor_id: extractor, account: '00012345601', statement_date: date, previous_balance: previous, new_balance: nouveau,
    totaux: null, transactions,
  })
  const mvt = (date: string, label: string, amount: string, detail: string | null = null) =>
    ({ transaction_date: date, value_date: date, label, detail, amount })

  before(async () => {
    pool = createTestPool()
    await resetDatabase(pool)
    storageDir = await mkdtemp(join(tmpdir(), 'crb-pdf-'))
    app = await buildApp({ db: pool, storageDir })
    await pool.query('INSERT INTO supplier (name) VALUES (\'Banque Exemple\')')
    extractor = (await pool.query<{ id: number }>(
      `INSERT INTO extractor (supplier_id, version, type, energy, settings, source, code, engine)
       SELECT id, 1, 'bank_statement', NULL, '{}', 'source', 'code', 2 FROM supplier WHERE name = 'Banque Exemple' RETURNING id`)).rows[0]!.id
    building = (await pool.query<{ id: number }>(
      'INSERT INTO building (code, name) VALUES (\'IMM1\', \'Immeuble fictif\') RETURNING id')).rows[0]!.id
    const unit = (await pool.query<{ id: number }>(
      'INSERT INTO unit (building_id, code, charge_shares) VALUES ($1, \'L1\', 100) RETURNING id', [building])).rows[0]!.id
    const tenant = (await pool.query<{ id: number }>(
      'INSERT INTO tenant (name) VALUES (\'Alice Exemple\') RETURNING id')).rows[0]!.id
    tenancy = (await pool.query<{ id: number }>(
      `INSERT INTO tenancy (unit_id, tenant_id, period) VALUES ($1, $2, '[2026-01-01,)') RETURNING id`,
      [unit, tenant])).rows[0]!.id
  })

  after(async () => {
    await app.close()
    await pool.end()
    await rm(storageDir, { recursive: true, force: true })
  })

  test('a statement whose balances do not add up is refused', async () => {
    const r = await importer(releve('2026-01-16', '1000', '1500', [mvt('2026-01-05', 'VIR DE ALICE EXEMPLE', '600')]))
    assert.equal(r.statusCode, 400)
    assert.match(r.json().message, /Solde précédent \+ crédits − débits = 1600\.00, le relevé dit 1500\.00/)
    const totaux = await importer({ ...releve('2026-01-16', '1000', '1600', [mvt('2026-01-05', 'VIR', '600')]), totaux: { debit: '0', credit: '500' } })
    assert.match(totaux.json().message, /Crédits lus 600\.00, total imprimé 500\.00/)
  })

  test('statements are stored with their movements, their PDF in releves/, a duplicate refused', async () => {
    const r = await importer(releve('2026-01-16', '1000', '1450.50', [
      mvt('2026-01-05', 'VIR DE ALICE EXEMPLE', '600', 'LOYER 01/26'),
      mvt('2026-01-06', 'ECH PRET', '-149.50'),
    ]))
    assert.equal(r.statusCode, 201, r.body)
    assert.deepEqual(r.json().transactions.map((m: { amount: string, status: string }) => [m.amount, m.status]),
      [['600.00', 'to_categorise'], ['-149.50', 'to_categorise']])
    assert.deepEqual(await readdir(join(storageDir, 'releves')).then((f) => f.length), 1)
    assert.equal((await importer(releve('2026-01-16', '1000', '1000', []))).statusCode, 409)

    // The next one follows; the one after a gap does not
    assert.equal((await importer(releve('2026-02-02', '1450.50', '2050.50', [mvt('2026-02-04', 'VIR DE ALICE EXEMPLE', '600')]))).statusCode, 201)
    assert.equal((await importer(releve('2026-03-02', '9999', '9999', []))).statusCode, 201)
    const suites = (await app.inject('/api/releves')).json().map((x: { statement_date: string, suite: boolean | null }) => [x.statement_date, x.suite])
    assert.deepEqual(suites, [['2026-03-02', false], ['2026-02-02', true], ['2026-01-16', null]])
  })

  const bank_transaction = async (id: number) => (await app.inject('/api/mouvements')).json().find((x: { id: number }) => x.id === id)

  test('a credit becomes payments of a tenant, up to its amount; deleting one leaves it incomplete', async () => {
    const [credit] = (await app.inject('/api/mouvements?status=to_categorise')).json()
    assert.equal(credit.label, 'VIR DE ALICE EXEMPLE')
    const payer = (amount: string, month: string, extra: object = {}) => app.inject({
      method: 'POST', url: '/api/paiements',
      payload: { tenancy_id: tenancy, payment_date: credit.transaction_date, month, rent: amount, charge_advance: '0', method: 'transfer', bank_transaction_id: credit.id, ...extra },
    })
    const p1 = await payer('400', '2026-01')
    assert.equal(p1.statusCode, 201, p1.body)
    let m = await bank_transaction(credit.id)
    assert.deepEqual([m.category, m.status, m.covered], ['tenant', 'incomplet', '400.00'])
    assert.equal((await payer('300', '2026-02')).statusCode, 400)
    // A regularisation chosen without an amount is refused
    assert.equal((await payer('0', '2026-02', { charge_adjustment_id: 1, charge_adjustment: '0' })).statusCode, 400)
    assert.equal((await payer('200', '2026-02')).statusCode, 201)
    m = (await app.inject('/api/mouvements?status=categorise&category=tenant')).json()
    assert.deepEqual(m.map((x: { id: number }) => x.id), [credit.id])
    assert.equal(m[0].payments.length, 2)

    // A change from the Paiements screen (without mouvement_id) keeps the link
    await app.inject({ method: 'PUT', url: `/api/paiements/${p1.json().id}`, payload: { ...(p1.json() as object), bank_transaction_id: undefined, note: 'vu' } })
    assert.equal((await pool.query('SELECT bank_transaction_id FROM payment WHERE id = $1', [p1.json().id])).rows[0].bank_transaction_id, credit.id)

    // A debit carries a refund only; a movement with payments keeps its category; a categorised statement is kept
    const [debit] = (await app.inject('/api/mouvements?status=to_categorise')).json()
    assert.equal((await app.inject({
      method: 'POST', url: '/api/paiements', payload: { tenancy_id: tenancy, payment_date: '2026-01-06', month: '2026-01', rent: '1', bank_transaction_id: debit.id },
    })).statusCode, 400)
    assert.equal((await app.inject({ method: 'PUT', url: `/api/mouvements/${credit.id}/categorie`, payload: { category: 'loan' } })).statusCode, 409)
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/mouvements/${credit.id}/categorie` })).statusCode, 409)
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/releves/${credit.bank_statement_id}` })).statusCode, 409)

    await app.inject({ method: 'DELETE', url: `/api/paiements/${p1.json().id}` })
    assert.equal((await bank_transaction(credit.id)).status, 'incomplet')
    // A note does not complete it: only a detail that covers the amount does
    const note = await app.inject({ method: 'PUT', url: `/api/mouvements/${credit.id}/categorie`, payload: { category: 'tenant', note: 'Dépôt de garantie' } })
    assert.deepEqual([note.json().status, note.json().note], ['incomplet', 'Dépôt de garantie'])
    await app.inject({ method: 'PUT', url: `/api/mouvements/${credit.id}/categorie`, payload: { category: 'tenant' } })
  })

  test('a debit is categorised, then not; a payment typed by hand is linked', async () => {
    const debit = (await app.inject('/api/mouvements?status=to_categorise')).json().find((x: { amount: string }) => x.amount.startsWith('-'))
    assert.equal((await app.inject({ method: 'PUT', url: `/api/mouvements/${debit.id}/categorie`, payload: {} })).statusCode, 400)
    assert.equal((await app.inject({ method: 'PUT', url: `/api/mouvements/${debit.id}/categorie`, payload: { category: 'other' } })).statusCode, 400)
    const emprunt = await app.inject({ method: 'PUT', url: `/api/mouvements/${debit.id}/categorie`, payload: { category: 'loan' } })
    assert.deepEqual([emprunt.json().status, emprunt.json().category], ['categorise', 'loan'])
    // Works on a movement of another category are refused
    const invoice = await app.inject({
      method: 'POST', url: '/api/travaux',
      payload: { building_id: building, supplier: 'X', description: 'Y', nature: 'maintenance', invoice_date: '2026-01-06', total_incl_tax: '149.50' },
    })
    assert.equal((await app.inject({ method: 'POST', url: `/api/mouvements/${debit.id}/lier`, payload: { works_invoice_id: invoice.json().id } })).statusCode, 400)
    await app.inject({ method: 'DELETE', url: `/api/travaux/${invoice.json().id}` })
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/mouvements/${debit.id}/categorie` })).json().status, 'to_categorise')

    const fevrier = (await app.inject('/api/mouvements?status=to_categorise')).json().find((x: { transaction_date: string }) => x.transaction_date === '2026-02-04')
    const main = await app.inject({
      method: 'POST', url: '/api/paiements', payload: { tenancy_id: tenancy, payment_date: '2026-02-04', month: '2026-03', rent: '600', method: 'transfer' },
    })
    assert.deepEqual((await bank_transaction(fevrier.id)).candidates.map((x: { type: string, id: number }) => [x.type, x.id]), [['payment', main.json().id]])
    const lie = await app.inject({ method: 'POST', url: `/api/mouvements/${fevrier.id}/lier`, payload: { payment_id: main.json().id } })
    assert.deepEqual([lie.json().category, lie.json().status], ['tenant', 'categorise'])
    const delie = await app.inject({ method: 'POST', url: `/api/mouvements/${fevrier.id}/delier`, payload: { payment_id: main.json().id } })
    assert.equal(delie.json().status, 'incomplet')

    // Two months typed as two payments, paid by one transfer: proposed together
    const second = await app.inject({
      method: 'POST', url: '/api/paiements', payload: { tenancy_id: tenancy, payment_date: '2026-02-05', month: '2026-04', rent: '0.5', method: 'transfer' },
    })
    await app.inject({ method: 'PUT', url: `/api/paiements/${main.json().id}`, payload: { ...(main.json() as object), rent: '599.5', bank_transaction_id: null } })
    const groupe = (await bank_transaction(fevrier.id)).candidates
    assert.deepEqual(groupe.map((x: { type: string, ids: number[] }) => [x.type, x.ids]), [['group', [main.json().id, second.json().id]]])
    const tous = await app.inject({ method: 'POST', url: `/api/mouvements/${fevrier.id}/lier`, payload: { payment_ids: groupe[0].ids } })
    assert.deepEqual([tous.json().status, tous.json().payments.length], ['categorise', 2])
  })

  test('works paid by two transfers; a deposit paid with the rent, then refunded alone', async () => {
    const r = await importer(releve('2026-04-30', '9999', '8099', [
      mvt('2026-03-10', 'VIR ACOMPTE DEVIS', '-1000'),
      mvt('2026-03-12', 'VIR DE ALICE EXEMPLE', '1000'),
      mvt('2026-04-10', 'VIR SOLDE FACTURE', '-1500'),
      mvt('2026-04-15', 'VIR REMB GARANTIE ALICE', '-400'),
    ]))
    assert.equal(r.statusCode, 201, r.body)
    const [acompte, rent, balance, remboursement] = r.json().transactions

    // The invoice first, then the deposit's transfer linked to it: the movement becomes « travaux »
    const works_invoice = await app.inject({
      method: 'POST', url: '/api/travaux',
      payload: { building_id: building, supplier: 'Maçon Exemple', description: 'Ravalement', nature: 'maintenance', invoice_date: '2026-04-01', total_incl_tax: '2500' },
    })
    assert.equal(works_invoice.statusCode, 201, works_invoice.body)
    await app.inject({ method: 'POST', url: `/api/mouvements/${acompte.id}/lier`, payload: { works_invoice_id: works_invoice.json().id } })
    assert.deepEqual([(await bank_transaction(acompte.id)).category, (await bank_transaction(acompte.id)).status], ['works', 'categorise'])
    // The balance's transfer: what remains of the invoice is proposed, then linked as a second payment
    assert.deepEqual((await bank_transaction(balance.id)).candidates.map((x: { type: string, id: number }) => [x.type, x.id]), [['works', works_invoice.json().id]])
    const lie = await app.inject({ method: 'POST', url: `/api/mouvements/${balance.id}/lier`, payload: { works_invoice_id: works_invoice.json().id } })
    assert.deepEqual([lie.json().status, lie.json().works_invoices[0].total, lie.json().works_invoices[0].remaining], ['categorise', '1500.00', '0.00'])
    // Paid in full: nothing more to link
    assert.equal((await app.inject({ method: 'POST', url: `/api/mouvements/${remboursement.id}/lier`, payload: { works_invoice_id: works_invoice.json().id } })).statusCode, 400)

    // 1000 = rent 600 + deposit 400
    await app.inject({
      method: 'POST', url: '/api/paiements',
      payload: { tenancy_id: tenancy, payment_date: '2026-03-12', month: '2026-03', rent: '600', method: 'transfer', bank_transaction_id: rent.id },
    })
    assert.equal((await app.inject({
      method: 'POST', url: '/api/depots', payload: { tenancy_id: tenancy, payment_date: '2026-03-12', amount: '500', bank_transaction_id: rent.id },
    })).statusCode, 400)
    const paid = await app.inject({
      method: 'POST', url: '/api/depots', payload: { tenancy_id: tenancy, payment_date: '2026-03-12', amount: '400', bank_transaction_id: rent.id },
    })
    assert.equal(paid.statusCode, 201, paid.body)
    const m = await bank_transaction(rent.id)
    assert.deepEqual([m.category, m.status, m.covered, m.deposits.length], ['tenant', 'categorise', '1000.00', 1])

    // Refunded alone: a negative deposit, the movement becomes « depot_garantie »; a positive one is refused there
    assert.equal((await app.inject({
      method: 'POST', url: '/api/depots', payload: { tenancy_id: tenancy, payment_date: '2026-04-15', amount: '400', bank_transaction_id: remboursement.id },
    })).statusCode, 400)
    const rendu = await app.inject({
      method: 'POST', url: '/api/depots', payload: { tenancy_id: tenancy, payment_date: '2026-04-15', amount: '-400' },
    })
    const lieDepot = await app.inject({ method: 'POST', url: `/api/mouvements/${remboursement.id}/lier`, payload: { deposit_payment_id: rendu.json().id } })
    assert.deepEqual([lieDepot.json().category, lieDepot.json().status], ['security_deposit', 'categorise'])
    assert.equal((await app.inject({ method: 'PUT', url: `/api/mouvements/${remboursement.id}/categorie`, payload: { category: 'works' } })).statusCode, 409)
    assert.deepEqual((await app.inject(`/api/depots?building=${building}`)).json().map((d: { amount: string }) => d.amount), ['400.00', '-400.00'])
    const delie = await app.inject({ method: 'POST', url: `/api/mouvements/${remboursement.id}/delier`, payload: { deposit_payment_id: rendu.json().id } })
    assert.equal(delie.json().status, 'incomplet')
  })

  test('a storage written before the folders is put in order at start-up', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crb-rangement-'))
    try {
      await writeFile(join(dir, 'aaa.pdf'), '%PDF-1')
      await writeFile(join(dir, 'inconnu.pdf'), '%PDF-1')
      const invoice = (await pool.query<{ id: number }>(
        `INSERT INTO invoice (building_id, supplier_id, energy, number, pdf_file)
         SELECT (SELECT id FROM building LIMIT 1), id, 'water', 'R1', 'factures/aaa.pdf' FROM supplier WHERE name = 'Banque Exemple'
         RETURNING id`)).rows[0]!.id
      assert.equal(await rangerStockage(pool, dir), 1)
      await access(join(dir, 'factures', 'aaa.pdf'))
      assert.deepEqual((await readdir(dir)).sort(), ['factures', 'inconnu.pdf'])
      assert.equal(await rangerStockage(pool, dir), 0)
      await pool.query('DELETE FROM invoice WHERE id = $1', [invoice])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

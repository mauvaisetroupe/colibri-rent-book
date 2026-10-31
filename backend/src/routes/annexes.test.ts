import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { PDFDocument } from 'pdf-lib'
import type pg from 'pg'

import { buildApp } from '../app.js'
import { createTestPool, resetDatabase, skipWithoutDatabase } from '../test/database.js'

// Invoices joined to a supporting document as their version in images, never as received (ADR 0024). Made-up
// building, one tenant all year, one invoice whose PDF has one page; its versions in images have two or three pages,
// so that the length of the supporting document says which one is joined.

describe('invoices joined as their version in images', { skip: skipWithoutDatabase }, () => {
  let pool: pg.Pool
  let app: Awaited<ReturnType<typeof buildApp>>
  let storageDir: string
  let building: number
  let tenancy: number
  let invoice: number

  const pdf = async (pages: number, title: string) => {
    const doc = await PDFDocument.create()
    doc.setTitle(title)
    for (let i = 0; i < pages; i++) {
      doc.addPage([200, 200])
    }
    return Buffer.from(await doc.save())
  }

  const multipart = (fields: Record<string, string>, file: Buffer) => ({
    payload: Buffer.concat([
      ...Object.entries(fields).map(([name, value]) =>
        Buffer.from(`--b\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)),
      Buffer.from('--b\r\nContent-Disposition: form-data; name="file"; filename="f.pdf"\r\nContent-Type: application/pdf\r\n\r\n'),
      file, Buffer.from('\r\n--b--\r\n'),
    ]),
    headers: { 'content-type': 'multipart/form-data; boundary=b' },
  })

  const tenant_copy = { zones: [{ page: 1, x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.2, origin: 'terms' }], extractor_id: null,
    terms: ['NOM DU GÉRANT'], settings: { dpi: 200, threshold: 170 } }

  /** Makes a version in images of `pages` pages; its id. */
  async function faire(pages: number) {
    const r = await app.inject({
      method: 'POST', url: `/api/factures/${invoice}/annexe`,
      ...multipart({ tenant_copy: JSON.stringify(tenant_copy) }, await pdf(pages, `annexe ${pages}`)),
    })
    assert.equal(r.statusCode, 201, r.body)
    return r.json().tenant_copy.id as number
  }

  const verifier = (annexeId: number) =>
    app.inject({ method: 'POST', url: `/api/factures/${invoice}/annexe/verifiee`, payload: { tenant_copy_id: annexeId } })

  const state = async () => (await app.inject(`/api/factures/${invoice}`)).json().invoice.tenant_copy

  /** Pages of the supporting document of the regularisation beyond those of the statement alone (1 page of annex). */
  const pages = async (url: string) => (await PDFDocument.load((await app.inject(url)).rawPayload)).getPageCount()

  before(async () => {
    pool = createTestPool()
    await resetDatabase(pool)
    storageDir = await mkdtemp(join(tmpdir(), 'crb-annexe-'))
    app = await buildApp({ db: pool, storageDir })
    building = (await pool.query<{ id: number }>(
      'INSERT INTO building (code, name) VALUES (\'IMM1\', \'Immeuble fictif\') RETURNING id')).rows[0]!.id
    const unit = (await pool.query<{ id: number }>(
      'INSERT INTO unit (building_id, code, charge_shares) VALUES ($1, \'L1\', 100) RETURNING id', [building])).rows[0]!.id
    const tenant = (await pool.query<{ id: number }>(
      'INSERT INTO tenant (name) VALUES (\'Locataire Exemple\') RETURNING id')).rows[0]!.id
    tenancy = (await pool.query<{ id: number }>(
      `INSERT INTO tenancy (unit_id, tenant_id, period) VALUES ($1, $2, '[2025-01-01,2026-01-01)') RETURNING id`,
      [unit, tenant])).rows[0]!.id

    const created = await app.inject({
      method: 'POST', url: `/api/factures?building=${building}`,
      ...multipart({ supplier: 'Eau Exemple', energy: 'water', number: 'E-1', invoice_date: '2025-12-31',
        total_incl_tax: '120' }, await pdf(1, 'original')),
    })
    assert.equal(created.statusCode, 201, created.body)
    invoice = created.json().invoice.id
    const ligne = { category: 'subscription', label: 'Abonnement', start: '2025-01-01', end: '2025-12-31', kwh: null,
      amount_excl_tax: null, vat_rate: null, amount_incl_tax: '120', allocation: 'recoverable', note: null }
    await app.inject({ method: 'PUT', url: `/api/factures/${invoice}`, payload: {
      number: 'E-1', invoice_date: '2025-12-31', total_incl_tax: '120', energy: 'water', note: null, lines: [ligne] } })
    assert.equal((await app.inject({ method: 'POST', url: `/api/factures/${invoice}/valider` })).statusCode, 200)
  })

  after(async () => {
    await app.close()
    await pool.end()
    await rm(storageDir, { recursive: true, force: true })
  })

  test('never joined as received: only a verified version in images', async () => {
    const projet = `/api/justificatif?building=${building}&start=2025-01-01&end=2025-12-31&tenancy=${tenancy}`
    assert.equal(await state(), 'to_make')
    const sans = await pages(projet)

    const deux = await faire(2)
    assert.equal(await state(), 'to_check')
    assert.equal(await pages(projet), sans, 'not verified: not joined')

    assert.equal((await verifier(deux)).statusCode, 200)
    assert.equal(await state(), 'checked')
    assert.equal(await pages(projet), sans + 2)
    assert.equal((await verifier(deux)).statusCode, 409, 'verified once')
  })

  test('a sent regularisation keeps the version it joined', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/regularisations',
      payload: { tenancy_id: tenancy, start: '2025-01-01', end: '2025-12-31' } })
    assert.equal(r.statusCode, 201, r.body)
    const id = r.json().id
    assert.deepEqual((await app.inject(`/api/regularisations/${id}`)).json().tenant_copies.map((a: { state: string }) => a.state),
      ['checked'])
    const url = `/api/regularisations/${id}/justificatif`
    const sent = await pages(url)
    assert.equal((await app.inject({ method: 'POST', url: `/api/regularisations/${id}/envoi`,
      payload: { sent_on: '2026-02-01' } })).statusCode, 200)

    const trois = await faire(3)
    await verifier(trois)
    assert.equal(await pages(url), sent, 'still the version of two pages')
    assert.equal(await pages(`/api/justificatif?building=${building}&start=2025-01-01&end=2025-12-31&tenancy=${tenancy}`),
      sent + 1, 'a preview joins the current one')
  })

  test('a new PDF of the invoice: its version in images is to be made again', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/factures/${invoice}/pdf`, ...multipart({}, await pdf(1, 'other')) })
    assert.equal(r.statusCode, 200, r.body)
    assert.equal(await state(), 'to_make')
  })

  test('a version in images is frozen but for its verification', async () => {
    await assert.rejects(pool.query('UPDATE invoice_tenant_copy SET terms = \'{}\''), /jamais modifiée/)
  })

  test('zones drawn by hand on scans (ADR 0025): of the supplier, of the invoice, reset by a new PDF', async () => {
    const zone = { page: 1, x0: 0.5, y0: 0.1, x1: 0.9, y1: 0.2 }
    const detail = (await app.inject(`/api/factures/${invoice}`)).json()
    const supplier = detail.invoice.supplier_id
    const r = await app.inject({ method: 'PUT', url: `/api/fournisseurs/${supplier}/zones`, payload: { zones: [zone] } })
    assert.equal(r.statusCode, 200, r.body)
    assert.deepEqual(r.json().masked_zones, [zone])
    assert.equal((await app.inject({ method: 'PUT', url: `/api/fournisseurs/${supplier}/zones`,
      payload: { zones: [{ ...zone, x1: 0.4 }] } })).statusCode, 400, 'x0 < x1')

    const propres = await app.inject({ method: 'PUT', url: `/api/factures/${invoice}/zones`, payload: { zones: [{ ...zone, page: 2 }] } })
    assert.equal(propres.statusCode, 200, propres.body)
    assert.deepEqual(propres.json().invoice.masked_zones, [{ ...zone, page: 2 }])
    assert.equal((await app.inject({ method: 'PUT', url: `/api/factures/${invoice}/zones`,
      payload: { zones: [{ ...zone, page: 0 }] } })).statusCode, 400, 'pages from 1')

    // The version made of a scan says so
    const fait = await app.inject({
      method: 'POST', url: `/api/factures/${invoice}/annexe`,
      ...multipart({ tenant_copy: JSON.stringify({ ...tenant_copy, scanned_pages: [1] }) }, await pdf(1, 'scan')),
    })
    assert.equal(fait.statusCode, 201, fait.body)
    assert.deepEqual(fait.json().tenant_copy.scanned_pages, [1])

    await app.inject({ method: 'POST', url: `/api/factures/${invoice}/pdf`, ...multipart({}, await pdf(2, 'autre scan')) })
    assert.equal((await app.inject(`/api/factures/${invoice}`)).json().invoice.masked_zones, null,
      'zones drawn for another PDF')
  })

  test('masked terms: a list, trimmed, without duplicates', async () => {
    const r = await app.inject({ method: 'PUT', url: '/api/termes-masques',
      payload: { terms: [' NOM DU GÉRANT ', '', 'FR76 0000', 'NOM DU GÉRANT'] } })
    assert.equal(r.statusCode, 200, r.body)
    assert.deepEqual((await app.inject('/api/termes-masques')).json(), ['FR76 0000', 'NOM DU GÉRANT'])
  })
})

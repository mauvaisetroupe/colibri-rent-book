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
  let immeuble: number
  let sejour: number
  let facture: number

  const pdf = async (pages: number, titre: string) => {
    const doc = await PDFDocument.create()
    doc.setTitle(titre)
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

  const annexe = { zones: [{ page: 1, x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.2, origine: 'termes' }], extracteur_id: null,
    termes: ['NOM DU GÉRANT'], reglages: { dpi: 200, seuil: 170 } }

  /** Makes a version in images of `pages` pages; its id. */
  async function faire(pages: number) {
    const r = await app.inject({
      method: 'POST', url: `/api/factures/${facture}/annexe`,
      ...multipart({ annexe: JSON.stringify(annexe) }, await pdf(pages, `annexe ${pages}`)),
    })
    assert.equal(r.statusCode, 201, r.body)
    return r.json().annexe.id as number
  }

  const verifier = (annexeId: number) =>
    app.inject({ method: 'POST', url: `/api/factures/${facture}/annexe/verifiee`, payload: { annexe_id: annexeId } })

  const etat = async () => (await app.inject(`/api/factures/${facture}`)).json().facture.annexe

  /** Pages of the supporting document of the regularisation beyond those of the statement alone (1 page of annex). */
  const pages = async (url: string) => (await PDFDocument.load((await app.inject(url)).rawPayload)).getPageCount()

  before(async () => {
    pool = createTestPool()
    await resetDatabase(pool)
    storageDir = await mkdtemp(join(tmpdir(), 'crb-annexe-'))
    app = await buildApp({ db: pool, storageDir })
    immeuble = (await pool.query<{ id: number }>(
      'INSERT INTO immeuble (code, nom) VALUES (\'IMM1\', \'Immeuble fictif\') RETURNING id')).rows[0]!.id
    const lot = (await pool.query<{ id: number }>(
      'INSERT INTO lot (immeuble_id, code, tantiemes) VALUES ($1, \'L1\', 100) RETURNING id', [immeuble])).rows[0]!.id
    const locataire = (await pool.query<{ id: number }>(
      'INSERT INTO locataire (nom) VALUES (\'Locataire Exemple\') RETURNING id')).rows[0]!.id
    sejour = (await pool.query<{ id: number }>(
      `INSERT INTO sejour (lot_id, locataire_id, periode) VALUES ($1, $2, '[2025-01-01,2026-01-01)') RETURNING id`,
      [lot, locataire])).rows[0]!.id

    const created = await app.inject({
      method: 'POST', url: `/api/factures?immeuble=${immeuble}`,
      ...multipart({ fournisseur: 'Eau Exemple', energie: 'eau', numero: 'E-1', date_facture: '2025-12-31',
        montant_ttc: '120' }, await pdf(1, 'original')),
    })
    assert.equal(created.statusCode, 201, created.body)
    facture = created.json().facture.id
    const ligne = { categorie: 'abonnement', libelle: 'Abonnement', debut: '2025-01-01', fin: '2025-12-31', kwh: null,
      montant_ht: null, taux_tva: null, montant_ttc: '120', affectation: 'recuperable', note: null }
    await app.inject({ method: 'PUT', url: `/api/factures/${facture}`, payload: {
      numero: 'E-1', date_facture: '2025-12-31', montant_ttc: '120', energie: 'eau', note: null, lignes: [ligne] } })
    assert.equal((await app.inject({ method: 'POST', url: `/api/factures/${facture}/valider` })).statusCode, 200)
  })

  after(async () => {
    await app.close()
    await pool.end()
    await rm(storageDir, { recursive: true, force: true })
  })

  test('never joined as received: only a verified version in images', async () => {
    const projet = `/api/justificatif?immeuble=${immeuble}&debut=2025-01-01&fin=2025-12-31&sejour=${sejour}`
    assert.equal(await etat(), 'a_faire')
    const sans = await pages(projet)

    const deux = await faire(2)
    assert.equal(await etat(), 'a_verifier')
    assert.equal(await pages(projet), sans, 'not verified: not joined')

    assert.equal((await verifier(deux)).statusCode, 200)
    assert.equal(await etat(), 'verifiee')
    assert.equal(await pages(projet), sans + 2)
    assert.equal((await verifier(deux)).statusCode, 409, 'verified once')
  })

  test('a sent regularisation keeps the version it joined', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/regularisations',
      payload: { sejour_id: sejour, debut: '2025-01-01', fin: '2025-12-31' } })
    assert.equal(r.statusCode, 201, r.body)
    const id = r.json().id
    assert.deepEqual((await app.inject(`/api/regularisations/${id}`)).json().annexes.map((a: { etat: string }) => a.etat),
      ['verifiee'])
    const url = `/api/regularisations/${id}/justificatif`
    const envoyee = await pages(url)
    assert.equal((await app.inject({ method: 'POST', url: `/api/regularisations/${id}/envoi`,
      payload: { date_envoi: '2026-02-01' } })).statusCode, 200)

    const trois = await faire(3)
    await verifier(trois)
    assert.equal(await pages(url), envoyee, 'still the version of two pages')
    assert.equal(await pages(`/api/justificatif?immeuble=${immeuble}&debut=2025-01-01&fin=2025-12-31&sejour=${sejour}`),
      envoyee + 1, 'a preview joins the current one')
  })

  test('a new PDF of the invoice: its version in images is to be made again', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/factures/${facture}/pdf`, ...multipart({}, await pdf(1, 'autre')) })
    assert.equal(r.statusCode, 200, r.body)
    assert.equal(await etat(), 'a_faire')
  })

  test('a version in images is frozen but for its verification', async () => {
    await assert.rejects(pool.query('UPDATE facture_annexe SET termes = \'{}\''), /jamais modifiée/)
  })

  test('zones drawn by hand on scans (ADR 0025): of the supplier, of the invoice, reset by a new PDF', async () => {
    const zone = { page: 1, x0: 0.5, y0: 0.1, x1: 0.9, y1: 0.2 }
    const detail = (await app.inject(`/api/factures/${facture}`)).json()
    const fournisseur = detail.facture.fournisseur_id
    const r = await app.inject({ method: 'PUT', url: `/api/fournisseurs/${fournisseur}/zones`, payload: { zones: [zone] } })
    assert.equal(r.statusCode, 200, r.body)
    assert.deepEqual(r.json().zones_masquees, [zone])
    assert.equal((await app.inject({ method: 'PUT', url: `/api/fournisseurs/${fournisseur}/zones`,
      payload: { zones: [{ ...zone, x1: 0.4 }] } })).statusCode, 400, 'x0 < x1')

    const propres = await app.inject({ method: 'PUT', url: `/api/factures/${facture}/zones`, payload: { zones: [{ ...zone, page: 2 }] } })
    assert.equal(propres.statusCode, 200, propres.body)
    assert.deepEqual(propres.json().facture.zones_masquees, [{ ...zone, page: 2 }])
    assert.equal((await app.inject({ method: 'PUT', url: `/api/factures/${facture}/zones`,
      payload: { zones: [{ ...zone, page: 0 }] } })).statusCode, 400, 'pages from 1')

    // The version made of a scan says so
    const fait = await app.inject({
      method: 'POST', url: `/api/factures/${facture}/annexe`,
      ...multipart({ annexe: JSON.stringify({ ...annexe, pages_scannees: [1] }) }, await pdf(1, 'scan')),
    })
    assert.equal(fait.statusCode, 201, fait.body)
    assert.deepEqual(fait.json().annexe.pages_scannees, [1])

    await app.inject({ method: 'POST', url: `/api/factures/${facture}/pdf`, ...multipart({}, await pdf(2, 'autre scan')) })
    assert.equal((await app.inject(`/api/factures/${facture}`)).json().facture.zones_masquees, null,
      'zones drawn for another PDF')
  })

  test('masked terms: a list, trimmed, without duplicates', async () => {
    const r = await app.inject({ method: 'PUT', url: '/api/termes-masques',
      payload: { termes: [' NOM DU GÉRANT ', '', 'FR76 0000', 'NOM DU GÉRANT'] } })
    assert.equal(r.statusCode, 200, r.body)
    assert.deepEqual((await app.inject('/api/termes-masques')).json(), ['FR76 0000', 'NOM DU GÉRANT'])
  })
})

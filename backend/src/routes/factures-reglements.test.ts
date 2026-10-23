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
  let immeuble: number
  let releve: number
  let ordre = 0

  /** A validated invoice with one line of this amount. */
  async function facture(fournisseur: string, energie: string, numero: string, montant: string) {
    const created = await app.inject({
      method: 'POST', url: `/api/factures?immeuble=${immeuble}`,
      payload: { fournisseur, energie, numero, date_facture: '2026-03-20', montant_ttc: montant },
    })
    assert.equal(created.statusCode, 201, created.body)
    const id = created.json().facture.id as number
    const saved = await app.inject({
      method: 'PUT', url: `/api/factures/${id}`,
      payload: {
        numero, date_facture: '2026-03-20', montant_ttc: montant, energie, note: null,
        lignes: [{ categorie: 'consommation', libelle: 'Consommation', debut: '2026-01-01', fin: '2026-02-28', kwh: null,
          montant_ht: null, taux_tva: null, montant_ttc: montant, affectation: 'recuperable', note: null }],
      },
    })
    assert.equal(saved.statusCode, 200, saved.body)
    assert.equal((await app.inject({ method: 'POST', url: `/api/factures/${id}/valider` })).statusCode, 200)
    return id
  }

  async function debit(date: string, libelle: string, montant: string, categorie: string | null = null) {
    return (await pool.query<{ id: number }>(
      `INSERT INTO mouvement (releve_id, ordre, date_operation, libelle, montant, categorie)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [releve, ordre++, date, libelle, `-${montant}`, categorie])).rows[0]!.id
  }

  const mouvement = async (id: number) =>
    (await app.inject(`/api/mouvements?statut=tous`)).json().find((m: { id: number }) => m.id === id)
  const resume = async (id: number) =>
    (await app.inject(`/api/factures?immeuble=${immeuble}`)).json().find((f: { id: number }) => f.id === id)

  before(async () => {
    pool = createTestPool()
    await resetDatabase(pool)
    storageDir = await mkdtemp(join(tmpdir(), 'crb-pdf-'))
    app = await buildApp({ db: pool, storageDir })
    immeuble = (await pool.query<{ id: number }>(
      'INSERT INTO immeuble (code, nom) VALUES (\'IMM1\', \'Immeuble fictif\') RETURNING id')).rows[0]!.id
    await pool.query('INSERT INTO fournisseur (nom) VALUES (\'Banque Exemple\'), (\'Énergie Exemple\'), (\'Eau Exemple\')')
    releve = (await pool.query<{ id: number }>(
      `INSERT INTO releve_bancaire (fournisseur_id, compte, date_releve, solde_precedent, nouveau_solde)
       SELECT id, '001', '2030-01-01', 0, 0 FROM fournisseur WHERE nom = 'Banque Exemple' RETURNING id`)).rows[0]!.id
  })

  after(async () => {
    await app.close()
    await pool.end()
    await rm(storageDir, { recursive: true, force: true })
  })

  test('a debit of the same amount is proposed, linked, categorised; the invoice is paid', async () => {
    const f = await facture('Énergie Exemple', 'electricite', '90000000001', '1234.56')
    const m = await debit('2026-04-02', 'PRLV SEPA ENERGIE', '1234.56')
    assert.deepEqual((await resume(f)).reste, '1234.56')
    const avant = await mouvement(m)
    assert.deepEqual(avant.possibles.map((p: { type: string, id: number }) => [p.type, p.id]), [['facture', f]])
    assert.equal(avant.statut, 'a_categoriser')
    // Categorised without its invoice, it is to link (« incomplet »)
    assert.equal((await app.inject({ method: 'PUT', url: `/api/mouvements/${m}/categorie`, payload: { categorie: 'energie' } })).json().statut, 'incomplet')

    const lie = await app.inject({ method: 'POST', url: `/api/mouvements/${m}/lier`, payload: { facture_id: f } })
    assert.equal(lie.statusCode, 200, lie.body)
    assert.deepEqual([lie.json().categorie, lie.json().statut, lie.json().couvert], ['energie', 'categorise', '1234.56'])
    assert.deepEqual(lie.json().factures.map((x: { numero: string, total: string, reste: string }) => [x.numero, x.total, x.reste]),
      [['90000000001', '1234.56', '0.00']])
    const r = await resume(f)
    assert.deepEqual([r.paye, r.reste, r.date_paiement], ['1234.56', '0.00', '2026-04-02'])

    // Its category is kept while it pays an invoice; detached, the invoice is to pay again
    assert.equal((await app.inject({ method: 'PUT', url: `/api/mouvements/${m}/categorie`, payload: { categorie: 'assurance' } })).statusCode, 409)
    const reglement = lie.json().factures[0].reglement_id
    await app.inject({ method: 'POST', url: `/api/mouvements/${m}/delier`, payload: { reglement_facture_id: reglement } })
    assert.equal((await resume(f)).reste, '1234.56')
  })

  test('a water invoice paid by two transfers naming it; never more than the invoice', async () => {
    const f = await facture('Eau Exemple', 'eau', '2030-XY-00-55501', '700.00')
    const m1 = await debit('2026-03-25', 'VIR EAU EXEMPLE-2030-XY-00-55501', '250.00')
    const m2 = await debit('2026-08-11', 'VIR EAU EXEMPLE-2030-XY-00-55501', '500.00')
    // Proposed by its number, though the amount differs
    assert.ok((await mouvement(m1)).possibles.some((p: { type: string, id: number }) => p.type === 'facture' && p.id === f))

    // From the invoice: its candidate movements, then linked
    const candidats = (await app.inject(`/api/factures/${f}/mouvements`)).json()
    assert.ok(candidats.some((c: { id: number }) => c.id === m1))
    const regle = await app.inject({ method: 'POST', url: `/api/factures/${f}/reglements`, payload: { mouvement_id: m1 } })
    assert.equal(regle.statusCode, 200, regle.body)
    assert.deepEqual(regle.json().reglements.map((x: { montant: string }) => x.montant), ['250.00'])
    assert.equal((await mouvement(m1)).categorie, 'eau')

    // The second transfer pays the rest only (450); the 50 left of it stays free
    const solde = await app.inject({ method: 'POST', url: `/api/mouvements/${m2}/lier`, payload: { facture_id: f } })
    assert.equal(solde.statusCode, 200, solde.body)
    assert.deepEqual([solde.json().couvert, solde.json().statut], ['450.00', 'incomplet'])
    assert.equal((await resume(f)).reste, '0.00')
    const encore = await app.inject({ method: 'POST', url: `/api/mouvements/${m2}/lier`, payload: { facture_id: f } })
    assert.equal(encore.statusCode, 400)
  })

  test('a credit, a works debit, a draft are refused', async () => {
    const f = await facture('Énergie Exemple', 'gaz', '90000000002', '111.11')
    const credit = (await pool.query<{ id: number }>(
      `INSERT INTO mouvement (releve_id, ordre, date_operation, libelle, montant) VALUES ($1, $2, '2026-04-01', 'RBT', 111.11)
       RETURNING id`, [releve, ordre++])).rows[0]!.id
    assert.equal((await app.inject({ method: 'POST', url: `/api/mouvements/${credit}/lier`, payload: { facture_id: f } })).statusCode, 400)
    const travaux = await debit('2026-04-01', 'VIR ARTISAN', '111.11', 'travaux')
    assert.equal((await app.inject({ method: 'POST', url: `/api/mouvements/${travaux}/lier`, payload: { facture_id: f } })).statusCode, 400)
    const brouillon = (await app.inject({
      method: 'POST', url: `/api/factures?immeuble=${immeuble}`,
      payload: { fournisseur: 'Énergie Exemple', energie: 'gaz', numero: 'BROUILLON-1', date_facture: '2026-03-20', montant_ttc: '50' },
    })).json().facture.id
    const m = await debit('2026-04-01', 'PRLV SEPA GAZ', '50.00')
    assert.equal((await app.inject({ method: 'POST', url: `/api/mouvements/${m}/lier`, payload: { facture_id: brouillon } })).statusCode, 400)
  })

  test('the payments of a corrected invoice go to its correction', async () => {
    const f = await facture('Énergie Exemple', 'electricite', '90000000003', '222.22')
    const m = await debit('2026-04-02', 'PRLV SEPA ENERGIE', '222.22')
    await app.inject({ method: 'POST', url: `/api/mouvements/${m}/lier`, payload: { facture_id: f } })
    const copie = (await app.inject({ method: 'POST', url: `/api/factures/${f}/corriger` })).json().facture.id
    assert.equal((await app.inject({ method: 'POST', url: `/api/factures/${copie}/valider` })).statusCode, 200)
    assert.deepEqual([(await resume(f)).paye, (await resume(copie)).paye], ['0', '222.22'])
    assert.equal((await mouvement(m)).factures[0].id, copie)
  })
})

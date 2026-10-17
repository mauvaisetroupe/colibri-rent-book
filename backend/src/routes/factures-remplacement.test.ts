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
  let immeuble: number
  let regularisation: number

  const ligne = (montant: string, fin = '2025-12-31') => ({
    categorie: 'abonnement', libelle: 'Abonnement', debut: '2025-01-01', fin, kwh: null, montant_ht: null,
    taux_tva: null, montant_ttc: montant, affectation: 'recuperable', note: null,
  })

  /** A validated invoice with one line of this amount. */
  async function facture(numero: string, montant: string) {
    const created = await app.inject({
      method: 'POST', url: `/api/factures?immeuble=${immeuble}`,
      payload: { fournisseur: 'Eau Exemple', energie: 'eau', numero, date_facture: '2025-12-31', montant_ttc: montant },
    })
    assert.equal(created.statusCode, 201, created.body)
    const id = created.json().facture.id
    const saved = await app.inject({
      method: 'PUT', url: `/api/factures/${id}`,
      payload: { numero, date_facture: '2025-12-31', montant_ttc: montant, energie: 'eau', note: null, lignes: [ligne(montant)] },
    })
    assert.equal(saved.statusCode, 200, saved.body)
    const validated = await app.inject({ method: 'POST', url: `/api/factures/${id}/valider` })
    assert.equal(validated.statusCode, 200, validated.body)
    return id as number
  }

  const charges = async () => {
    const d = (await app.inject(`/api/decompte?immeuble=${immeuble}&debut=2025-01-01&fin=2025-12-31`)).json()
    return d.sejours.map((s: { solde: string }) => new Big(s.solde).toString())
  }

  before(async () => {
    pool = createTestPool()
    await resetDatabase(pool)
    storageDir = await mkdtemp(join(tmpdir(), 'crb-pdf-'))
    app = await buildApp({ db: pool, storageDir })
    immeuble = (await pool.query<{ id: number }>(
      'INSERT INTO immeuble (code, nom) VALUES (\'IMM1\', \'Immeuble fictif\') RETURNING id')).rows[0]!.id
    const lot = (await pool.query<{ id: number }>(
      'INSERT INTO lot (immeuble_id, code, tantiemes) VALUES ($1, \'L1\', 100) RETURNING id', [immeuble])).rows[0]!.id
    const locataire = (await pool.query<{ id: number }>(
      'INSERT INTO locataire (nom) VALUES (\'Locataire Exemple\') RETURNING id')).rows[0]!.id
    const sejour = (await pool.query<{ id: number }>(
      `INSERT INTO sejour (lot_id, locataire_id, periode) VALUES ($1, $2, '[2025-01-01,2026-01-01)') RETURNING id`,
      [lot, locataire])).rows[0]!.id
    regularisation = (await pool.query<{ id: number }>(
      `INSERT INTO regularisation (sejour_id, exercice, montant_du, provisions, date_envoi)
       VALUES ($1, '[2025-01-01,2026-01-01)', 300, 0, '2026-02-01') RETURNING id`, [sejour])).rows[0]!.id
  })

  after(async () => {
    await app.close()
    await pool.end()
    await rm(storageDir, { recursive: true, force: true })
  })

  test('replaced by another invoice: out of the statement, linked both ways, regularisation to check', async () => {
    const saisie = await facture('SAISIE-2025', '300')
    const vraie = await facture('F-2025-1', '320')
    assert.deepEqual(await charges(), ['620'])

    assert.equal((await app.inject({ method: 'POST', url: `/api/factures/${saisie}/remplacer`, payload: { par: vraie } })).statusCode, 400)
    const replaced = await app.inject({
      method: 'POST', url: `/api/factures/${saisie}/remplacer`, payload: { par: vraie, motif: 'Saisie à la main, remplacée par le PDF' },
    })
    assert.equal(replaced.statusCode, 200, replaced.body)
    const r = replaced.json()
    assert.equal(r.facture.statut, 'remplacee')
    assert.equal(r.liens.remplacante.id, vraie)
    assert.deepEqual(r.regularisations.map((x: { id: number }) => x.id), [regularisation])
    assert.deepEqual(await charges(), ['320'])
    assert.equal((await app.inject(`/api/factures/${vraie}`)).json().liens.remplacees[0].id, saisie)

    // Never changed nor deleted, never replaced twice
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/factures/${saisie}` })).statusCode, 409)
    assert.equal((await app.inject({
      method: 'POST', url: `/api/factures/${saisie}/remplacer`, payload: { par: vraie, motif: 'encore' },
    })).statusCode, 409)
    // The number of a replaced invoice can be typed again
    const again = await app.inject({
      method: 'POST', url: `/api/factures?immeuble=${immeuble}`,
      payload: { fournisseur: 'Eau Exemple', energie: 'eau', numero: 'SAISIE-2025', date_facture: '2025-12-31', montant_ttc: '1' },
    })
    assert.equal(again.statusCode, 201, again.body)
    await app.inject({ method: 'DELETE', url: `/api/factures/${again.json().facture.id}` })
  })

  test('corrected: a draft copy with the same number replaces it once validated', async () => {
    const vraie = (await pool.query<{ id: number }>('SELECT id FROM facture WHERE numero = \'F-2025-1\'')).rows[0]!.id
    const draft = await app.inject({ method: 'POST', url: `/api/factures/${vraie}/corriger` })
    assert.equal(draft.statusCode, 201, draft.body)
    const copie = draft.json()
    assert.deepEqual([copie.facture.statut, copie.facture.numero, copie.liens.corrige.id], ['a_verifier', 'F-2025-1', vraie])
    assert.equal(copie.lignes.length, 1)
    // One correction at a time; the original still counts until the draft is validated
    assert.equal((await app.inject({ method: 'POST', url: `/api/factures/${vraie}/corriger` })).statusCode, 409)
    assert.deepEqual(await charges(), ['320'])

    const id = copie.facture.id
    await app.inject({
      method: 'PUT', url: `/api/factures/${id}`,
      payload: { ...copie.facture, note: 'période corrigée', lignes: [ligne('320', '2025-06-30')] },
    })
    const validated = await app.inject({ method: 'POST', url: `/api/factures/${id}/valider` })
    assert.equal(validated.statusCode, 200, validated.body)
    assert.deepEqual(validated.json().regularisations.map((x: { id: number }) => x.id), [regularisation])
    const ancienne = (await app.inject(`/api/factures/${vraie}`)).json().facture
    assert.deepEqual([ancienne.statut, ancienne.remplacee_par, ancienne.motif_remplacement], ['remplacee', id, 'Corrigée : période corrigée'])
    assert.deepEqual(await charges(), ['320'])
  })

  test('an abandoned correction leaves the original validated', async () => {
    const id = await facture('F-2025-2', '10')
    const draft = (await app.inject({ method: 'POST', url: `/api/factures/${id}/corriger` })).json()
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/factures/${draft.facture.id}` })).statusCode, 204)
    assert.equal((await app.inject(`/api/factures/${id}`)).json().facture.statut, 'validee')
  })
})

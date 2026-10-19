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
  let extracteur: number
  let sejour: number
  let immeuble: number
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
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="releve"\r\n\r\n${JSON.stringify(releve)}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="r.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
        await pdf(), Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    })
  }

  const releve = (date: string, precedent: string, nouveau: string, mouvements: object[]) => ({
    extracteur_id: extracteur, compte: '00012345601', date_releve: date, solde_precedent: precedent, nouveau_solde: nouveau,
    totaux: null, mouvements,
  })
  const mvt = (date: string, libelle: string, montant: string, detail: string | null = null) =>
    ({ date_operation: date, date_valeur: date, libelle, detail, montant })

  before(async () => {
    pool = createTestPool()
    await resetDatabase(pool)
    storageDir = await mkdtemp(join(tmpdir(), 'crb-pdf-'))
    app = await buildApp({ db: pool, storageDir })
    await pool.query('INSERT INTO fournisseur (nom) VALUES (\'Banque Exemple\')')
    extracteur = (await pool.query<{ id: number }>(
      `INSERT INTO extracteur (fournisseur_id, version, type, energie, reglages, source, code, moteur)
       SELECT id, 1, 'releve', NULL, '{}', 'source', 'code', 2 FROM fournisseur WHERE nom = 'Banque Exemple' RETURNING id`)).rows[0]!.id
    immeuble = (await pool.query<{ id: number }>(
      'INSERT INTO immeuble (code, nom) VALUES (\'IMM1\', \'Immeuble fictif\') RETURNING id')).rows[0]!.id
    const lot = (await pool.query<{ id: number }>(
      'INSERT INTO lot (immeuble_id, code, tantiemes) VALUES ($1, \'L1\', 100) RETURNING id', [immeuble])).rows[0]!.id
    const locataire = (await pool.query<{ id: number }>(
      'INSERT INTO locataire (nom) VALUES (\'Alice Exemple\') RETURNING id')).rows[0]!.id
    sejour = (await pool.query<{ id: number }>(
      `INSERT INTO sejour (lot_id, locataire_id, periode) VALUES ($1, $2, '[2026-01-01,)') RETURNING id`,
      [lot, locataire])).rows[0]!.id
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
    assert.deepEqual(r.json().mouvements.map((m: { montant: string, statut: string }) => [m.montant, m.statut]),
      [['600.00', 'a_categoriser'], ['-149.50', 'a_categoriser']])
    assert.deepEqual(await readdir(join(storageDir, 'releves')).then((f) => f.length), 1)
    assert.equal((await importer(releve('2026-01-16', '1000', '1000', []))).statusCode, 409)

    // The next one follows; the one after a gap does not
    assert.equal((await importer(releve('2026-02-02', '1450.50', '2050.50', [mvt('2026-02-04', 'VIR DE ALICE EXEMPLE', '600')]))).statusCode, 201)
    assert.equal((await importer(releve('2026-03-02', '9999', '9999', []))).statusCode, 201)
    const suites = (await app.inject('/api/releves')).json().map((x: { date_releve: string, suite: boolean | null }) => [x.date_releve, x.suite])
    assert.deepEqual(suites, [['2026-03-02', false], ['2026-02-02', true], ['2026-01-16', null]])
  })

  const mouvement = async (id: number) => (await app.inject('/api/mouvements')).json().find((x: { id: number }) => x.id === id)

  test('a credit becomes payments of a tenant, up to its amount; deleting one leaves it incomplete', async () => {
    const [credit] = (await app.inject('/api/mouvements?statut=a_categoriser')).json()
    assert.equal(credit.libelle, 'VIR DE ALICE EXEMPLE')
    const payer = (montant: string, mois: string, extra: object = {}) => app.inject({
      method: 'POST', url: '/api/paiements',
      payload: { sejour_id: sejour, date_paiement: credit.date_operation, mois, loyer: montant, provision: '0', mode: 'virement', mouvement_id: credit.id, ...extra },
    })
    const p1 = await payer('400', '2026-01')
    assert.equal(p1.statusCode, 201, p1.body)
    let m = await mouvement(credit.id)
    assert.deepEqual([m.categorie, m.statut, m.couvert], ['locataire', 'incomplet', '400.00'])
    assert.equal((await payer('300', '2026-02')).statusCode, 400)
    // A regularisation chosen without an amount is refused
    assert.equal((await payer('0', '2026-02', { regularisation_id: 1, regularisation: '0' })).statusCode, 400)
    assert.equal((await payer('200', '2026-02')).statusCode, 201)
    m = (await app.inject('/api/mouvements?statut=categorise&categorie=locataire')).json()
    assert.deepEqual(m.map((x: { id: number }) => x.id), [credit.id])
    assert.equal(m[0].paiements.length, 2)

    // A change from the Paiements screen (without mouvement_id) keeps the link
    await app.inject({ method: 'PUT', url: `/api/paiements/${p1.json().id}`, payload: { ...(p1.json() as object), mouvement_id: undefined, note: 'vu' } })
    assert.equal((await pool.query('SELECT mouvement_id FROM paiement WHERE id = $1', [p1.json().id])).rows[0].mouvement_id, credit.id)

    // A debit carries a refund only; a movement with payments keeps its category; a categorised statement is kept
    const [debit] = (await app.inject('/api/mouvements?statut=a_categoriser')).json()
    assert.equal((await app.inject({
      method: 'POST', url: '/api/paiements', payload: { sejour_id: sejour, date_paiement: '2026-01-06', mois: '2026-01', loyer: '1', mouvement_id: debit.id },
    })).statusCode, 400)
    assert.equal((await app.inject({ method: 'PUT', url: `/api/mouvements/${credit.id}/categorie`, payload: { categorie: 'emprunt' } })).statusCode, 409)
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/mouvements/${credit.id}/categorie` })).statusCode, 409)
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/releves/${credit.releve_id}` })).statusCode, 409)

    await app.inject({ method: 'DELETE', url: `/api/paiements/${p1.json().id}` })
    assert.equal((await mouvement(credit.id)).statut, 'incomplet')
    // A note does not complete it: only a detail that covers the amount does
    const note = await app.inject({ method: 'PUT', url: `/api/mouvements/${credit.id}/categorie`, payload: { categorie: 'locataire', note: 'Dépôt de garantie' } })
    assert.deepEqual([note.json().statut, note.json().note], ['incomplet', 'Dépôt de garantie'])
    await app.inject({ method: 'PUT', url: `/api/mouvements/${credit.id}/categorie`, payload: { categorie: 'locataire' } })
  })

  test('a debit is categorised, then not; a payment typed by hand is linked', async () => {
    const debit = (await app.inject('/api/mouvements?statut=a_categoriser')).json().find((x: { montant: string }) => x.montant.startsWith('-'))
    assert.equal((await app.inject({ method: 'PUT', url: `/api/mouvements/${debit.id}/categorie`, payload: {} })).statusCode, 400)
    assert.equal((await app.inject({ method: 'PUT', url: `/api/mouvements/${debit.id}/categorie`, payload: { categorie: 'autre' } })).statusCode, 400)
    const emprunt = await app.inject({ method: 'PUT', url: `/api/mouvements/${debit.id}/categorie`, payload: { categorie: 'emprunt' } })
    assert.deepEqual([emprunt.json().statut, emprunt.json().categorie], ['categorise', 'emprunt'])
    // Works on a movement of another category are refused
    const facture = await app.inject({
      method: 'POST', url: '/api/travaux',
      payload: { immeuble_id: immeuble, fournisseur: 'X', description: 'Y', nature: 'entretien', date_facture: '2026-01-06', montant_ttc: '149.50' },
    })
    assert.equal((await app.inject({ method: 'POST', url: `/api/mouvements/${debit.id}/lier`, payload: { travaux_id: facture.json().id } })).statusCode, 400)
    await app.inject({ method: 'DELETE', url: `/api/travaux/${facture.json().id}` })
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/mouvements/${debit.id}/categorie` })).json().statut, 'a_categoriser')

    const fevrier = (await app.inject('/api/mouvements?statut=a_categoriser')).json().find((x: { date_operation: string }) => x.date_operation === '2026-02-04')
    const main = await app.inject({
      method: 'POST', url: '/api/paiements', payload: { sejour_id: sejour, date_paiement: '2026-02-04', mois: '2026-03', loyer: '600', mode: 'virement' },
    })
    assert.deepEqual((await mouvement(fevrier.id)).possibles.map((x: { type: string, id: number }) => [x.type, x.id]), [['paiement', main.json().id]])
    const lie = await app.inject({ method: 'POST', url: `/api/mouvements/${fevrier.id}/lier`, payload: { paiement_id: main.json().id } })
    assert.deepEqual([lie.json().categorie, lie.json().statut], ['locataire', 'categorise'])
    const delie = await app.inject({ method: 'POST', url: `/api/mouvements/${fevrier.id}/delier`, payload: { paiement_id: main.json().id } })
    assert.equal(delie.json().statut, 'incomplet')

    // Two months typed as two payments, paid by one transfer: proposed together
    const second = await app.inject({
      method: 'POST', url: '/api/paiements', payload: { sejour_id: sejour, date_paiement: '2026-02-05', mois: '2026-04', loyer: '0.5', mode: 'virement' },
    })
    await app.inject({ method: 'PUT', url: `/api/paiements/${main.json().id}`, payload: { ...(main.json() as object), loyer: '599.5', mouvement_id: null } })
    const groupe = (await mouvement(fevrier.id)).possibles
    assert.deepEqual(groupe.map((x: { type: string, ids: number[] }) => [x.type, x.ids]), [['groupe', [main.json().id, second.json().id]]])
    const tous = await app.inject({ method: 'POST', url: `/api/mouvements/${fevrier.id}/lier`, payload: { paiement_ids: groupe[0].ids } })
    assert.deepEqual([tous.json().statut, tous.json().paiements.length], ['categorise', 2])
  })

  test('works paid by two transfers; a deposit paid with the rent, then refunded alone', async () => {
    const r = await importer(releve('2026-04-30', '9999', '8099', [
      mvt('2026-03-10', 'VIR ACOMPTE DEVIS', '-1000'),
      mvt('2026-03-12', 'VIR DE ALICE EXEMPLE', '1000'),
      mvt('2026-04-10', 'VIR SOLDE FACTURE', '-1500'),
      mvt('2026-04-15', 'VIR REMB GARANTIE ALICE', '-400'),
    ]))
    assert.equal(r.statusCode, 201, r.body)
    const [acompte, loyer, solde, remboursement] = r.json().mouvements

    // The invoice first, then the deposit's transfer linked to it: the movement becomes « travaux »
    const travaux = await app.inject({
      method: 'POST', url: '/api/travaux',
      payload: { immeuble_id: immeuble, fournisseur: 'Maçon Exemple', description: 'Ravalement', nature: 'entretien', date_facture: '2026-04-01', montant_ttc: '2500' },
    })
    assert.equal(travaux.statusCode, 201, travaux.body)
    await app.inject({ method: 'POST', url: `/api/mouvements/${acompte.id}/lier`, payload: { travaux_id: travaux.json().id } })
    assert.deepEqual([(await mouvement(acompte.id)).categorie, (await mouvement(acompte.id)).statut], ['travaux', 'categorise'])
    // The balance's transfer: what remains of the invoice is proposed, then linked as a second payment
    assert.deepEqual((await mouvement(solde.id)).possibles.map((x: { type: string, id: number }) => [x.type, x.id]), [['travaux', travaux.json().id]])
    const lie = await app.inject({ method: 'POST', url: `/api/mouvements/${solde.id}/lier`, payload: { travaux_id: travaux.json().id } })
    assert.deepEqual([lie.json().statut, lie.json().travaux[0].total, lie.json().travaux[0].reste], ['categorise', '1500.00', '0.00'])
    // Paid in full: nothing more to link
    assert.equal((await app.inject({ method: 'POST', url: `/api/mouvements/${remboursement.id}/lier`, payload: { travaux_id: travaux.json().id } })).statusCode, 400)

    // 1000 = rent 600 + deposit 400
    await app.inject({
      method: 'POST', url: '/api/paiements',
      payload: { sejour_id: sejour, date_paiement: '2026-03-12', mois: '2026-03', loyer: '600', mode: 'virement', mouvement_id: loyer.id },
    })
    assert.equal((await app.inject({
      method: 'POST', url: '/api/depots', payload: { sejour_id: sejour, date_versement: '2026-03-12', montant: '500', mouvement_id: loyer.id },
    })).statusCode, 400)
    const verse = await app.inject({
      method: 'POST', url: '/api/depots', payload: { sejour_id: sejour, date_versement: '2026-03-12', montant: '400', mouvement_id: loyer.id },
    })
    assert.equal(verse.statusCode, 201, verse.body)
    const m = await mouvement(loyer.id)
    assert.deepEqual([m.categorie, m.statut, m.couvert, m.depots.length], ['locataire', 'categorise', '1000.00', 1])

    // Refunded alone: a negative deposit, the movement becomes « depot_garantie »; a positive one is refused there
    assert.equal((await app.inject({
      method: 'POST', url: '/api/depots', payload: { sejour_id: sejour, date_versement: '2026-04-15', montant: '400', mouvement_id: remboursement.id },
    })).statusCode, 400)
    const rendu = await app.inject({
      method: 'POST', url: '/api/depots', payload: { sejour_id: sejour, date_versement: '2026-04-15', montant: '-400' },
    })
    const lieDepot = await app.inject({ method: 'POST', url: `/api/mouvements/${remboursement.id}/lier`, payload: { depot_id: rendu.json().id } })
    assert.deepEqual([lieDepot.json().categorie, lieDepot.json().statut], ['depot_garantie', 'categorise'])
    assert.equal((await app.inject({ method: 'PUT', url: `/api/mouvements/${remboursement.id}/categorie`, payload: { categorie: 'travaux' } })).statusCode, 409)
    assert.deepEqual((await app.inject(`/api/depots?immeuble=${immeuble}`)).json().map((d: { montant: string }) => d.montant), ['400.00', '-400.00'])
    const delie = await app.inject({ method: 'POST', url: `/api/mouvements/${remboursement.id}/delier`, payload: { depot_id: rendu.json().id } })
    assert.equal(delie.json().statut, 'incomplet')
  })

  test('a storage written before the folders is put in order at start-up', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crb-rangement-'))
    try {
      await writeFile(join(dir, 'aaa.pdf'), '%PDF-1')
      await writeFile(join(dir, 'inconnu.pdf'), '%PDF-1')
      const facture = (await pool.query<{ id: number }>(
        `INSERT INTO facture (immeuble_id, fournisseur_id, energie, numero, fichier_pdf)
         SELECT (SELECT id FROM immeuble LIMIT 1), id, 'eau', 'R1', 'factures/aaa.pdf' FROM fournisseur WHERE nom = 'Banque Exemple'
         RETURNING id`)).rows[0]!.id
      assert.equal(await rangerStockage(pool, dir), 1)
      await access(join(dir, 'factures', 'aaa.pdf'))
      assert.deepEqual((await readdir(dir)).sort(), ['factures', 'inconnu.pdf'])
      assert.equal(await rangerStockage(pool, dir), 0)
      await pool.query('DELETE FROM facture WHERE id = $1', [facture])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

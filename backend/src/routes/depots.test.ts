import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import type pg from 'pg'

import { buildApp } from '../app.js'
import { createTestPool, resetDatabase, skipWithoutDatabase } from '../test/database.js'

// The deposit of a stay (ADR 0021): paid, then kept to cover an unpaid month and two regularisations (a retention, made
// of payments « depot »), the rest refunded. The retention settles the regularisations, lowers the deposit held, is
// changed from the stay only, never seen at the bank, and is the deposit kept of the tax summary.

describe('deposit of a stay', { skip: skipWithoutDatabase }, () => {
  let pool: pg.Pool
  let app: Awaited<ReturnType<typeof buildApp>>
  let storageDir: string
  let immeuble: number
  let sejour: number
  const regul: number[] = []

  const sejourLu = async () => (await app.inject(`/api/sejours?immeuble=${immeuble}`)).json()[0]
  const regulLue = async (id: number) => (await app.inject(`/api/regularisations/${id}`)).json()
  const retenue = (lignes: object[], date = '2024-12-31') =>
    app.inject({ method: 'PUT', url: `/api/sejours/${sejour}/retenue`, payload: { date, lignes } })

  before(async () => {
    pool = createTestPool()
    await resetDatabase(pool)
    storageDir = await mkdtemp(join(tmpdir(), 'crb-pdf-'))
    app = await buildApp({ db: pool, storageDir })
    immeuble = (await pool.query<{ id: number }>('INSERT INTO immeuble (code, nom) VALUES (\'IMM1\', \'Immeuble fictif\') RETURNING id')).rows[0]!.id
    const lot = (await pool.query<{ id: number }>('INSERT INTO lot (immeuble_id, code, tantiemes) VALUES ($1, \'L1\', 100) RETURNING id', [immeuble])).rows[0]!.id
    const locataire = (await pool.query<{ id: number }>('INSERT INTO locataire (nom) VALUES (\'Bob Exemple\') RETURNING id')).rows[0]!.id
    sejour = (await pool.query<{ id: number }>(
      `INSERT INTO sejour (lot_id, locataire_id, periode, depot_garantie) VALUES ($1, $2, '[2022-01-01,2025-01-01)', 500) RETURNING id`,
      [lot, locataire])).rows[0]!.id
    // Two regularisations sent: 2023 (300, 100 paid by cheque), 2024 (400)
    for (const [exercice, solde, envoi] of [['[2023-01-01,2024-01-01)', 300, '2024-03-01'], ['[2024-01-01,2025-01-01)', 400, '2025-03-01']]) {
      regul.push((await pool.query<{ id: number }>(
        `INSERT INTO regularisation (sejour_id, exercice, montant_du, provisions, date_envoi) VALUES ($1, $2, $3, 0, $4) RETURNING id`,
        [sejour, exercice, solde, envoi])).rows[0]!.id)
    }
    await pool.query(`INSERT INTO paiement (sejour_id, date_paiement, regularisation_id, regularisation, mode) VALUES ($1, '2024-04-01', $2, 100, 'cheque')`,
      [sejour, regul[0]])
  })

  after(async () => {
    await app.close()
    await pool.end()
    await rm(storageDir, { recursive: true, force: true })
  })

  test('a deposit paid without a transfer, then kept for a month and the regularisations', async () => {
    assert.equal((await app.inject({ method: 'POST', url: '/api/depots', payload: { sejour_id: sejour, date_versement: '2022-01-01', montant: '500', note: 'agence' } })).statusCode, 201)
    assert.equal((await sejourLu()).depot_detenu, '500.00')

    // More than the deposit, or than what a regularisation lacks: refused
    assert.equal((await retenue([{ regularisation_id: regul[1], regularisation: '600' }])).statusCode, 400)
    assert.match((await retenue([{ regularisation_id: regul[0], regularisation: '250' }])).json().message, /reste est 200\.00/)
    assert.match((await retenue([{ mois: '2025-02', loyer: '10' }])).json().message, /hors du séjour/)

    const r = await retenue([
      { mois: '2024-12', loyer: '80', provision: '20' },
      { regularisation_id: regul[0], regularisation: '200' },
      { regularisation_id: regul[1], regularisation: '150' },
    ])
    assert.equal(r.statusCode, 200, r.body)
    assert.equal(r.json().length, 3)
    const s = await sejourLu()
    assert.deepEqual([s.depot_detenu, s.depot_retenu], ['50.00', '450.00'])
    assert.deepEqual([(await regulLue(regul[0]!)).etat, (await regulLue(regul[1]!)).montant_recu], ['soldee', '150.00'])

    // Replaced as a whole: the same call again does not add up
    assert.equal((await retenue([
      { mois: '2024-12', loyer: '80', provision: '20' },
      { regularisation_id: regul[0], regularisation: '200' },
      { regularisation_id: regul[1], regularisation: '150' },
    ])).statusCode, 200)
    assert.equal((await sejourLu()).depot_retenu, '450.00')
  })

  test('a retention payment is changed from the stay only, and never linked to the bank', async () => {
    const { rows: [p] } = await pool.query<{ id: number }>(`SELECT id FROM paiement WHERE mode = 'depot' LIMIT 1`)
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/paiements/${p!.id}` })).statusCode, 400)
    assert.equal((await app.inject({ method: 'PUT', url: `/api/paiements/${p!.id}`, payload: { sejour_id: sejour, date_paiement: '2024-12-31', mois: '2024-12', loyer: '1' } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'POST', url: '/api/paiements', payload: { sejour_id: sejour, date_paiement: '2024-12-31', mois: '2024-11', loyer: '1', mode: 'depot' } })).statusCode, 400)
    await assert.rejects(pool.query('UPDATE paiement SET mouvement_id = 1 WHERE id = $1', [p!.id]))
  })

  test('the deposit cannot fall below the retention; the rest is refunded', async () => {
    const [verse] = (await app.inject(`/api/depots?immeuble=${immeuble}`)).json()
    assert.match((await app.inject({ method: 'DELETE', url: `/api/depots/${verse.id}` })).json().message, /dépasserait le dépôt versé/)
    assert.equal((await app.inject({ method: 'POST', url: '/api/depots', payload: { sejour_id: sejour, date_versement: '2025-01-15', montant: '-50' } })).statusCode, 201)
    assert.equal((await sejourLu()).depot_detenu, '0.00')
    assert.equal((await app.inject({ method: 'POST', url: '/api/depots', payload: { sejour_id: sejour, date_versement: '2025-01-16', montant: '-1' } })).statusCode, 400)
  })

  test('the tax summary of the departure: the retention toward regularisations is the deposit kept, not a payment', async () => {
    const f = (await app.inject(`/api/fiscal?immeuble=${immeuble}&annee=2024`)).json()
    const d = f.departs[0]
    assert.equal(d.depot_retenu, '350.00')
    assert.equal(d.versements, '100.00')
  })

  test('the start of the management of the building: the years before are not counted (ADR 0023)', async () => {
    const majImmeuble = (debut_gestion: string | null) => app.inject({
      method: 'PUT', url: `/api/immeubles/${immeuble}`, payload: { nom: 'Immeuble fictif', adresse: null, debut_gestion },
    })
    assert.equal((await majImmeuble('2024-01-01')).json().debut_gestion, '2024-01-01')
    const d = (await app.inject(`/api/fiscal?immeuble=${immeuble}&annee=2024`)).json().departs[0]
    // The cheque paid the regularisation 2023, before the start: not counted any more
    assert.deepEqual([d.debut_calcul, d.versements], ['2024-01-01', '0'])
    await majImmeuble(null)
    assert.equal((await app.inject(`/api/fiscal?immeuble=${immeuble}&annee=2024`)).json().departs[0].debut_calcul, '2022-01-01')
  })

  test('removed: the regularisations open again, the deposit is held again', async () => {
    assert.equal((await retenue([])).statusCode, 200)
    const s = await sejourLu()
    assert.deepEqual([s.depot_detenu, s.depot_retenu], ['450.00', null])
    assert.equal((await regulLue(regul[0]!)).etat, 'en_attente')
  })
})

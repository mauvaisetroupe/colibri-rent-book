import Big from 'big.js'
import type { FastifyPluginAsync } from 'fastify'
import type { Pool, PoolClient } from 'pg'

import { categoriserSiVide, verifierMouvement } from '../couverture.js'
import {
  body, idParam, InputError, optionalDecimal, optionalText, query, requiredDate, requiredDecimal, requiredId, sendError,
} from '../http.js'

// Deposits (ADR 0019, 0021), managed from the stay: what a tenant paid (positive) and what was refunded to them
// (negative), linked to their bank movement like a payment (or to none: paid to an agency, before the statements);
// and the retention, what is kept to cover what the tenant owes: payments of the mode « depot » toward unpaid months or
// regularisations, never seen at the bank, made and replaced as a whole here. What the owner holds for a stay is the
// deposits less the retention; the amount of the lease stays sejour.depot_garantie.

const NOTE_RETENUE = 'Retenue sur le dépôt de garantie'

const COLUMNS = `vd.id, vd.sejour_id, lo.nom AS locataire, lt.code AS lot, vd.date_versement::text, vd.montant::text,
  vd.mouvement_id, vd.note`
const FROM = `versement_depot vd JOIN sejour s ON s.id = vd.sejour_id JOIN lot lt ON lt.id = s.lot_id
  JOIN locataire lo ON lo.id = s.locataire_id`

type Saisie = { sejour_id: number, date_versement: string, montant: string, mouvement_id: number | null, note: string | null }

function readDepot(raw: Record<string, unknown>): Saisie {
  const montant = requiredDecimal(raw.montant, 'Montant')
  if (new Big(montant).eq(0)) {
    throw new InputError('Montant : positif s\'il est versé par le locataire, négatif s\'il lui est remboursé')
  }
  return {
    sejour_id: requiredId(raw.sejour_id, 'Séjour'),
    date_versement: requiredDate(raw.date_versement, 'Date'),
    montant,
    mouvement_id: raw.mouvement_id ? requiredId(raw.mouvement_id, 'Mouvement') : null,
    note: optionalText(raw.note),
  }
}

/** Seen on a bank statement: a tenant payment (with the rent) or a deposit alone, of the same sign. */
async function checkMouvement(db: Pool | PoolClient, d: Saisie, id: number | null) {
  if (d.mouvement_id) {
    const montant = new Big(d.montant)
    await verifierMouvement(db, d.mouvement_id, {
      categories: ['locataire', 'depot_garantie'], signe: montant.gt(0) ? 1 : -1, montant, detail: 'versement_depot', exclure: id,
    })
  }
}

/** Deposits paid less refunded, and what the retention keeps, of a stay. */
async function soldeDepot(db: Pool | PoolClient, sejourId: number) {
  const { rows: [r] } = await db.query<{ verse: string, retenu: string }>(
    `SELECT (SELECT coalesce(sum(montant), 0) FROM versement_depot WHERE sejour_id = $1)::text AS verse,
            (SELECT coalesce(sum(loyer + provision + regularisation), 0) FROM paiement
             WHERE sejour_id = $1 AND mode = 'depot')::text AS retenu`, [sejourId])
  return { verse: new Big(r!.verse), retenu: new Big(r!.retenu) }
}

/** A change of the deposits may not leave less than the retention keeps. */
async function checkRetenue(db: Pool | PoolClient, sejourId: number, changement: Big) {
  const { verse, retenu } = await soldeDepot(db, sejourId)
  if (retenu.gt(0) && verse.plus(changement).lt(retenu)) {
    throw new InputError(`La retenue (${retenu.toFixed(2)} €) dépasserait le dépôt versé : modifier d'abord la retenue`)
  }
}

type LigneRetenue = { mois: string | null, loyer: string, provision: string, regularisation_id: number | null, regularisation: string }

function readRetenue(raw: Record<string, unknown>) {
  const date = requiredDate(raw.date, 'Date de la retenue')
  const lignes: LigneRetenue[] = (Array.isArray(raw.lignes) ? raw.lignes : []).map((x: Record<string, unknown>, i: number) => {
    const n = `Ligne ${i + 1}`
    if (x.regularisation_id) {
      const montant = requiredDecimal(x.regularisation, `${n}, montant`)
      if (!new Big(montant).gt(0)) {
        throw new InputError(`${n} : montant positif attendu`)
      }
      return { mois: null, loyer: '0', provision: '0', regularisation_id: requiredId(x.regularisation_id, n), regularisation: montant }
    }
    const loyer = optionalDecimal(x.loyer, `${n}, loyer`) ?? '0'
    const provision = optionalDecimal(x.provision, `${n}, provision`) ?? '0'
    if (new Big(loyer).lt(0) || new Big(provision).lt(0) || new Big(loyer).plus(provision).eq(0)) {
      throw new InputError(`${n} : loyer et provision positifs attendus`)
    }
    return { mois: requiredDate(`${String(x.mois ?? '').slice(0, 7)}-01`, `${n}, mois`), loyer, provision, regularisation_id: null, regularisation: '0' }
  })
  return { date, lignes }
}

const depotRoutes: FastifyPluginAsync<{ db: Pool }> = async (app, { db }) => {
  const load = async (id: number) => (await db.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE vd.id = $1`, [id])).rows[0] ?? null

  // The deposits paid and refunded of a building, by stay then date
  app.get('/depots', async (request, reply) => {
    try {
      const immeuble = requiredId(query(request).immeuble, 'Immeuble')
      const { rows } = await db.query(
        `SELECT ${COLUMNS} FROM ${FROM} WHERE lt.immeuble_id = $1 ORDER BY lt.code, lower(s.periode), vd.date_versement, vd.id`,
        [immeuble])
      return rows
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/depots', async (request, reply) => {
    try {
      const d = readDepot(body(request))
      await checkMouvement(db, d, null)
      await checkRetenue(db, d.sejour_id, new Big(d.montant))
      const { rows: [created] } = await db.query<{ id: number }>(
        `INSERT INTO versement_depot (sejour_id, date_versement, montant, mouvement_id, note)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`, [d.sejour_id, d.date_versement, d.montant, d.mouvement_id, d.note])
      await categoriserSiVide(db, d.mouvement_id, new Big(d.montant).gt(0) ? 'locataire' : 'depot_garantie')
      return reply.code(201).send(await load(created!.id))
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.put('/depots/:id', async (request, reply) => {
    try {
      const raw = body(request)
      const id = idParam(request)
      const d = readDepot(raw)
      // Without « mouvement_id », a change keeps the link to the bank movement
      if (!('mouvement_id' in raw)) {
        const { rows: [actuel] } = await db.query<{ mouvement_id: number | null }>('SELECT mouvement_id FROM versement_depot WHERE id = $1', [id])
        d.mouvement_id = actuel?.mouvement_id ?? null
      }
      await checkMouvement(db, d, id)
      const { rows: [avant] } = await db.query<{ montant: string }>('SELECT montant::text FROM versement_depot WHERE id = $1', [id])
      await checkRetenue(db, d.sejour_id, new Big(d.montant).minus(avant?.montant ?? '0'))
      const { rowCount } = await db.query(
        `UPDATE versement_depot SET sejour_id = $2, date_versement = $3, montant = $4, mouvement_id = $5, note = $6 WHERE id = $1`,
        [id, d.sejour_id, d.date_versement, d.montant, d.mouvement_id, d.note])
      return rowCount ? load(id) : reply.code(404).send({ message: 'Versement introuvable' })
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.delete('/depots/:id', async (request, reply) => {
    try {
      const { rows: [d] } = await db.query<{ sejour_id: number, montant: string }>(
        'SELECT sejour_id, montant::text FROM versement_depot WHERE id = $1', [idParam(request)])
      if (!d) {
        return reply.code(404).send({ message: 'Versement introuvable' })
      }
      await checkRetenue(db, d.sejour_id, new Big(d.montant).neg())
      await db.query('DELETE FROM versement_depot WHERE id = $1', [idParam(request)])
      return reply.code(204).send()
    } catch (error) {
      return sendError(reply, error)
    }
  })

  // The retention of a stay, replaced as a whole (no line: removed). Each line is an unpaid month (rent and provision)
  // or a sent regularisation still open (no more than what it lacks); together no more than the deposit paid.
  app.put('/sejours/:id/retenue', async (request, reply) => {
    const sejourId = idParam(request)
    const client = await db.connect()
    try {
      const { date, lignes } = readRetenue(body(request))
      await client.query('BEGIN')
      const { rows: [sejour] } = await client.query<{ entree: string, sortie: string | null }>(
        'SELECT lower(periode)::text AS entree, (upper(periode) - 1)::text AS sortie FROM sejour WHERE id = $1', [sejourId])
      if (!sejour) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ message: 'Séjour introuvable' })
      }
      await client.query(`DELETE FROM paiement WHERE sejour_id = $1 AND mode = 'depot'`, [sejourId])
      for (const l of lignes.filter((x) => x.mois)) {
        if (l.mois! < `${sejour.entree.slice(0, 7)}-01` || (sejour.sortie && l.mois! > sejour.sortie)) {
          throw new InputError(`${l.mois!.slice(0, 7)} : hors du séjour`)
        }
      }
      // What each regularisation lacks, after its other payments (the retention being replaced)
      const parRegularisation = new Map<number, Big>()
      for (const l of lignes.filter((x) => x.regularisation_id)) {
        parRegularisation.set(l.regularisation_id!, (parRegularisation.get(l.regularisation_id!) ?? new Big(0)).plus(l.regularisation))
      }
      for (const [id, montant] of parRegularisation) {
        const { rows: [r] } = await client.query<{ sejour_id: number, envoyee: boolean, remplacee: boolean, decision: string | null, reste: string }>(
          `SELECT r.sejour_id, r.date_envoi IS NOT NULL AS envoyee, r.decision,
                  EXISTS (SELECT 1 FROM regularisation n WHERE n.remplace_id = r.id) AS remplacee,
                  (r.solde - regularisation_verse(r.id))::text AS reste
           FROM regularisation r WHERE r.id = $1`, [id])
        if (!r || r.sejour_id !== sejourId || !r.envoyee || r.remplacee || r.decision) {
          throw new InputError('Seule une régularisation envoyée, en cours, de ce séjour reçoit une retenue')
        }
        if (montant.gt(r.reste)) {
          throw new InputError(`Retenue de ${montant.toFixed(2)} € sur une régularisation dont le reste est ${new Big(r.reste).toFixed(2)} €`)
        }
      }
      const total = lignes.reduce((t, l) => t.plus(l.loyer).plus(l.provision).plus(l.regularisation), new Big(0))
      const { verse } = await soldeDepot(client, sejourId)
      if (total.gt(verse)) {
        throw new InputError(`Retenue de ${total.toFixed(2)} € pour un dépôt versé de ${verse.toFixed(2)} €`)
      }
      for (const l of lignes) {
        await client.query(
          `INSERT INTO paiement (sejour_id, date_paiement, mois, loyer, provision, regularisation_id, regularisation, mode, note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'depot', $8)`,
          [sejourId, date, l.mois, l.loyer, l.provision, l.regularisation_id, l.regularisation, NOTE_RETENUE])
      }
      await client.query('COMMIT')
      const { rows } = await db.query(
        `SELECT id, date_paiement::text, mois::text, loyer::text, provision::text, regularisation_id, regularisation::text
         FROM paiement WHERE sejour_id = $1 AND mode = 'depot' ORDER BY mois NULLS LAST, regularisation_id, id`, [sejourId])
      return rows
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      return sendError(reply, error)
    } finally {
      client.release()
    }
  })
}

export default depotRoutes

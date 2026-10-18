import Big from 'big.js'
import type { FastifyPluginAsync } from 'fastify'
import type { Pool, PoolClient } from 'pg'

import { categoriserSiVide, verifierMouvement } from '../couverture.js'
import { body, idParam, InputError, optionalText, query, requiredDate, requiredDecimal, requiredId, sendError } from '../http.js'

// Deposits (ADR 0019): what a tenant paid (positive) and what was refunded to them (negative), one row per transfer,
// linked to its bank movement like a payment. What the owner holds for a stay is their sum; the amount of the lease
// stays sejour.depot_garantie, the part kept for unpaid charges sejour.depot_retenu_charges (tax summary).

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
      const { rowCount } = await db.query(
        `UPDATE versement_depot SET sejour_id = $2, date_versement = $3, montant = $4, mouvement_id = $5, note = $6 WHERE id = $1`,
        [id, d.sejour_id, d.date_versement, d.montant, d.mouvement_id, d.note])
      return rowCount ? load(id) : reply.code(404).send({ message: 'Versement introuvable' })
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.delete('/depots/:id', async (request, reply) => {
    const { rowCount } = await db.query('DELETE FROM versement_depot WHERE id = $1', [idParam(request)])
    return rowCount ? reply.code(204).send() : reply.code(404).send({ message: 'Versement introuvable' })
  })
}

export default depotRoutes

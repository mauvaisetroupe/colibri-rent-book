import Big from 'big.js'
import type { FastifyPluginAsync } from 'fastify'
import type { Pool, PoolClient } from 'pg'

import { categoriserSiVide, verifierMouvement } from '../couverture.js'
import {
  body, idParam, InputError, optionalDecimal, optionalText, query, requiredDate, requiredId, sendError,
} from '../http.js'

// Payments received from tenants (ADR 0008): rent and provision of a month, and/or an amount toward a
// regularisation (negative: refund). The provisions of a year come from these payments (view v_provision) as soon as
// the year has one; a regularisation is settled when its payments (corrective chain included) reach its balance
// (computed, ADR 0010). A retention on the deposit (mode « depot », ADR 0021) is a payment too, but made and changed only
// from the deposit of the stay (PUT /sejours/:id/retenue): refused here.

const MODES = ['transfer', 'direct_debit', 'cheque', 'cash', 'other']
export const RETENUE = 'Retenue sur le dépôt de garantie : à modifier depuis le dépôt du séjour (écran Locataires)'

/** A retention on the deposit is changed from the deposit of the stay only. */
async function refuserRetenue(db: Pool, id: number) {
  const { rows: [p] } = await db.query<{ method: string | null }>('SELECT method FROM payment WHERE id = $1', [id])
  if (p?.method === 'deposit') {
    throw new InputError(RETENUE)
  }
}

const COLUMNS = `
  p.id, p.tenancy_id, lo.name AS tenant, lt.code AS unit, p.payment_date::text, p.month::text,
  p.rent::text, p.charge_advance::text, p.charge_adjustment_id, p.charge_adjustment::text, p.method, p.note, p.bank_transaction_id`

const FROM = `payment p
  JOIN tenancy s ON s.id = p.tenancy_id
  JOIN unit lt ON lt.id = s.unit_id
  JOIN tenant lo ON lo.id = s.tenant_id`

type Saisie = {
  tenancy_id: number
  payment_date: string
  month: string | null
  rent: string
  charge_advance: string
  charge_adjustment_id: number | null
  charge_adjustment: string
  method: string | null
  note: string | null
  bank_transaction_id: number | null
}

function readPaiement(raw: Record<string, unknown>): Saisie {
  const month = raw.month ? requiredDate(`${String(raw.month).slice(0, 7)}-01`, 'Mois') : null
  const method = optionalText(raw.method)
  if (method === 'deposit') {
    throw new InputError(RETENUE)
  }
  if (method && !MODES.includes(method)) {
    throw new InputError(`Mode de paiement inconnu : ${method}`)
  }
  const p: Saisie = {
    tenancy_id: requiredId(raw.tenancy_id, 'Séjour'),
    payment_date: requiredDate(raw.payment_date, 'Date du paiement'),
    month,
    rent: optionalDecimal(raw.rent, 'Loyer') ?? '0',
    charge_advance: optionalDecimal(raw.charge_advance, 'Provision') ?? '0',
    charge_adjustment_id: raw.charge_adjustment_id ? requiredId(raw.charge_adjustment_id, 'Régularisation') : null,
    charge_adjustment: optionalDecimal(raw.charge_adjustment, 'Versement de régularisation') ?? '0',
    method,
    note: optionalText(raw.note),
    bank_transaction_id: raw.bank_transaction_id ? requiredId(raw.bank_transaction_id, 'Mouvement') : null,
  }
  if (!month && (Number(p.rent) !== 0 || Number(p.charge_advance) !== 0)) {
    throw new InputError('Indiquer le mois du loyer et de la provision')
  }
  if (!p.charge_adjustment_id && Number(p.charge_adjustment) !== 0) {
    throw new InputError('Choisir la régularisation concernée par ce versement')
  }
  if (p.charge_adjustment_id && Number(p.charge_adjustment) === 0) {
    throw new InputError('Régularisation choisie sans versement : indiquer le montant, ou choisir « Aucune »')
  }
  // Amount received (bank statement), when given: the split must add up to it
  const amount = optionalDecimal(raw.amount, 'Montant reçu')
  if (amount !== null) {
    const reparti = new Big(p.rent).plus(p.charge_advance).plus(p.charge_adjustment)
    if (!reparti.eq(amount)) {
      throw new InputError(`Loyer + provision + régularisation (${reparti.toFixed(2)}) ne retombent pas sur le montant `
        + `reçu (${new Big(amount).toFixed(2)})`)
    }
  }
  return p
}

/** A payment toward a regularisation must target the current (not replaced), sent regularisation of the stay. */
async function checkRegularisation(db: Pool | PoolClient, p: Saisie) {
  if (!p.charge_adjustment_id) {
    return
  }
  const { rows: [r] } = await db.query<{ tenancy_id: number, sent: boolean, replaced: boolean }>(
    `SELECT r.tenancy_id, r.sent_on IS NOT NULL AS sent, EXISTS (SELECT 1 FROM charge_adjustment n WHERE n.replaces_id = r.id) AS replaced
     FROM charge_adjustment r WHERE r.id = $1`,
    [p.charge_adjustment_id],
  )
  if (!r || r.tenancy_id !== p.tenancy_id) {
    throw new InputError('Cette régularisation ne concerne pas ce séjour')
  }
  if (r.replaced) {
    throw new InputError('Cette régularisation a été rectifiée : enregistrer le versement sur le rectificatif')
  }
  if (!r.sent) {
    throw new InputError('Régularisation pas encore envoyée')
  }
}

/**
 * A payment seen on a bank statement (ADR 0018): a payment received on a credit, a refund (negative) on a debit; the
 * detail linked does not exceed the amount (a transfer may pay two months: two payments). The movement must be of the
 * category « locataire », or have none yet.
 */
async function checkMouvement(db: Pool | PoolClient, p: Saisie, id: number | null) {
  if (!p.bank_transaction_id) {
    return
  }
  const payment = new Big(p.rent).plus(p.charge_advance).plus(p.charge_adjustment)
  if (payment.eq(0)) {
    throw new InputError('Un paiement nul ne se rattache pas à un mouvement')
  }
  await verifierMouvement(db, p.bank_transaction_id, {
    categories: ['tenant'], signe: payment.gt(0) ? 1 : -1, amount: payment, detail: 'payment', exclure: id,
  })
}

/** A payment linked to a movement without category: it becomes « locataire ». */
const categoriserMouvement = (db: Pool, p: Saisie) => categoriserSiVide(db, p.bank_transaction_id, 'tenant')

const paiementRoutes: FastifyPluginAsync<{ db: Pool }> = async (app, { db }) => {
  const load = async (id: number) => (await db.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE p.id = $1`, [id])).rows[0]

  // Payments of a calendar year: rent months of the year, and regularisation payments received during it; without
  // « annee », every payment of the building.
  // With « regularisation »: the payments toward it, any year, previous regularisations of its corrective chain included.
  app.get('/paiements', async (request, reply) => {
    try {
      const q = query(request)
      const building = requiredId(q.building, 'Immeuble')
      if (q.charge_adjustment !== undefined) {
        const { rows } = await db.query(
          `WITH RECURSIVE chaine AS (
             SELECT id, replaces_id FROM charge_adjustment WHERE id = $2
             UNION ALL
             SELECT r.id, r.replaces_id FROM charge_adjustment r JOIN chaine c ON r.id = c.replaces_id
           )
           SELECT ${COLUMNS} FROM ${FROM}
           WHERE lt.building_id = $1 AND p.charge_adjustment_id IN (SELECT id FROM chaine)
           ORDER BY p.payment_date, p.id`,
          [building, requiredId(q.charge_adjustment, 'Régularisation')],
        )
        return rows
      }
      const year = q.year ? Number(q.year) : null
      if (year !== null && !Number.isInteger(year)) {
        throw new InputError('Année invalide')
      }
      const { rows } = await db.query(
        `SELECT ${COLUMNS} FROM ${FROM}
         WHERE lt.building_id = $1
           AND ($2::int IS NULL OR extract(year FROM p.month) = $2
                OR (p.month IS NULL AND extract(year FROM p.payment_date) = $2))
         ORDER BY p.payment_date, p.id`,
        [building, year],
      )
      return rows
    } catch (error) {
      return sendError(reply, error)
    }
  })

  /**
   * Monthly entry: the stays present during the month, whether they already paid it, and the amounts of their last
   * paid month as a suggestion.
   */
  app.get('/paiements/mois', async (request, reply) => {
    try {
      const q = query(request)
      const building = requiredId(q.building, 'Immeuble')
      const month = requiredDate(`${String(q.month ?? '').slice(0, 7)}-01`, 'Mois')
      const { rows } = await db.query(
        `SELECT s.id AS tenancy_id, lo.name AS tenant, lt.code AS unit,
                (SELECT json_agg(json_build_object('id', p.id, 'rent', p.rent::text, 'charge_advance', p.charge_advance::text,
                   'payment_date', p.payment_date::text, 'method', p.method) ORDER BY p.payment_date)
                 FROM payment p WHERE p.tenancy_id = s.id AND p.month = $2) AS payments,
                (SELECT json_build_object('rent', p.rent::text, 'charge_advance', p.charge_advance::text, 'method', p.method)
                 FROM payment p WHERE p.tenancy_id = s.id AND p.month < $2 ORDER BY p.month DESC, p.id DESC LIMIT 1)
                  AS previous
         FROM tenancy s JOIN unit lt ON lt.id = s.unit_id JOIN tenant lo ON lo.id = s.tenant_id
         WHERE lt.building_id = $1 AND s.period && daterange($2, ($2 + interval '1 month')::date)
         ORDER BY lt.code, lower(s.period)`,
        [building, month],
      )
      return rows
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/paiements', async (request, reply) => {
    try {
      const p = readPaiement(body(request))
      await checkRegularisation(db, p)
      await checkMouvement(db, p, null)
      const { rows: [created] } = await db.query<{ id: number }>(
        `INSERT INTO payment (tenancy_id, payment_date, month, rent, charge_advance, charge_adjustment_id, charge_adjustment, method, note,
                               bank_transaction_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [p.tenancy_id, p.payment_date, p.month, p.rent, p.charge_advance, p.charge_adjustment_id, p.charge_adjustment, p.method, p.note,
          p.bank_transaction_id],
      )
      await categoriserMouvement(db, p)
      return reply.code(201).send(await load(created!.id))
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.put('/paiements/:id', async (request, reply) => {
    try {
      const id = idParam(request)
      await refuserRetenue(db, id)
      const raw = body(request)
      const p = readPaiement(raw)
      // Without « mouvement_id », a change keeps the link to the bank movement (Paiements screen)
      const garderLien = !('bank_transaction_id' in raw)
      if (garderLien) {
        p.bank_transaction_id = (await db.query<{ bank_transaction_id: number | null }>(
          'SELECT bank_transaction_id FROM payment WHERE id = $1', [id])).rows[0]?.bank_transaction_id ?? null
      }
      await checkRegularisation(db, p)
      await checkMouvement(db, p, id)
      const { rows: [before] } = await db.query<{ charge_adjustment_id: number | null }>(
        'SELECT charge_adjustment_id FROM payment WHERE id = $1',
        [id],
      )
      if (!before) {
        return reply.code(404).send({ message: 'Paiement introuvable' })
      }
      await db.query(
        `UPDATE payment SET tenancy_id = $2, payment_date = $3, month = $4, rent = $5, charge_advance = $6,
           charge_adjustment_id = $7, charge_adjustment = $8, method = $9, note = $10, bank_transaction_id = $11 WHERE id = $1`,
        [id, p.tenancy_id, p.payment_date, p.month, p.rent, p.charge_advance, p.charge_adjustment_id, p.charge_adjustment, p.method, p.note,
          p.bank_transaction_id],
      )
      await categoriserMouvement(db, p)
      return load(id)
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.delete('/paiements/:id', async (request, reply) => {
    try {
      await refuserRetenue(db, idParam(request))
      const { rows: [deleted] } = await db.query<{ charge_adjustment_id: number | null }>(
        'DELETE FROM payment WHERE id = $1 RETURNING charge_adjustment_id',
        [idParam(request)],
      )
      if (!deleted) {
        return reply.code(404).send({ message: 'Paiement introuvable' })
      }
      return reply.code(204).send()
    } catch (error) {
      return sendError(reply, error)
    }
  })
}

export default paiementRoutes

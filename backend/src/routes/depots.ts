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

const COLUMNS = `vd.id, vd.tenancy_id, lo.name AS tenant, lt.code AS unit, vd.payment_date::text, vd.amount::text,
  vd.bank_transaction_id, vd.note`
const FROM = `deposit_payment vd JOIN tenancy s ON s.id = vd.tenancy_id JOIN unit lt ON lt.id = s.unit_id
  JOIN tenant lo ON lo.id = s.tenant_id`

type Saisie = { tenancy_id: number, payment_date: string, amount: string, bank_transaction_id: number | null, note: string | null }

function readDepot(raw: Record<string, unknown>): Saisie {
  const amount = requiredDecimal(raw.amount, 'Montant')
  if (new Big(amount).eq(0)) {
    throw new InputError('Montant : positif s\'il est versé par le locataire, négatif s\'il lui est remboursé')
  }
  return {
    tenancy_id: requiredId(raw.tenancy_id, 'Séjour'),
    payment_date: requiredDate(raw.payment_date, 'Date'),
    amount,
    bank_transaction_id: raw.bank_transaction_id ? requiredId(raw.bank_transaction_id, 'Mouvement') : null,
    note: optionalText(raw.note),
  }
}

/** Seen on a bank statement: a tenant payment (with the rent) or a deposit alone, of the same sign. */
async function checkMouvement(db: Pool | PoolClient, d: Saisie, id: number | null) {
  if (d.bank_transaction_id) {
    const amount = new Big(d.amount)
    await verifierMouvement(db, d.bank_transaction_id, {
      categories: ['tenant', 'security_deposit'], signe: amount.gt(0) ? 1 : -1, amount, detail: 'deposit_payment', exclure: id,
    })
  }
}

/** Deposits paid less refunded, and what the retention keeps, of a stay. */
async function soldeDepot(db: Pool | PoolClient, sejourId: number) {
  const { rows: [r] } = await db.query<{ paid: string, retained: string }>(
    `SELECT (SELECT coalesce(sum(amount), 0) FROM deposit_payment WHERE tenancy_id = $1)::text AS paid,
            (SELECT coalesce(sum(rent + charge_advance + charge_adjustment), 0) FROM payment
             WHERE tenancy_id = $1 AND method = 'deposit')::text AS retained`, [sejourId])
  return { paid: new Big(r!.paid), retained: new Big(r!.retained) }
}

/** A change of the deposits may not leave less than the retention keeps. */
async function checkRetenue(db: Pool | PoolClient, sejourId: number, changement: Big) {
  const { paid, retained } = await soldeDepot(db, sejourId)
  if (retained.gt(0) && paid.plus(changement).lt(retained)) {
    throw new InputError(`La retenue (${retained.toFixed(2)} €) dépasserait le dépôt versé : modifier d'abord la retenue`)
  }
}

type LigneRetenue = { month: string | null, rent: string, charge_advance: string, charge_adjustment_id: number | null, charge_adjustment: string }

function readRetenue(raw: Record<string, unknown>) {
  const date = requiredDate(raw.date, 'Date de la retenue')
  const lines: LigneRetenue[] = (Array.isArray(raw.lines) ? raw.lines : []).map((x: Record<string, unknown>, i: number) => {
    const n = `Ligne ${i + 1}`
    if (x.charge_adjustment_id) {
      const amount = requiredDecimal(x.charge_adjustment, `${n}, montant`)
      if (!new Big(amount).gt(0)) {
        throw new InputError(`${n} : montant positif attendu`)
      }
      return { month: null, rent: '0', charge_advance: '0', charge_adjustment_id: requiredId(x.charge_adjustment_id, n), charge_adjustment: amount }
    }
    const rent = optionalDecimal(x.rent, `${n}, loyer`) ?? '0'
    const charge_advance = optionalDecimal(x.charge_advance, `${n}, provision`) ?? '0'
    if (new Big(rent).lt(0) || new Big(charge_advance).lt(0) || new Big(rent).plus(charge_advance).eq(0)) {
      throw new InputError(`${n} : loyer et provision positifs attendus`)
    }
    return { month: requiredDate(`${String(x.month ?? '').slice(0, 7)}-01`, `${n}, mois`), rent, charge_advance, charge_adjustment_id: null, charge_adjustment: '0' }
  })
  return { date, lines }
}

const depotRoutes: FastifyPluginAsync<{ db: Pool }> = async (app, { db }) => {
  const load = async (id: number) => (await db.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE vd.id = $1`, [id])).rows[0] ?? null

  // The deposits paid and refunded of a building, by stay then date
  app.get('/depots', async (request, reply) => {
    try {
      const building = requiredId(query(request).building, 'Immeuble')
      const { rows } = await db.query(
        `SELECT ${COLUMNS} FROM ${FROM} WHERE lt.building_id = $1 ORDER BY lt.code, lower(s.period), vd.payment_date, vd.id`,
        [building])
      return rows
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/depots', async (request, reply) => {
    try {
      const d = readDepot(body(request))
      await checkMouvement(db, d, null)
      await checkRetenue(db, d.tenancy_id, new Big(d.amount))
      const { rows: [created] } = await db.query<{ id: number }>(
        `INSERT INTO deposit_payment (tenancy_id, payment_date, amount, bank_transaction_id, note)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`, [d.tenancy_id, d.payment_date, d.amount, d.bank_transaction_id, d.note])
      await categoriserSiVide(db, d.bank_transaction_id, new Big(d.amount).gt(0) ? 'tenant' : 'security_deposit')
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
      if (!('bank_transaction_id' in raw)) {
        const { rows: [actuel] } = await db.query<{ bank_transaction_id: number | null }>('SELECT bank_transaction_id FROM deposit_payment WHERE id = $1', [id])
        d.bank_transaction_id = actuel?.bank_transaction_id ?? null
      }
      await checkMouvement(db, d, id)
      const { rows: [avant] } = await db.query<{ amount: string }>('SELECT amount::text FROM deposit_payment WHERE id = $1', [id])
      await checkRetenue(db, d.tenancy_id, new Big(d.amount).minus(avant?.amount ?? '0'))
      const { rowCount } = await db.query(
        `UPDATE deposit_payment SET tenancy_id = $2, payment_date = $3, amount = $4, bank_transaction_id = $5, note = $6 WHERE id = $1`,
        [id, d.tenancy_id, d.payment_date, d.amount, d.bank_transaction_id, d.note])
      return rowCount ? load(id) : reply.code(404).send({ message: 'Versement introuvable' })
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.delete('/depots/:id', async (request, reply) => {
    try {
      const { rows: [d] } = await db.query<{ tenancy_id: number, amount: string }>(
        'SELECT tenancy_id, amount::text FROM deposit_payment WHERE id = $1', [idParam(request)])
      if (!d) {
        return reply.code(404).send({ message: 'Versement introuvable' })
      }
      await checkRetenue(db, d.tenancy_id, new Big(d.amount).neg())
      await db.query('DELETE FROM deposit_payment WHERE id = $1', [idParam(request)])
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
      const { date, lines } = readRetenue(body(request))
      await client.query('BEGIN')
      const { rows: [tenancy] } = await client.query<{ move_in: string, move_out: string | null }>(
        'SELECT lower(period)::text AS move_in, (upper(period) - 1)::text AS move_out FROM tenancy WHERE id = $1', [sejourId])
      if (!tenancy) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ message: 'Séjour introuvable' })
      }
      await client.query(`DELETE FROM payment WHERE tenancy_id = $1 AND method = 'deposit'`, [sejourId])
      for (const l of lines.filter((x) => x.month)) {
        if (l.month! < `${tenancy.move_in.slice(0, 7)}-01` || (tenancy.move_out && l.month! > tenancy.move_out)) {
          throw new InputError(`${l.month!.slice(0, 7)} : hors du séjour`)
        }
      }
      // What each regularisation lacks, after its other payments (the retention being replaced)
      const parRegularisation = new Map<number, Big>()
      for (const l of lines.filter((x) => x.charge_adjustment_id)) {
        parRegularisation.set(l.charge_adjustment_id!, (parRegularisation.get(l.charge_adjustment_id!) ?? new Big(0)).plus(l.charge_adjustment))
      }
      for (const [id, amount] of parRegularisation) {
        const { rows: [r] } = await client.query<{ tenancy_id: number, sent: boolean, replaced: boolean, decision: string | null, remaining: string }>(
          `SELECT r.tenancy_id, r.sent_on IS NOT NULL AS sent, r.decision,
                  EXISTS (SELECT 1 FROM charge_adjustment n WHERE n.replaces_id = r.id) AS replaced,
                  (r.balance - charge_adjustment_paid(r.id))::text AS remaining
           FROM charge_adjustment r WHERE r.id = $1`, [id])
        if (!r || r.tenancy_id !== sejourId || !r.sent || r.replaced || r.decision) {
          throw new InputError('Seule une régularisation envoyée, en cours, de ce séjour reçoit une retenue')
        }
        if (amount.gt(r.remaining)) {
          throw new InputError(`Retenue de ${amount.toFixed(2)} € sur une régularisation dont le reste est ${new Big(r.remaining).toFixed(2)} €`)
        }
      }
      const total = lines.reduce((t, l) => t.plus(l.rent).plus(l.charge_advance).plus(l.charge_adjustment), new Big(0))
      const { paid } = await soldeDepot(client, sejourId)
      if (total.gt(paid)) {
        throw new InputError(`Retenue de ${total.toFixed(2)} € pour un dépôt versé de ${paid.toFixed(2)} €`)
      }
      for (const l of lines) {
        await client.query(
          `INSERT INTO payment (tenancy_id, payment_date, month, rent, charge_advance, charge_adjustment_id, charge_adjustment, method, note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'deposit', $8)`,
          [sejourId, date, l.month, l.rent, l.charge_advance, l.charge_adjustment_id, l.charge_adjustment, NOTE_RETENUE])
      }
      await client.query('COMMIT')
      const { rows } = await db.query(
        `SELECT id, payment_date::text, month::text, rent::text, charge_advance::text, charge_adjustment_id, charge_adjustment::text
         FROM payment WHERE tenancy_id = $1 AND method = 'deposit' ORDER BY month NULLS LAST, charge_adjustment_id, id`, [sejourId])
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

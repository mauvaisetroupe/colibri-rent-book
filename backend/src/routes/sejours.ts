import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'

import {
  body, idParam, InputError, optionalDate, optionalDecimal, optionalText, query, requiredDate, requiredDecimal, requiredId,
  requiredText, sendError,
} from '../http.js'
import { inclusiveBounds, inclusiveRange } from '../periods.js'

// Tenants, stays (a tenant in a lot over a period, entry and exit dates included, exit null while the stay goes on),
// rent and provision called each month (ADR 0009) and yearly provisions per stay (SPEC R9).

const SEJOUR_COLUMNS = `
  s.id, s.unit_id, lt.code AS unit, s.tenant_id, lo.name AS tenant, ${inclusiveBounds('s.period', 'move_in', 'move_out')},
  s.note, s.security_deposit::text,
  -- Deposit kept (ADR 0021): the retention, payments « depot » toward months or regularisations; null without any
  (SELECT sum(p.rent + p.charge_advance + p.charge_adjustment)::text FROM payment p
   WHERE p.tenancy_id = s.id AND p.method = 'deposit') AS deposit_retained,
  -- Deposit held (ADR 0019, 0021): paid minus refunded minus kept; null without any deposit or retention recorded
  (SELECT sum(x)::text FROM (
     SELECT vd.amount AS x FROM deposit_payment vd WHERE vd.tenancy_id = s.id
     UNION ALL
     SELECT -(p.rent + p.charge_advance + p.charge_adjustment) FROM payment p WHERE p.tenancy_id = s.id AND p.method = 'deposit') d
  ) AS deposit_held`

const SEJOUR_FROM = 'tenancy s JOIN unit lt ON lt.id = s.unit_id JOIN tenant lo ON lo.id = s.tenant_id'

function readSejour(raw: Record<string, unknown>) {
  const move_in = requiredDate(raw.move_in, 'Entrée')
  const move_out = optionalDate(raw.move_out, 'Sortie')
  if (move_out && move_out < move_in) {
    throw new InputError('La sortie est avant l\'entrée')
  }
  return {
    unit_id: requiredId(raw.unit_id, 'Lot'),
    tenant_id: requiredId(raw.tenant_id, 'Locataire'),
    move_in,
    move_out,
    note: optionalText(raw.note),
    security_deposit: optionalDecimal(raw.security_deposit, 'Dépôt de garantie'),
  }
}

const SEJOUR_ERRORS = {
  '23P01': 'Ce séjour chevauche un autre séjour du même lot',
  '23503': 'Ce séjour a des provisions, des paiements, des régularisations ou des versements de dépôt : suppression impossible',
}

function readEcheance(raw: Record<string, unknown>) {
  const e = {
    tenancy_id: requiredId(raw.tenancy_id, 'Séjour'),
    // A month ('AAAA-MM') or any day of it: the 1st of the month is stored
    from_month: requiredDate(`${String(raw.from_month ?? '').slice(0, 7)}-01`, 'À partir du'),
    rent: requiredDecimal(raw.rent, 'Loyer'),
    charge_advance: requiredDecimal(raw.charge_advance, 'Provision'),
    note: optionalText(raw.note),
  }
  if (e.rent.startsWith('-') || e.charge_advance.startsWith('-')) {
    throw new InputError('Le loyer et la provision ne peuvent pas être négatifs')
  }
  return e
}

const ECHEANCE_ERRORS = {
  23505: 'Ce séjour a déjà un loyer appelé à partir de ce mois',
  23503: 'Séjour inconnu',
}

function readProvision(raw: Record<string, unknown>) {
  const year = Number(raw.year)
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new InputError('Année invalide')
  }
  return {
    tenancy_id: requiredId(raw.tenancy_id, 'Séjour'),
    year,
    amount: requiredDecimal(raw.amount, 'Montant'),
    note: optionalText(raw.note),
  }
}

const sejourRoutes: FastifyPluginAsync<{ db: Pool }> = async (app, { db }) => {
  // ---------------------------------------------------------------- tenants

  app.get('/locataires', async () => {
    const { rows } = await db.query(
      `SELECT lo.id, lo.name, lo.email, lo.phone, lo.note, count(s.id)::int AS tenancy_count
       FROM tenant lo LEFT JOIN tenancy s ON s.tenant_id = lo.id
       GROUP BY lo.id ORDER BY lo.name`,
    )
    return rows
  })

  const saveLocataire = (id: number | null, raw: Record<string, unknown>) => {
    const values = [
      requiredText(raw.name, 'Nom'), optionalText(raw.email), optionalText(raw.phone), optionalText(raw.note),
    ]
    return id === null
      ? db.query(
        'INSERT INTO tenant (name, email, phone, note) VALUES ($1, $2, $3, $4) RETURNING *',
        values,
      )
      : db.query(
        'UPDATE tenant SET name = $2, email = $3, phone = $4, note = $5 WHERE id = $1 RETURNING *',
        [id, ...values],
      )
  }

  app.post('/locataires', async (request, reply) => {
    try {
      const { rows: [created] } = await saveLocataire(null, body(request))
      return reply.code(201).send(created)
    } catch (error) {
      return sendError(reply, error, { 23505: 'Un locataire porte déjà ce nom' })
    }
  })

  app.put('/locataires/:id', async (request, reply) => {
    try {
      const { rows: [updated] } = await saveLocataire(idParam(request), body(request))
      return updated ?? reply.code(404).send({ message: 'Locataire introuvable' })
    } catch (error) {
      return sendError(reply, error, { 23505: 'Un locataire porte déjà ce nom' })
    }
  })

  app.delete('/locataires/:id', async (request, reply) => {
    try {
      const { rowCount } = await db.query('DELETE FROM tenant WHERE id = $1', [idParam(request)])
      return rowCount ? reply.code(204).send() : reply.code(404).send({ message: 'Locataire introuvable' })
    } catch (error) {
      return sendError(reply, error, { 23503: 'Ce locataire a des séjours : suppression impossible' })
    }
  })

  // ---------------------------------------------------------------- stays

  app.get('/sejours', async (request, reply) => {
    try {
      const building = requiredId(query(request).building, 'Immeuble')
      const { rows } = await db.query(
        `SELECT ${SEJOUR_COLUMNS} FROM ${SEJOUR_FROM} WHERE lt.building_id = $1 ORDER BY lt.code, lower(s.period)`,
        [building],
      )
      return rows
    } catch (error) {
      return sendError(reply, error)
    }
  })

  const loadSejour = async (id: number) =>
    (await db.query(`SELECT ${SEJOUR_COLUMNS} FROM ${SEJOUR_FROM} WHERE s.id = $1`, [id])).rows[0]

  app.post('/sejours', async (request, reply) => {
    try {
      const s = readSejour(body(request))
      const { rows: [created] } = await db.query<{ id: number }>(
        `INSERT INTO tenancy (unit_id, tenant_id, period, note, security_deposit)
         VALUES ($1, $2, ${inclusiveRange('$3', '$4')}, $5, $6) RETURNING id`,
        [s.unit_id, s.tenant_id, s.move_in, s.move_out, s.note, s.security_deposit],
      )
      return reply.code(201).send(await loadSejour(created!.id))
    } catch (error) {
      return sendError(reply, error, SEJOUR_ERRORS)
    }
  })

  app.put('/sejours/:id', async (request, reply) => {
    try {
      const s = readSejour(body(request))
      const { rowCount } = await db.query(
        `UPDATE tenancy SET unit_id = $2, tenant_id = $3, period = ${inclusiveRange('$4', '$5')}, note = $6,
           security_deposit = $7
         WHERE id = $1`,
        [idParam(request), s.unit_id, s.tenant_id, s.move_in, s.move_out, s.note, s.security_deposit],
      )
      return rowCount ? loadSejour(idParam(request)) : reply.code(404).send({ message: 'Séjour introuvable' })
    } catch (error) {
      return sendError(reply, error, SEJOUR_ERRORS)
    }
  })

  app.delete('/sejours/:id', async (request, reply) => {
    try {
      const { rowCount } = await db.query('DELETE FROM tenancy WHERE id = $1', [idParam(request)])
      return rowCount ? reply.code(204).send() : reply.code(404).send({ message: 'Séjour introuvable' })
    } catch (error) {
      return sendError(reply, error, SEJOUR_ERRORS)
    }
  })

  // ---------------------------------------------------------------- rent and provision called (ADR 0009)

  // History of the amounts called each month, per stay: a row applies from its month until the next row of the stay
  app.get('/echeances', async (request, reply) => {
    try {
      const building = requiredId(query(request).building, 'Immeuble')
      const { rows } = await db.query(
        `SELECT e.id, e.tenancy_id, e.from_month::text, e.rent::text, e.charge_advance::text, e.note
         FROM rent_schedule e JOIN tenancy s ON s.id = e.tenancy_id JOIN unit lt ON lt.id = s.unit_id
         WHERE lt.building_id = $1 ORDER BY e.tenancy_id, e.from_month`,
        [building],
      )
      return rows
    } catch (error) {
      return sendError(reply, error)
    }
  })

  const ECHEANCE_COLUMNS = 'id, tenancy_id, from_month::text, rent::text, charge_advance::text, note'

  app.post('/echeances', async (request, reply) => {
    try {
      const e = readEcheance(body(request))
      const { rows: [created] } = await db.query(
        `INSERT INTO rent_schedule (tenancy_id, from_month, rent, charge_advance, note) VALUES ($1, $2, $3, $4, $5)
         RETURNING ${ECHEANCE_COLUMNS}`,
        [e.tenancy_id, e.from_month, e.rent, e.charge_advance, e.note],
      )
      return reply.code(201).send(created)
    } catch (error) {
      return sendError(reply, error, ECHEANCE_ERRORS)
    }
  })

  app.put('/echeances/:id', async (request, reply) => {
    try {
      const e = readEcheance(body(request))
      const { rows: [updated] } = await db.query(
        `UPDATE rent_schedule SET tenancy_id = $2, from_month = $3, rent = $4, charge_advance = $5, note = $6 WHERE id = $1
         RETURNING ${ECHEANCE_COLUMNS}`,
        [idParam(request), e.tenancy_id, e.from_month, e.rent, e.charge_advance, e.note],
      )
      return updated ?? reply.code(404).send({ message: 'Loyer appelé introuvable' })
    } catch (error) {
      return sendError(reply, error, ECHEANCE_ERRORS)
    }
  })

  app.delete('/echeances/:id', async (request, reply) => {
    const { rowCount } = await db.query('DELETE FROM rent_schedule WHERE id = $1', [idParam(request)])
    return rowCount ? reply.code(204).send() : reply.code(404).send({ message: 'Loyer appelé introuvable' })
  })

  // ---------------------------------------------------------------- provisions (per stay and calendar year)

  // Provisions per stay and year as used by the statement (view v_provision): from the monthly payments when the year
  // has any (source « paiements »), otherwise the yearly total entered by hand (source « saisie », id to edit it)
  app.get('/provisions', async (request, reply) => {
    try {
      const building = requiredId(query(request).building, 'Immeuble')
      const { rows } = await db.query(
        `SELECT pa.id, v.tenancy_id, v.year, v.amount::text, v.source, pa.note, lo.name AS tenant, lt.code AS unit
         FROM v_charge_advance v
         LEFT JOIN annual_charge_advance pa ON pa.tenancy_id = v.tenancy_id AND pa.year = v.year AND v.source = 'entered'
         JOIN tenancy s ON s.id = v.tenancy_id
         JOIN unit lt ON lt.id = s.unit_id
         JOIN tenant lo ON lo.id = s.tenant_id
         WHERE lt.building_id = $1 ORDER BY v.year DESC, lt.code, lower(s.period)`,
        [building],
      )
      return rows
    } catch (error) {
      return sendError(reply, error)
    }
  })

  // One amount per stay and year: saving again replaces it
  app.put('/provisions', async (request, reply) => {
    try {
      const p = readProvision(body(request))
      const { rowCount: payes } = await db.query(
        'SELECT 1 FROM payment WHERE tenancy_id = $1 AND extract(year FROM month) = $2',
        [p.tenancy_id, p.year],
      )
      if (payes) {
        return reply.code(409).send({ message: `Les provisions ${p.year} viennent des paiements mensuels saisis` })
      }
      const { rows: [saved] } = await db.query(
        `INSERT INTO annual_charge_advance (tenancy_id, year, amount, note) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenancy_id, year) DO UPDATE SET amount = excluded.amount, note = excluded.note
         RETURNING id, tenancy_id, year, amount::text, note`,
        [p.tenancy_id, p.year, p.amount, p.note],
      )
      return saved
    } catch (error) {
      return sendError(reply, error, { 23503: 'Séjour inconnu' })
    }
  })

  app.delete('/provisions/:id', async (request, reply) => {
    const { rowCount } = await db.query('DELETE FROM annual_charge_advance WHERE id = $1', [idParam(request)])
    return rowCount ? reply.code(204).send() : reply.code(404).send({ message: 'Provision introuvable' })
  })
}

export default sejourRoutes

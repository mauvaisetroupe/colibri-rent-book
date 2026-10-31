import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'

import { body, idParam, InputError, optionalDate, optionalDecimal, optionalText, requiredText, sendError } from '../http.js'

// Buildings and their lots. Changing the tantièmes of a lot changes every statement, past ones included
// (SPEC R11: a key change must be dated; the dated key is a later phase): the screen asks for confirmation.

const LOT_COLUMNS = 'id, building_id, code, label, area_m2::text, charge_shares'

function readLot(raw: Record<string, unknown>) {
  const charge_shares = Number(raw.charge_shares)
  if (!Number.isInteger(charge_shares) || charge_shares <= 0) {
    throw new InputError('Tantièmes : nombre entier positif attendu')
  }
  return {
    code: requiredText(raw.code, 'Code du lot'),
    label: optionalText(raw.label),
    area_m2: optionalDecimal(raw.area_m2, 'Surface'),
    charge_shares,
  }
}

const immeubleRoutes: FastifyPluginAsync<{ db: Pool }> = async (app, { db }) => {
  app.get('/immeubles', async () => {
    const { rows } = await db.query(
      `SELECT i.id, i.code, i.name, i.address, i.managed_from::text, count(l.id)::int AS unit_count,
              coalesce(sum(l.charge_shares), 0)::int AS total_charge_shares
       FROM building i LEFT JOIN unit l ON l.building_id = i.id
       GROUP BY i.id ORDER BY i.name`,
    )
    return rows
  })

  app.get('/immeubles/:id', async (request, reply) => {
    const id = idParam(request)
    const { rows: [building] } = await db.query('SELECT id, code, name, address, managed_from::text FROM building WHERE id = $1', [id])
    if (!building) {
      return reply.code(404).send({ message: 'Immeuble introuvable' })
    }
    const { rows: units } = await db.query(`SELECT ${LOT_COLUMNS} FROM unit WHERE building_id = $1 ORDER BY code`, [id])
    return { ...building, units, total_charge_shares: units.reduce((sum, l) => sum + l.charge_shares, 0) }
  })

  app.post('/immeubles', async (request, reply) => {
    try {
      const b = body(request)
      const { rows: [created] } = await db.query(
        `INSERT INTO building (code, name, address, managed_from) VALUES ($1, $2, $3, $4)
         RETURNING id, code, name, address, managed_from::text`,
        [requiredText(b.code, 'Code').toUpperCase(), requiredText(b.name, 'Nom'), optionalText(b.address),
          optionalDate(b.managed_from, 'Début de la gestion')],
      )
      return reply.code(201).send(created)
    } catch (error) {
      return sendError(reply, error, { 23505: 'Un immeuble porte déjà ce code' })
    }
  })

  app.put('/immeubles/:id', async (request, reply) => {
    try {
      const b = body(request)
      const { rows: [updated] } = await db.query(
        `UPDATE building SET name = $2, address = $3, managed_from = $4 WHERE id = $1
         RETURNING id, code, name, address, managed_from::text`,
        [idParam(request), requiredText(b.name, 'Nom'), optionalText(b.address), optionalDate(b.managed_from, 'Début de la gestion')],
      )
      return updated ?? reply.code(404).send({ message: 'Immeuble introuvable' })
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/immeubles/:id/lots', async (request, reply) => {
    try {
      const unit = readLot(body(request))
      const { rows: [created] } = await db.query(
        `INSERT INTO unit (building_id, code, label, area_m2, charge_shares) VALUES ($1, $2, $3, $4, $5)
         RETURNING ${LOT_COLUMNS}`,
        [idParam(request), unit.code, unit.label, unit.area_m2, unit.charge_shares],
      )
      return reply.code(201).send(created)
    } catch (error) {
      return sendLotError(reply, error)
    }
  })

  app.put('/lots/:id', async (request, reply) => {
    try {
      const unit = readLot(body(request))
      const { rows: [updated] } = await db.query(
        `UPDATE unit SET code = $2, label = $3, area_m2 = $4, charge_shares = $5 WHERE id = $1
         RETURNING ${LOT_COLUMNS}`,
        [idParam(request), unit.code, unit.label, unit.area_m2, unit.charge_shares],
      )
      return updated ?? reply.code(404).send({ message: 'Lot introuvable' })
    } catch (error) {
      return sendLotError(reply, error)
    }
  })

  app.delete('/lots/:id', async (request, reply) => {
    try {
      const { rowCount } = await db.query('DELETE FROM unit WHERE id = $1', [idParam(request)])
      return rowCount ? reply.code(204).send() : reply.code(404).send({ message: 'Lot introuvable' })
    } catch (error) {
      return sendError(reply, error, { 23503: 'Ce lot a des séjours : suppression impossible' })
    }
  })
}

const sendLotError = (reply: Parameters<typeof sendError>[0], error: unknown) =>
  sendError(reply, error, { 23505: 'Un lot de cet immeuble porte déjà ce code' })

export default immeubleRoutes

import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'

import { body, idParam, InputError, optionalDecimal, optionalText, requiredText, sendError } from '../http.js'

// Buildings and their lots. Changing the tantièmes of a lot changes every statement, past ones included
// (SPEC R11: a key change must be dated; the dated key is a later phase): the screen asks for confirmation.

const LOT_COLUMNS = 'id, immeuble_id, code, designation, surface_m2::text, tantiemes'

function readLot(raw: Record<string, unknown>) {
  const tantiemes = Number(raw.tantiemes)
  if (!Number.isInteger(tantiemes) || tantiemes <= 0) {
    throw new InputError('Tantièmes : nombre entier positif attendu')
  }
  return {
    code: requiredText(raw.code, 'Code du lot'),
    designation: optionalText(raw.designation),
    surface_m2: optionalDecimal(raw.surface_m2, 'Surface'),
    tantiemes,
  }
}

const immeubleRoutes: FastifyPluginAsync<{ db: Pool }> = async (app, { db }) => {
  app.get('/immeubles', async () => {
    const { rows } = await db.query(
      `SELECT i.id, i.code, i.nom, i.adresse, count(l.id)::int AS nb_lots, coalesce(sum(l.tantiemes), 0)::int AS total_tantiemes
       FROM immeuble i LEFT JOIN lot l ON l.immeuble_id = i.id
       GROUP BY i.id ORDER BY i.nom`,
    )
    return rows
  })

  app.get('/immeubles/:id', async (request, reply) => {
    const id = idParam(request)
    const { rows: [immeuble] } = await db.query('SELECT id, code, nom, adresse FROM immeuble WHERE id = $1', [id])
    if (!immeuble) {
      return reply.code(404).send({ message: 'Immeuble introuvable' })
    }
    const { rows: lots } = await db.query(`SELECT ${LOT_COLUMNS} FROM lot WHERE immeuble_id = $1 ORDER BY code`, [id])
    return { ...immeuble, lots, total_tantiemes: lots.reduce((sum, l) => sum + l.tantiemes, 0) }
  })

  app.post('/immeubles', async (request, reply) => {
    try {
      const b = body(request)
      const { rows: [created] } = await db.query(
        'INSERT INTO immeuble (code, nom, adresse) VALUES ($1, $2, $3) RETURNING id, code, nom, adresse',
        [requiredText(b.code, 'Code').toUpperCase(), requiredText(b.nom, 'Nom'), optionalText(b.adresse)],
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
        'UPDATE immeuble SET nom = $2, adresse = $3 WHERE id = $1 RETURNING id, code, nom, adresse',
        [idParam(request), requiredText(b.nom, 'Nom'), optionalText(b.adresse)],
      )
      return updated ?? reply.code(404).send({ message: 'Immeuble introuvable' })
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/immeubles/:id/lots', async (request, reply) => {
    try {
      const lot = readLot(body(request))
      const { rows: [created] } = await db.query(
        `INSERT INTO lot (immeuble_id, code, designation, surface_m2, tantiemes) VALUES ($1, $2, $3, $4, $5)
         RETURNING ${LOT_COLUMNS}`,
        [idParam(request), lot.code, lot.designation, lot.surface_m2, lot.tantiemes],
      )
      return reply.code(201).send(created)
    } catch (error) {
      return sendLotError(reply, error)
    }
  })

  app.put('/lots/:id', async (request, reply) => {
    try {
      const lot = readLot(body(request))
      const { rows: [updated] } = await db.query(
        `UPDATE lot SET code = $2, designation = $3, surface_m2 = $4, tantiemes = $5 WHERE id = $1
         RETURNING ${LOT_COLUMNS}`,
        [idParam(request), lot.code, lot.designation, lot.surface_m2, lot.tantiemes],
      )
      return updated ?? reply.code(404).send({ message: 'Lot introuvable' })
    } catch (error) {
      return sendLotError(reply, error)
    }
  })

  app.delete('/lots/:id', async (request, reply) => {
    try {
      const { rowCount } = await db.query('DELETE FROM lot WHERE id = $1', [idParam(request)])
      return rowCount ? reply.code(204).send() : reply.code(404).send({ message: 'Lot introuvable' })
    } catch (error) {
      return sendError(reply, error, { 23503: 'Ce lot a des séjours : suppression impossible' })
    }
  })
}

const sendLotError = (reply: Parameters<typeof sendError>[0], error: unknown) =>
  sendError(reply, error, { 23505: 'Un lot de cet immeuble porte déjà ce code' })

export default immeubleRoutes

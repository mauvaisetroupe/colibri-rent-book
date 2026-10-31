import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'

import { zonesSaisies } from '../annexes.js'
import { body, idParam, InputError, sendError } from '../http.js'

// Suppliers (ADR 0014): every supplier of an invoice or of an extractor (a bank: its statements, ADR 0018), with its
// invoices and the last version of its extractor; « confidentiel »: its invoices are never joined to the supporting documents;
// « zones_masquees »: the zones masked on the scans of its invoices, drawn by hand (ADR 0025).

const COLUMNS = `fo.id, fo.name, fo.confidential, fo.masked_zones,
  (SELECT array_agg(DISTINCT energy::text ORDER BY energy::text) FROM (
     SELECT energy FROM invoice WHERE supplier_id = fo.id UNION SELECT energy FROM extractor WHERE supplier_id = fo.id
   ) e WHERE energy IS NOT NULL) AS energies,
  (SELECT count(*)::int FROM invoice WHERE supplier_id = fo.id) AS invoice_count,
  (SELECT count(*)::int FROM invoice WHERE supplier_id = fo.id AND pdf_file IS NOT NULL) AS pdf_count,
  (SELECT count(*)::int FROM bank_statement WHERE supplier_id = fo.id) AS statement_count,
  (SELECT json_build_object('id', e.id, 'version', e.version, 'type', e.type) FROM extractor e WHERE e.supplier_id = fo.id
   ORDER BY e.version DESC LIMIT 1) AS extractor`

const fournisseurRoutes: FastifyPluginAsync<{ db: Pool }> = async (app, { db }) => {
  app.get('/fournisseurs', async () => {
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM supplier fo ORDER BY fo.name`)
    return rows
  })

  app.get('/fournisseurs/:id', async (request, reply) => {
    const { rows: [supplier] } = await db.query(`SELECT ${COLUMNS} FROM supplier fo WHERE fo.id = $1`, [idParam(request)])
    return supplier ?? reply.code(404).send({ message: 'Fournisseur introuvable' })
  })

  app.patch('/fournisseurs/:id', async (request, reply) => {
    try {
      const { confidential } = body(request)
      if (typeof confidential !== 'boolean') {
        throw new InputError('« confidentiel » doit valoir true ou false')
      }
      const { rowCount } = await db.query('UPDATE supplier SET confidential = $2 WHERE id = $1', [idParam(request), confidential])
      if (!rowCount) {
        return reply.code(404).send({ message: 'Fournisseur introuvable' })
      }
      const { rows: [supplier] } = await db.query(`SELECT ${COLUMNS} FROM supplier fo WHERE fo.id = $1`, [idParam(request)])
      return supplier
    } catch (error) {
      return sendError(reply, error)
    }
  })

  // The model of the zones of its scans; the versions in images already made are not changed: to make again
  app.put('/fournisseurs/:id/zones', async (request, reply) => {
    try {
      const zones = zonesSaisies(body(request).zones)
      const { rowCount } = await db.query('UPDATE supplier SET masked_zones = $2 WHERE id = $1',
        [idParam(request), JSON.stringify(zones)])
      if (!rowCount) {
        return reply.code(404).send({ message: 'Fournisseur introuvable' })
      }
      const { rows: [supplier] } = await db.query(`SELECT ${COLUMNS} FROM supplier fo WHERE fo.id = $1`, [idParam(request)])
      return supplier
    } catch (error) {
      return sendError(reply, error)
    }
  })
}

export default fournisseurRoutes

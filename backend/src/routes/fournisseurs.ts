import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'

import { body, idParam, InputError, sendError } from '../http.js'

// Suppliers (ADR 0014): every supplier of an invoice or of an extractor (a bank: its statements, ADR 0018), with its
// invoices and the last version of its extractor; « confidentiel »: its invoices are never joined to the supporting documents.

const COLUMNS = `fo.id, fo.nom, fo.confidentiel,
  (SELECT array_agg(DISTINCT energie::text ORDER BY energie::text) FROM (
     SELECT energie FROM facture WHERE fournisseur_id = fo.id UNION SELECT energie FROM extracteur WHERE fournisseur_id = fo.id
   ) e WHERE energie IS NOT NULL) AS energies,
  (SELECT count(*)::int FROM facture WHERE fournisseur_id = fo.id) AS nb_factures,
  (SELECT count(*)::int FROM facture WHERE fournisseur_id = fo.id AND fichier_pdf IS NOT NULL) AS nb_pdf,
  (SELECT count(*)::int FROM releve_bancaire WHERE fournisseur_id = fo.id) AS nb_releves,
  (SELECT json_build_object('id', e.id, 'version', e.version, 'type', e.type) FROM extracteur e WHERE e.fournisseur_id = fo.id
   ORDER BY e.version DESC LIMIT 1) AS extracteur`

const fournisseurRoutes: FastifyPluginAsync<{ db: Pool }> = async (app, { db }) => {
  app.get('/fournisseurs', async () => {
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM fournisseur fo ORDER BY fo.nom`)
    return rows
  })

  app.get('/fournisseurs/:id', async (request, reply) => {
    const { rows: [fournisseur] } = await db.query(`SELECT ${COLUMNS} FROM fournisseur fo WHERE fo.id = $1`, [idParam(request)])
    return fournisseur ?? reply.code(404).send({ message: 'Fournisseur introuvable' })
  })

  app.patch('/fournisseurs/:id', async (request, reply) => {
    try {
      const { confidentiel } = body(request)
      if (typeof confidentiel !== 'boolean') {
        throw new InputError('« confidentiel » doit valoir true ou false')
      }
      const { rowCount } = await db.query('UPDATE fournisseur SET confidentiel = $2 WHERE id = $1', [idParam(request), confidentiel])
      if (!rowCount) {
        return reply.code(404).send({ message: 'Fournisseur introuvable' })
      }
      const { rows: [fournisseur] } = await db.query(`SELECT ${COLUMNS} FROM fournisseur fo WHERE fo.id = $1`, [idParam(request)])
      return fournisseur
    } catch (error) {
      return sendError(reply, error)
    }
  })
}

export default fournisseurRoutes

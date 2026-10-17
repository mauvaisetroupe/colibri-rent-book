import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'

import { syntheseFiscale } from '../fiscal.js'
import { InputError, query, requiredId, sendError } from '../http.js'

// Tax summary of a calendar year (SPEC § 9, ADR 0008)
const fiscalRoutes: FastifyPluginAsync<{ db: Pool }> = async (app, { db }) => {
  app.get('/fiscal', async (request, reply) => {
    try {
      const q = query(request)
      const annee = Number(q.annee)
      if (!Number.isInteger(annee) || annee < 2000 || annee > 2100) {
        throw new InputError('Année invalide')
      }
      return await syntheseFiscale(db, requiredId(q.immeuble, 'Immeuble'), annee)
    } catch (error) {
      return sendError(reply, error)
    }
  })
}

export default fiscalRoutes

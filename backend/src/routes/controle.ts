import type { FastifyPluginAsync } from 'fastify'

import { checkInvoice } from '../invoices/checks.js'
import { BadRequestError, readLines, readTotal } from '../invoices/requestBody.js'

// Live checks for the editing grid (ADR 0005): the lines being edited are checked without being stored.
const controleRoutes: FastifyPluginAsync = async (app) => {
  app.post('/controle', async (request, reply) => {
    const body = (request.body ?? {}) as { montant_ttc?: unknown, lignes?: unknown }
    try {
      return checkInvoice({ montant_ttc: readTotal(body.montant_ttc), lignes: readLines(body.lignes) })
    } catch (error) {
      if (error instanceof BadRequestError) {
        return reply.code(400).send({ message: error.message })
      }
      throw error
    }
  })
}

export default controleRoutes

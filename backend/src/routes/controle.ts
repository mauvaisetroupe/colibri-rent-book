import type { FastifyPluginAsync } from 'fastify'

import { checkInvoice } from '../invoices/checks.js'
import { BadRequestError, readLines, readTotal } from '../invoices/requestBody.js'

// Live checks for the editing grid (ADR 0005): the lines being edited are checked without being stored.
const controleRoutes: FastifyPluginAsync = async (app) => {
  app.post('/controle', async (request, reply) => {
    const body = (request.body ?? {}) as { total_incl_tax?: unknown, lines?: unknown }
    try {
      return checkInvoice({ total_incl_tax: readTotal(body.total_incl_tax), lines: readLines(body.lines) })
    } catch (error) {
      if (error instanceof BadRequestError) {
        return reply.code(400).send({ message: error.message })
      }
      throw error
    }
  })
}

export default controleRoutes

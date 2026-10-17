import type { FastifyReply, FastifyRequest } from 'fastify'

import { isDecimal, isValidDate } from './invoices/checks.js'

// Small helpers shared by the routes: reading request values and turning database errors into French messages.

export class InputError extends Error {}

export const idParam = (request: FastifyRequest) => Number((request.params as { id: string }).id)

export const body = (request: FastifyRequest) => (request.body ?? {}) as Record<string, unknown>

export const query = (request: FastifyRequest) => (request.query ?? {}) as Record<string, string | undefined>

const text = (value: unknown) => (value === null || value === undefined ? '' : String(value).trim())

export function requiredText(value: unknown, name: string) {
  const result = text(value)
  if (!result) {
    throw new InputError(`${name} manquant`)
  }
  return result
}

export const optionalText = (value: unknown) => text(value) || null

export function requiredId(value: unknown, name: string) {
  const id = Number(value)
  if (!Number.isInteger(id) || id <= 0) {
    throw new InputError(`${name} manquant ou invalide`)
  }
  return id
}

export function requiredDate(value: unknown, name: string) {
  const date = text(value)
  if (!isValidDate(date)) {
    throw new InputError(`${name} : date invalide (attendu AAAA-MM-JJ)`)
  }
  return date
}

export function optionalDate(value: unknown, name: string) {
  return text(value) ? requiredDate(value, name) : null
}

export function requiredDecimal(value: unknown, name: string) {
  const amount = text(value)
  if (!isDecimal(amount)) {
    throw new InputError(`${name} : nombre invalide`)
  }
  return amount
}

export function optionalDecimal(value: unknown, name: string) {
  return text(value) ? requiredDecimal(value, name) : null
}

/** Exercise bounds from the query string, both included. */
export function exercise(request: FastifyRequest) {
  const q = query(request)
  const immeuble = requiredId(q.immeuble, 'Immeuble')
  const debut = requiredDate(q.debut, 'Début de l\'exercice')
  const fin = requiredDate(q.fin, 'Fin de l\'exercice')
  if (debut > fin) {
    throw new InputError('L\'exercice finit avant de commencer')
  }
  return { immeuble, debut, fin }
}

const PG_MESSAGES: Record<string, string> = {
  '23505': 'Cette valeur existe déjà',
  '23503': 'Élément encore utilisé ailleurs, ou référence inconnue',
  '23P01': 'Chevauchement interdit',
  '23514': 'Valeur refusée par la base',
}

/**
 * Sends a 400 for an InputError and a 409 for a known constraint violation (with an optional specific message per
 * SQLSTATE code); rethrows anything else.
 */
export function sendError(reply: FastifyReply, error: unknown, messages: Record<string, string> = {}) {
  if (error instanceof InputError) {
    return reply.code(400).send({ message: error.message })
  }
  const code = (error as { code?: string }).code
  if (code && PG_MESSAGES[code]) {
    return reply.code(409).send({ message: messages[code] ?? PG_MESSAGES[code] })
  }
  throw error
}

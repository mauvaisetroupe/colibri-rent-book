import type { InvoiceLine } from './types.js'

// Invoice lines sent by the editing grid. Field values are kept as typed (any text): checkInvoice() reports what
// cannot be stored. Only the shape is enforced here.

export class BadRequestError extends Error {}

const text = (value: unknown) => (value === null || value === undefined ? '' : String(value).trim())
const optional = (value: unknown) => (text(value) === '' ? null : text(value))

export function readLines(value: unknown): InvoiceLine[] {
  if (!Array.isArray(value)) {
    throw new BadRequestError('« lignes » doit être une liste')
  }
  return value.map((raw, i) => {
    if (!raw || typeof raw !== 'object') {
      throw new BadRequestError(`Ligne ${i + 1} : objet attendu`)
    }
    const line = raw as Record<string, unknown>
    return {
      // Unknown categories and allocations are reported by checkInvoice() (categorie_invalide, affectation_invalide)
      category: text(line.category) as InvoiceLine['category'],
      label: text(line.label),
      start: text(line.start),
      end: text(line.end),
      kwh: optional(line.kwh),
      amount_excl_tax: optional(line.amount_excl_tax),
      vat_rate: optional(line.vat_rate),
      amount_incl_tax: text(line.amount_incl_tax),
      allocation: text(line.allocation) as InvoiceLine['allocation'],
      note: optional(line.note),
    }
  })
}

export function readTotal(value: unknown): string {
  return text(value)
}

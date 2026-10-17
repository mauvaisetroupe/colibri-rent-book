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
      categorie: text(line.categorie) as InvoiceLine['categorie'],
      libelle: text(line.libelle),
      debut: text(line.debut),
      fin: text(line.fin),
      kwh: optional(line.kwh),
      montant_ht: optional(line.montant_ht),
      taux_tva: optional(line.taux_tva),
      montant_ttc: text(line.montant_ttc),
      affectation: text(line.affectation) as InvoiceLine['affectation'],
      note: optional(line.note),
    }
  })
}

export function readTotal(value: unknown): string {
  return text(value)
}

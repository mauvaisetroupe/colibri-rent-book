// Categories of a bank movement (ADR 0018): what it is. « locataire » and « travaux » have a detail (the payments of a
// tenant, the works, linked to the movement); the others only a note, required for « autre ». Fixed in the code: the
// tax summary will read some of them (insurance, bank fees…).

export const CATEGORIES = [
  'locataire', 'travaux', 'emprunt', 'assurance', 'energie', 'eau', 'impots', 'frais_bancaires', 'copropriete',
  'honoraires', 'remboursement_depot', 'virement_interne', 'autre',
] as const

export type Categorie = typeof CATEGORIES[number]

/** The categories whose detail is linked rows: payments of a tenant, works. */
export const AVEC_DETAIL = { locataire: 'paiement', travaux: 'travaux' } as const

export const estCategorie = (value: unknown): value is Categorie =>
  typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value)

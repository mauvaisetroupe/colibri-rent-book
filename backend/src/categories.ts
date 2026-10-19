// Categories of a bank movement (ADR 0018, 0019): what it is. « locataire », « travaux » and « depot_garantie » have a
// detail (the payments of a tenant, the payments of works invoices, the deposits paid or refunded, linked to the
// movement); the others only a note, required for « autre ». « agence »: the rents an agency collected and paid back,
// its fees deducted, before the owner managed the letting: no detail. Fixed in the code: the tax summary will read
// some of them (insurance, bank fees…).

export const CATEGORIES = [
  'locataire', 'travaux', 'depot_garantie', 'agence', 'emprunt', 'assurance', 'energie', 'eau', 'impots', 'frais_bancaires',
  'copropriete', 'honoraires', 'associes', 'virement_interne', 'autre',
] as const

export type Categorie = typeof CATEGORIES[number]

/** The categories whose detail is linked rows. */
export const AVEC_DETAIL: Categorie[] = ['locataire', 'travaux', 'depot_garantie']

export const estCategorie = (value: unknown): value is Categorie =>
  typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value)

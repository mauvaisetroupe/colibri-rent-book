// Categories of a bank movement (ADR 0018, 0019): what it is. « locataire », « travaux » and « depot_garantie » have a
// detail (the payments of a tenant, the payments of works invoices, the deposits paid or refunded, linked to the
// movement), « energie », « eau » and « impots » too (the invoices of charges paid, ADR 0022); the others only a note,
// required for « autre ». « agence »: the rents an agency collected and paid back,
// its fees deducted, before the owner managed the letting: no detail. Fixed in the code: the tax summary will read
// some of them (insurance, bank fees…).

export const CATEGORIES = [
  'locataire', 'travaux', 'depot_garantie', 'agence', 'emprunt', 'assurance', 'energie', 'eau', 'impots', 'frais_bancaires',
  'copropriete', 'honoraires', 'associes', 'virement_interne', 'autre',
] as const

export type Categorie = typeof CATEGORIES[number]

/** The categories of a debit that pays invoices of charges (ADR 0022): their detail is the invoices paid. */
export const AVEC_FACTURE: Categorie[] = ['energie', 'eau', 'impots']

/** The categories whose detail is linked rows: « incomplet » until it covers the amount. */
export const AVEC_DETAIL: Categorie[] = ['locataire', 'travaux', 'depot_garantie', ...AVEC_FACTURE]

/** The category of a movement paying an invoice of this energy. */
export const categorieDeFacture = (energie: string): Categorie =>
  (energie === 'eau' ? 'eau' : energie === 'ordures_menageres' ? 'impots' : 'energie')

export const estCategorie = (value: unknown): value is Categorie =>
  typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value)

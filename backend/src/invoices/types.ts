// Invoice line format shared by the extractors (browser, ADR 0013), the paste import and the editing grid (SPEC § 6).
// Field names follow the SQL schema (French domain vocabulary). Amounts and quantities are decimal strings,
// never JS numbers; dates are ISO strings with both bounds INCLUDED.

export const CATEGORIES = ['consumption', 'subscription', 'tax', 'service', 'penalty', 'other'] as const

export type Categorie = typeof CATEGORIES[number]

// ADR 0013: recoverable (allocated to the tenants), borne by the owner (penalties: fiscal summary), or about another
// property (neither allocated nor in the fiscal summary of the building)
export const AFFECTATIONS = ['recoverable', 'owner', 'outside_building'] as const

export type Affectation = typeof AFFECTATIONS[number]

export type Energie = 'gas' | 'electricity' | 'water' | 'household_waste' | 'other'

export type InvoiceLine = {
  category: Categorie
  label: string
  start: string
  end: string
  kwh: string | null
  amount_excl_tax: string | null
  vat_rate: string | null
  amount_incl_tax: string
  allocation: Affectation
  note: string | null
}

// Note put by the extraction engine (frontend/src/extraction/moteur.ts, same text) on a line whose period is not
// printed on the invoice (SPEC R6): the checks flag it as « à confirmer »
export const NOTE_PERIODE_PAR_DEFAUT = 'Période non indiquée : période de consommation de la facture'


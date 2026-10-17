// Invoice line format shared by the extractors (browser, ADR 0013), the paste import and the editing grid (SPEC § 6).
// Field names follow the SQL schema (French domain vocabulary). Amounts and quantities are decimal strings,
// never JS numbers; dates are ISO strings with both bounds INCLUDED.

export const CATEGORIES = ['consommation', 'abonnement', 'taxe', 'prestation', 'penalite', 'autre'] as const

export type Categorie = typeof CATEGORIES[number]

// ADR 0013: recoverable (allocated to the tenants), borne by the owner (penalties: fiscal summary), or about another
// property (neither allocated nor in the fiscal summary of the building)
export const AFFECTATIONS = ['recuperable', 'proprietaire', 'hors_immeuble'] as const

export type Affectation = typeof AFFECTATIONS[number]

export type Energie = 'gaz' | 'electricite' | 'eau' | 'ordures_menageres' | 'autre'

export type InvoiceLine = {
  categorie: Categorie
  libelle: string
  debut: string
  fin: string
  kwh: string | null
  montant_ht: string | null
  taux_tva: string | null
  montant_ttc: string
  affectation: Affectation
  note: string | null
}

// Note put by the extraction engine (frontend/src/extraction/moteur.ts, same text) on a line whose period is not
// printed on the invoice (SPEC R6): the checks flag it as « à confirmer »
export const NOTE_PERIODE_PAR_DEFAUT = 'Période non indiquée : période de consommation de la facture'


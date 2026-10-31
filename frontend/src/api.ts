import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser'

// Client of the Colibri API (same origin: /api, relayed by Vite in development and Nginx in production).
// Types mirror backend/src/invoices/types.ts and checks.ts: amounts are decimal strings, dates ISO with
// inclusive bounds.

import type { Affectation, Categorie, Energie, Reglages } from './extraction/contrat'

export type { Affectation, Categorie, Energie }
// remplacee: a validated invoice replaced by another one, or corrected (ADR 0017); out of the statements
export type Statut = 'draft' | 'validated' | 'replaced'
export const STATUTS: Record<Statut, string> = { draft: 'Brouillon', validated: 'Validée', replaced: 'Remplacée' }

export const CATEGORIES: Categorie[] = ['consumption', 'subscription', 'tax', 'service', 'penalty', 'other']
// ADR 0013: recoverable (allocated), borne by the owner (tax summary), about another property (left out)
export const AFFECTATIONS: Record<Affectation, string> = {
  recoverable: 'récupérable',
  owner: 'propriétaire',
  outside_building: 'hors immeuble',
}
export const ENERGIES: Record<Energie, string> = {
  gas: 'Gaz',
  electricity: 'Électricité',
  water: 'Eau',
  household_waste: 'Ordures ménagères',
  other: 'Autre',
}

export type Immeuble = {
  id: number
  code: string
  name: string
  address: string | null
  // ADR 0023: start of the management in the application (before: an agency, or nothing)
  managed_from: string | null
  unit_count: number
  total_charge_shares: number
}

export type Lot = {
  id: number
  building_id: number
  code: string
  label: string | null
  area_m2: string | null
  charge_shares: number
}

export type ImmeubleDetail = Omit<Immeuble, 'unit_count'> & { units: Lot[] }

export type Locataire = {
  id: number
  name: string
  email: string | null
  phone: string | null
  note: string | null
  tenancy_count: number
}

export type Sejour = {
  id: number
  unit_id: number
  unit: string
  tenant_id: number
  tenant: string
  move_in: string
  // null while the stay goes on
  move_out: string | null
  note: string | null
  // Deposit of the lease
  security_deposit: string | null
  // Kept (ADR 0021): the retention, toward unpaid months or regularisations; null without any
  deposit_retained: string | null
  // Held (ADR 0019, 0021): paid minus refunded minus kept; null without any deposit or retention recorded
  deposit_held: string | null
}

// A deposit paid by a tenant (positive) or refunded to them (negative), seen on a bank statement when linked (ADR 0019)
export type VersementDepot = {
  id: number
  tenancy_id: number
  tenant: string
  unit: string
  payment_date: string
  amount: string
  bank_transaction_id: number | null
  note: string | null
}
// A line of the retention on the deposit: an unpaid month, or a regularisation still open
export type LigneRetenue = { month: string, rent: string, charge_advance: string } | { charge_adjustment_id: number, charge_adjustment: string }

export type VersementDepotSaisi = Omit<VersementDepot, 'id' | 'tenant' | 'unit' | 'bank_transaction_id'> & { bank_transaction_id?: number | null }

export type Provision = {
  // id of the yearly total entered by hand (null when the amount comes from the monthly payments)
  id: number | null
  tenancy_id: number
  year: number
  amount: string
  source: 'payments' | 'entered'
  note: string | null
  tenant: string
  unit: string
}

export type Exercice = { building: number, start: string, end: string }

export const COLONNES_DECOMPTE = {
  gas_consumption: 'Gaz conso',
  gas_other: 'Gaz autres',
  electricity_consumption: 'Élec. conso',
  electricity_other: 'Élec. autres',
  water: 'Eau',
  household_waste: 'Ordures ménagères',
} as const

export type ColonneDecompte = keyof typeof COLONNES_DECOMPTE

export type LigneDecompte = {
  tenancy_id: number
  tenant: string
  unit: string
  charge_shares: number
  present_from: string | null
  present_to: string | null
  days: number
  total: string
  advances: string
  balance: string
} & Record<ColonneDecompte, string>

export type Decompte = Exercice & {
  tenancies: LigneDecompte[]
  summary: { energy: Energie, invoices: string, tenants: string, owner: string }[]
  avertissements: string[]
}

export type LigneDetail = {
  invoice_line_id: number
  invoice_id: number
  supplier: string
  number: string
  invoice_date: string
  energy: Energie
  category: Categorie
  label: string
  start: string
  end: string
  line_days: number
  line_amount: string
  tenancy_id: number | null
  tenant: string | null
  unit: string | null
  days: number
  amount: string
}

export type Plage = { start: string, end: string }

type LigneCouvrante = { invoice_id: number, supplier: string, number: string, label: string } & Plage

export type Couverture = Exercice & {
  energies: { energy: Energie, covered: Plage[], trous: Plage[] }[]
  chevauchements: (Plage & { energy: Energie, line_a: LigneCouvrante, line_b: LigneCouvrante })[]
  brouillons: { id: number, supplier: string, number: string, energy: Energie, invoice_date: string }[]
}

export type Regularisation = {
  id: number
  tenancy_id: number
  tenant: string
  email: string | null
  unit: string
  building_id: number
  start: string
  end: string
  amount_due: string
  advances: string
  balance: string
  // Computed (ADR 0010): brouillon (not sent), en_attente (sent, still to be paid), soldee (paid within 1 euro)
  state: 'draft' | 'pending' | 'settled'
  // The only thing chosen by the owner: what remains is given up, or unrecoverable
  decision: 'written_off' | 'unrecoverable' | null
  sent_on: string | null
  // Payments received, previous regularisations of a corrective chain included
  amount_received: string
  settled_on: string | null
  replaces_id: number | null
  replaced_by: number | null
  // false: entered by hand (sent outside the application), no supporting document
  supporting_statement: boolean
  note: string | null
}

export const ETATS_REGULARISATION: Record<Regularisation['state'], string> = {
  draft: 'Brouillon', pending: 'En attente', settled: 'Soldée',
}

export const DECISIONS_REGULARISATION: Record<NonNullable<Regularisation['decision']>, string> = {
  written_off: 'Abandonnée', unrecoverable: 'Irrécouvrable',
}

/** What to show of a regularisation: the decision when there is one, else its state. */
export const libelleRegularisation = (r: Regularisation) =>
  (r.decision ? DECISIONS_REGULARISATION[r.decision] : ETATS_REGULARISATION[r.state])

/** Still waiting for a payment or a refund: sent, not settled, no decision. */
export const aEncaisser = (r: Regularisation) => r.state === 'pending' && r.decision === null && !r.replaced_by

export type RegularisationDetail = Regularisation & {
  suggestion: { monthly_charge_advance: string | null, charge_advance_from: string }
  // What becomes of each invoice in the annexes now (ADR 0024)
  tenant_copies: { invoice_id: number, supplier: string, number: string, state: EtatAnnexe }[]
}

export type OptionsMail = {
  etalement: number
  monthly_charge_advance: string | null
  charge_advance_from: string | null
  signature: string
}

export type Mail = { destinataire: string | null, objet: string, corps: string }

// The modes a payment is typed with; « depot », a retention on the deposit, is made from the stay only (ADR 0021)
export const MODES_PAIEMENT = {
  transfer: 'Virement', direct_debit: 'Prélèvement', cheque: 'Chèque', cash: 'Espèces', other: 'Autre',
} as const
export const NOMS_MODES = { ...MODES_PAIEMENT, deposit: 'Retenue sur dépôt' } as const

export type ModePaiement = keyof typeof NOMS_MODES

/** A retention on the deposit (ADR 0021): changed from the stay only, never seen at the bank. */
export const estRetenue = (p: { method: ModePaiement | null }) => p.method === 'deposit'

export type Paiement = {
  id: number
  tenancy_id: number
  tenant: string
  unit: string
  payment_date: string
  // Month of rent covered (1st day), null for a regularisation payment alone
  month: string | null
  rent: string
  charge_advance: string
  charge_adjustment_id: number | null
  // Toward a regularisation; negative: refund paid by the owner
  charge_adjustment: string
  method: ModePaiement | null
  note: string | null
  // Movement of the bank statement it was seen on (ADR 0018)
  bank_transaction_id?: number | null
}

export type PaiementSaisi = Omit<Paiement, 'id' | 'tenant' | 'unit'> & {
  // Amount received (bank statement): the API checks that rent + provision + regularisation add up to it
  amount?: string | null
}

// Rent and provision called each month from a_partir_du (1st of the month) until the next row of the stay (ADR 0009)
export type Echeance = {
  id: number
  tenancy_id: number
  from_month: string
  rent: string
  charge_advance: string
  note: string | null
}

export type EcheanceSaisie = Omit<Echeance, 'id'>

export type MoisSejour = {
  tenancy_id: number
  tenant: string
  unit: string
  payments: { id: number, rent: string, charge_advance: string, payment_date: string, method: ModePaiement | null }[] | null
  previous: { rent: string, charge_advance: string, method: ModePaiement | null } | null
}

export type SyntheseFiscale = {
  building: number
  year: number
  vacance: { energy: Energie, amount: string }[]
  total_vacancy: string
  departs: {
    tenancy_id: number
    tenant: string
    unit: string
    move_in: string
    move_out: string
    // The entry, or the start of the management when later (ADR 0023)
    calculation_start: string
    charges: string
    advances: string
    versements: string
    not_refunded: string
    deductible: string
    deposit_retained: string
    incomplet: string[]
  }[]
  total_not_refunded: string
  total_deposits_retained: string
  total_deductible: string
  non_recoverable: { invoice_id: number, supplier: string, number: string, invoice_date: string, label: string, amount: string }[]
  pending_write_offs: { charge_adjustment_id: number, tenant: string, unit: string, start: string, end: string, remaining: string }[]
  works_invoice: TravauxFiscal[]
  total_deductible_works: string
  unpaid_works: TravauxFiscal[]
}

// Works paid by the owner (ADR 0015): deductible according to their nature; paid by bank movements only (ADR 0019),
// one or several, each in the tax year of its movement
export type NatureTravaux = 'maintenance' | 'improvement' | 'construction'
export const NATURES_TRAVAUX: Record<NatureTravaux, string> = {
  maintenance: 'Entretien, réparation',
  improvement: 'Amélioration',
  construction: 'Construction, agrandissement',
}

export type Travaux = {
  id: number
  building_id: number
  unit_id: number | null
  unit: string | null
  supplier: string
  description: string
  nature: NatureTravaux
  invoice_date: string
  total_incl_tax: string
  pdf: boolean
  note: string | null
  deductible: boolean
  payments: ReglementTravaux[]
  paid: string
  remaining: string
  // Date of the last payment, null when nothing is paid
  payment_date: string | null
}

// One payment of a works invoice: the bank movement that paid it (its date: the tax year), for an amount
export type ReglementTravaux = { id: number, bank_transaction_id: number, payment_date: string, label: string, amount: string }

// In the tax summary: one payment of the year (date_paiement, montant), or what remains unpaid (date_paiement null)
export type TravauxFiscal = Pick<Travaux, 'id' | 'supplier' | 'description' | 'nature' | 'unit' | 'invoice_date' | 'total_incl_tax'
  | 'deductible'> & { payment_date: string | null, amount: string }

// The company, its partners, its general meetings (ADR 0016)
export type Societe = { name: string, legal_form: string, capital: string | null, registered_office: string | null, rcs: string | null }
export type Associe = { id: number, name: string, shares: number, manager: boolean, address: string | null, note: string | null }
export type TypeAssemblee = 'ordinary' | 'extraordinary'
export type PresenceAssocie = 'present' | 'represented' | 'absent'
export const PRESENCES: Record<PresenceAssocie, string> = { present: 'Présent', represented: 'Représenté', absent: 'Absent' }

export type Resolution = {
  position: number
  title: string
  text: string
  votes_for: number
  votes_against: number
  abstentions: number
  adoptee: boolean
  unanimite: boolean
}

export type Assemblee = {
  id: number
  number: number | null
  type: TypeAssemblee
  date: string
  time: string | null
  place: string | null
  agenda: string
  chair: string | null
  remarks: string | null
  status: 'draft' | 'closed'
  closed_at: string | null
  signed_minutes: boolean
  total_shares: number
  shares_present: number
  attendances: { partner_id: number, name: string, shares: number, manager: boolean, attendance: PresenceAssocie, represented_by: string | null }[]
  resolutions: Resolution[]
}

export type AssembleeResumee = Pick<Assemblee, 'id' | 'number' | 'type' | 'date' | 'status' | 'signed_minutes'> & { resolution_count: number }

// The invoice only: its payments are bank movements linked to it (« Catégorisation », or the invoice)
export type TravauxSaisie = Pick<Travaux, 'building_id' | 'unit_id' | 'supplier' | 'description' | 'nature'
  | 'invoice_date' | 'total_incl_tax' | 'note'>

// ---------------------------------------------------------------- bank statements (ADR 0018)

export type Releve = {
  id: number
  bank: string
  account: string
  statement_date: string
  previous_balance: string
  new_balance: string
  pdf: boolean
  extractor_id: number | null
  imported_at: string
}

// suite: the opening balance is the closing balance of the previous statement of the account (null: the first one)
export type ReleveResume = Releve & { transaction_count: number, suite: boolean | null }

// What a bank movement is (ADR 0018, 0019, 0022), fixed in the code: « locataire », « travaux », « depot_garantie »,
// « energie », « eau » and « impots » have a detail (the payments of a tenant, the payments of works invoices, the
// deposits paid or refunded, the invoices of charges paid, linked to it); the others only a note, required for
// « autre ». sens: the movements it applies to.
export type CategorieMouvement = 'tenant' | 'works' | 'security_deposit' | 'agency' | 'loan' | 'insurance' | 'energy' | 'water'
  | 'taxes' | 'bank_fees' | 'co_ownership' | 'fees' | 'partners' | 'internal_transfer' | 'other'
export const CATEGORIES_MOUVEMENT: Record<CategorieMouvement, { name: string, sens: 'credit' | 'debit' | 'tous', icone: string }> = {
  tenant: { name: 'Paiement de locataire', sens: 'tous', icone: 'oi oi-users' },
  works: { name: 'Travaux', sens: 'debit', icone: 'oi oi-hammer' },
  security_deposit: { name: 'Dépôt de garantie', sens: 'tous', icone: 'oi oi-key' },
  agency: { name: 'Versement d\'une agence (gérance)', sens: 'tous', icone: 'oi oi-shop' },
  loan: { name: 'Emprunt', sens: 'tous', icone: 'oi oi-building-columns' },
  insurance: { name: 'Assurance', sens: 'tous', icone: 'oi oi-shield' },
  // « tous »: a credit may refund an invoice (ADR 0022)
  energy: { name: 'Énergie (gaz, électricité)', sens: 'tous', icone: 'oi oi-bolt' },
  water: { name: 'Eau', sens: 'tous', icone: 'oi oi-filter' },
  taxes: { name: 'Impôts et taxes', sens: 'tous', icone: 'oi oi-percentage' },
  bank_fees: { name: 'Frais bancaires', sens: 'tous', icone: 'oi oi-credit-card' },
  co_ownership: { name: 'Copropriété', sens: 'tous', icone: 'oi oi-building' },
  fees: { name: 'Honoraires (comptable, agence)', sens: 'tous', icone: 'oi oi-briefcase' },
  partners: { name: 'Associés (apports, versements)', sens: 'tous', icone: 'oi oi-user' },
  internal_transfer: { name: 'Virement entre comptes de la société', sens: 'tous', icone: 'oi oi-arrow-right-arrow-left' },
  other: { name: 'Autre', sens: 'tous', icone: 'oi oi-tag' },
}
// Debits that pay invoices of charges (ADR 0022): their detail is the invoices paid
export const AVEC_FACTURE: CategorieMouvement[] = ['energy', 'water', 'taxes']
export const AVEC_DETAIL: CategorieMouvement[] = ['tenant', 'works', 'security_deposit', ...AVEC_FACTURE]

// a_categoriser: no category yet; incomplet: a category with a detail that does not cover the amount (a note does
// not make up for it); categorise
export type StatutMouvement = 'to_categorise' | 'incomplet' | 'categorise'

export type Mouvement = {
  id: number
  bank_statement_id: number
  position: number
  transaction_date: string
  value_date: string | null
  label: string
  detail: string | null
  // Credit positive, debit negative
  amount: string
  category: CategorieMouvement | null
  // Required for « autre »; otherwise a comment (it never completes a detail)
  note: string | null
  account: string
  statement_date: string
  payments: { id: number, tenant: string, unit: string, month: string | null, total: string }[]
  // Payments of works invoices: total is this payment; montant_ttc and reste, those of the invoice
  works_invoices: { id: number, works_invoice_payment_id: number, description: string, supplier: string, total: string, total_incl_tax: string, remaining: string }[]
  // Payments of invoices of charges (ADR 0022), the same way
  invoices: { id: number, invoice_payment_id: number, supplier: string, number: string, energy: Energie, invoice_date: string,
    total: string, total_incl_tax: string, remaining: string }[]
  deposits: { id: number, tenancy_id: number, tenant: string, unit: string, date: string, amount: string }[]
  covered: string
  status: StatutMouvement
  // Recorded by hand, of the same amount and within ten days: to link
  candidates: ({ type: 'payment', id: number, tenant: string, unit: string, month: string | null, date: string }
    // An invoice whose unpaid rest is the amount; date: that of the invoice
    | { type: 'works', id: number, description: string, supplier: string, date: string | null }
    // An invoice of charges whose rest is the amount, or whose number is in the label (ADR 0022)
    | { type: 'invoice', id: number, supplier: string, number: string, energy: Energie, date: string | null, status?: Statut }
    // Several payments of one tenant whose sum is the amount (a transfer of several months); mois: « 10/2025, 11/2025 »
    | { type: 'group', ids: number[], tenant: string, unit: string, month: string })[]
}

export type ReleveDetail = Releve & { transactions: Mouvement[] }

// A statement read in the browser, as sent on import
export type ReleveLu = {
  extractor_id: number
  account: string
  statement_date: string
  previous_balance: string
  new_balance: string
  totaux: { debit: string | null, credit: string | null } | null
  transactions: { transaction_date: string, value_date: string | null, label: string, detail: string | null, amount: string }[]
}

export type ReleveAvecPdf = { id: number, account: string, statement_date: string, previous_balance: string, new_balance: string, extractor_id: number | null }

export type DetailFiltre = { tenancy?: number | 'owner', energy?: Energie, group?: 'consumption' | 'other' }

const exerciceQuery = ({ building, start, end }: Exercice) => `building=${building}&start=${start}&end=${end}`

export type Ligne = {
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

// An invoice extractor as stored (ADR 0013): never changed, a correction is the next version of its supplier
export type ExtracteurEnregistre = {
  id: number
  supplier: string
  version: number
  // ADR 0018: an extractor reads invoices or bank statements (no energy then)
  type: 'invoice' | 'bank_statement'
  energy: Energie | null
  settings: Reglages
  source: string
  code: string
  engine: number
  note: string | null
  created_at: string
  latest: boolean
  invoice_count: number
  statement_count: number
}

export type NouvelleVersion = Pick<ExtracteurEnregistre, 'supplier' | 'energy' | 'settings' | 'source' | 'code' | 'engine' | 'note'>
  & { type?: 'invoice' | 'bank_statement' }

// An invoice of a supplier with its PDF, every building: read again by a new version (non-regression)
export type FactureAvecPdf = {
  id: number
  number: string
  invoice_date: string
  total_incl_tax: string | null
  status: Statut
  extractor_id: number | null
  building: string
  tenant_copy: EtatAnnexe
  supplier_id: number
  // ADR 0025: the zones of its scans adjusted by hand; null, those of its supplier
  masked_zones: ZoneSaisie[] | null
}

// A supplier (ADR 0014): its invoices, the last version of its extractor; « confidentiel »: never joined in annex
export type Fournisseur = {
  id: number
  name: string
  confidential: boolean
  energies: Energie[] | null
  invoice_count: number
  pdf_count: number
  // A bank (ADR 0018): its statements
  statement_count: number
  extractor: { id: number, version: number, type: 'invoice' | 'bank_statement' } | null
  // ADR 0025: the zones masked on the scans of its invoices, drawn by hand
  masked_zones: ZoneSaisie[]
}

/** A zone drawn by hand on a scanned page (ADR 0025): page from 1, bounds in fractions of the page from its top-left. */
export type ZoneSaisie = { page: number, x0: number, y0: number, x1: number, y1: number }

// What the browser read from a PDF, sent with it on import
export type Brouillon = {
  extractor_id: number
  number: string
  invoice_date: string
  total_incl_tax: string | null
  lines: Ligne[]
}

export type Facture = {
  id: number
  building_id: number
  supplier: string
  energy: Energie
  number: string
  invoice_date: string
  // Empty on a draft whose total is not on the PDF (ADR 0013)
  total_incl_tax: string | null
  status: Statut
  note: string | null
  pdf: boolean
  // ADR 0017: replaced by which invoice, when, why; on the draft of a correction, the invoice it will replace
  replaced_by: number | null
  replaced_at: string | null
  replacement_reason: string | null
  replaces_id: number | null
  // ADR 0022: paid by bank movements, what remains, the date of the last payment
  paid: string
  remaining: string
  payment_date: string | null
  supplier_id: number
  // Version of the extractor that read it (null: typed by hand)
  extractor_id: number | null
  // ADR 0024: what becomes of it in the annexes of a supporting document
  tenant_copy: EtatAnnexe
  // ADR 0025: the zones of its scans adjusted by hand; null, those of its supplier
  masked_zones: ZoneSaisie[] | null
}

/**
 * The invoice in the annexes (ADR 0024): never joined (confidential supplier), no PDF, its version in images to make
 * (none, or made from another PDF), to verify by eye, or verified.
 */
export type EtatAnnexe = 'confidential' | 'no_pdf' | 'to_make' | 'to_check' | 'checked'

/** The current version in images of an invoice. */
export type AnnexeFacture = {
  id: number
  extractor_id: number | null
  terms: string[]
  settings: { dpi: number, threshold: number }
  // Number of zones painted
  zones: number
  created_at: string
  checked_at: string | null
  // ADR 0025: its pages that were scans, masked by zones drawn by hand
  scanned_pages: number[]
}

/** A version in images made in the browser, sent with its PDF. */
export type AnnexeEnvoyee = {
  zones: { page: number, x0: number, y0: number, x1: number, y1: number, origin: string }[]
  extractor_id: number | null
  terms: string[]
  settings: { dpi: number, threshold: number }
  scanned_pages: number[]
}

export type ReglementFacture = { id: number, bank_transaction_id: number, payment_date: string, label: string, amount: string }
// A debit that may pay an invoice: what remains of it; correspond, the rest of the invoice
export type MouvementPourFacture = {
  id: number, transaction_date: string, label: string, amount: string, category: CategorieMouvement | null, remaining: string, correspond: boolean
}

export type ReferenceFacture = { id: number, supplier: string, number: string, status: Statut }
export type LiensFacture = {
  remplacante: ReferenceFacture | null
  remplacees: ReferenceFacture[]
  corrige: ReferenceFacture | null
  correction: ReferenceFacture | null
}
// Sent regularisations whose period touches a replaced invoice: to check (« à rectifier »)
export type RegularisationTouchee = { id: number, tenant: string, unit: string, start: string, end: string, balance: string }

export type FactureResumee = Facture & {
  total_ok: boolean | null
  start: string | null
  end: string | null
  line_count: number
}

export type Finding = {
  severity: 'error' | 'warning'
  code: string
  message: string
  line: number | null
  input_error: boolean
}

export type Checks = {
  lines_total: string
  gap: string
  ok: boolean
  findings: Finding[]
  can_save: boolean
  can_validate: boolean
}

export type FactureDetail = {
  invoice: Facture, lines: Ligne[], liens: LiensFacture, payments: ReglementFacture[], checks: Checks,
  tenant_copy: AnnexeFacture | null
}
export type FactureRemplacee = FactureDetail & { charge_adjustments: RegularisationTouchee[] }

export type FactureEnTete = Pick<Facture, 'number' | 'invoice_date' | 'total_incl_tax' | 'energy' | 'note'>

export type FactureSaisie = FactureEnTete & {
  // Lines as typed in the grid: the server reports what cannot be stored
  lines: Ligne[]
}

// ---------------------------------------------------------------- authentication (ADR 0020)

export type Utilisateur = { id: number, email: string, name: string }
export type Passkey = { id: string, device: string, created_at: string, used_at: string | null }
export type JetonApi = { id: number, name: string, created_at: string, used_at: string | null, revoked_at: string | null }

export class ApiError extends Error {
  readonly status: number
  readonly body: Record<string, unknown>

  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message)
    this.status = status
    this.body = body
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${url}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return answer<T>(response)
}

// The pages open without a session (ADR 0020): connecting, registering a passkey from a link
export const PAGES_PUBLIQUES = ['/connexion', '/enregistrer']

async function answer<T>(response: Response): Promise<T> {
  if (response.status === 204) {
    return undefined as T
  }
  // Session ended (or none): to the login page, back here once connected
  if (response.status === 401 && !new URL(response.url).pathname.startsWith('/api/auth/')
    && !PAGES_PUBLIQUES.includes(window.location.pathname)) {
    window.location.assign(`/connexion?retour=${encodeURIComponent(window.location.pathname + window.location.search)}`)
    return new Promise<T>(() => {})
  }
  const json = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new ApiError(json.message ?? `Erreur ${response.status}`, response.status, json)
  }
  return json as T
}

export const api = {
  // ---------------------------------------------------------------- authentication (ADR 0020)
  session: () => request<{ app_user: Utilisateur }>('GET', '/auth/session'),
  connexionOptions: () => request<{ id: string, options: PublicKeyCredentialRequestOptionsJSON }>('POST', '/auth/connexion/options'),
  connexion: (id: string, reponse: unknown) => request<{ ok: true }>('POST', '/auth/connexion', { id, reponse }),
  deconnexion: () => request<void>('POST', '/auth/deconnexion'),
  // From a link (jeton), or for the account connected (this device)
  enregistrementOptions: (jeton: string | null) => request<{ id: string, options: PublicKeyCredentialCreationOptionsJSON, app_user: Utilisateur }>(
    'POST', '/auth/enregistrement/options', { jeton }),
  enregistrement: (id: string, reponse: unknown, device: string) => request<{ ok: true }>('POST', '/auth/enregistrement', { id, reponse, device }),
  passkeys: () => request<Passkey[]>('GET', '/auth/passkeys'),
  supprimerPasskey: (id: string) => request<void>('DELETE', `/auth/passkeys/${encodeURIComponent(id)}`),
  lienAppareil: () => request<{ url: string, expires_at: string }>('POST', '/auth/liens'),
  jetons: () => request<JetonApi[]>('GET', '/auth/jetons'),
  creerJeton: (name: string) => request<{ id: number, jeton: string }>('POST', '/auth/jetons', { name }),
  revoquerJeton: (id: number) => request<void>('DELETE', `/auth/jetons/${id}`),

  buildings: () => request<Immeuble[]>('GET', '/immeubles'),
  building: (id: number) => request<ImmeubleDetail>('GET', `/immeubles/${id}`),
  creerImmeuble: (data: Pick<Immeuble, 'code' | 'name' | 'address'>) => request<Immeuble>('POST', '/immeubles', data),
  modifierImmeuble: (id: number, data: Pick<Immeuble, 'name' | 'address' | 'managed_from'>) =>
    request<Immeuble>('PUT', `/immeubles/${id}`, data),
  creerLot: (building: number, unit: Omit<Lot, 'id' | 'building_id'>) =>
    request<Lot>('POST', `/immeubles/${building}/lots`, unit),
  modifierLot: (unit: Lot) => request<Lot>('PUT', `/lots/${unit.id}`, unit),
  supprimerLot: (id: number) => request<void>('DELETE', `/lots/${id}`),

  tenants: () => request<Locataire[]>('GET', '/locataires'),
  creerLocataire: (l: Omit<Locataire, 'id' | 'tenancy_count'>) => request<Locataire>('POST', '/locataires', l),
  modifierLocataire: (l: Omit<Locataire, 'tenancy_count'>) => request<Locataire>('PUT', `/locataires/${l.id}`, l),
  supprimerLocataire: (id: number) => request<void>('DELETE', `/locataires/${id}`),

  tenancies: (building: number) => request<Sejour[]>('GET', `/sejours?building=${building}`),
  creerSejour: (s: Omit<Sejour, 'id' | 'unit' | 'tenant' | 'deposit_held' | 'deposit_retained'>) => request<Sejour>('POST', '/sejours', s),
  modifierSejour: (s: Omit<Sejour, 'unit' | 'tenant' | 'deposit_held' | 'deposit_retained'>) => request<Sejour>('PUT', `/sejours/${s.id}`, s),
  supprimerSejour: (id: number) => request<void>('DELETE', `/sejours/${id}`),

  rent_schedules: (building: number) => request<Echeance[]>('GET', `/echeances?building=${building}`),
  creerEcheance: (e: EcheanceSaisie) => request<Echeance>('POST', '/echeances', e),
  modifierEcheance: (id: number, e: EcheanceSaisie) => request<Echeance>('PUT', `/echeances/${id}`, e),
  supprimerEcheance: (id: number) => request<void>('DELETE', `/echeances/${id}`),

  advances: (building: number) => request<Provision[]>('GET', `/provisions?building=${building}`),
  enregistrerProvision: (p: Pick<Provision, 'tenancy_id' | 'year' | 'amount' | 'note'>) =>
    request<Provision>('PUT', '/provisions', p),
  supprimerProvision: (id: number) => request<void>('DELETE', `/provisions/${id}`),

  charge_statement: (e: Exercice) => request<Decompte>('GET', `/decompte?${exerciceQuery(e)}`),
  detail: (e: Exercice, f: DetailFiltre) => {
    const filtres = Object.entries(f).filter(([, v]) => v !== undefined).map(([k, v]) => `&${k}=${v}`).join('')
    return request<LigneDetail[]>('GET', `/decompte/detail?${exerciceQuery(e)}${filtres}`)
  },
  couverture: (e: Exercice) => request<Couverture>('GET', `/couverture?${exerciceQuery(e)}`),
  exportUrl: (e: Exercice) => `/api/decompte/export?${exerciceQuery(e)}`,

  charge_adjustments: (building: number) => request<Regularisation[]>('GET', `/regularisations?building=${building}`),
  charge_adjustment: (id: number) => request<RegularisationDetail>('GET', `/regularisations/${id}`),
  creerRegularisation: (tenancy_id: number, start: string, end: string) =>
    request<Regularisation>('POST', '/regularisations', { tenancy_id, start, end }),
  saisirRegularisation: (r: { tenancy_id: number, start: string, end: string, balance: string, advances: string | null,
    sent_on: string, amount_received: string | null, note: string | null }) =>
    request<Regularisation>('POST', '/regularisations/manuelle', r),
  rectificatif: (id: number) => request<Regularisation>('POST', `/regularisations/${id}/rectificatif`),
  marquerEnvoyee: (id: number, sent_on: string) =>
    request<Regularisation>('POST', `/regularisations/${id}/envoi`, { sent_on }),
  // « Marquer envoyée » done by mistake: back to a draft (refused once a payment, a decision or a corrective depends on it)
  annulerEnvoi: (id: number) => request<Regularisation>('DELETE', `/regularisations/${id}/envoi`),
  supprimerRegularisation: (id: number) => request<void>('DELETE', `/regularisations/${id}`),
  mail: (id: number, options: OptionsMail) => request<Mail>('POST', `/regularisations/${id}/mail`, options),
  decisionRegularisation: (id: number, decision: Regularisation['decision']) =>
    request<Regularisation>('POST', `/regularisations/${id}/decision`, { decision }),

  // annee null: every year
  payments: (building: number, year: number | null) =>
    request<Paiement[]>('GET', `/paiements?building=${building}${year === null ? '' : `&year=${year}`}`),
  // Payments toward a regularisation, any year, previous regularisations of its corrective chain included
  paiementsRegularisation: (building: number, charge_adjustment: number) =>
    request<Paiement[]>('GET', `/paiements?building=${building}&charge_adjustment=${charge_adjustment}`),
  paiementsDuMois: (building: number, month: string) =>
    request<MoisSejour[]>('GET', `/paiements/mois?building=${building}&month=${month}`),
  creerPaiement: (p: PaiementSaisi) => request<Paiement>('POST', '/paiements', p),
  modifierPaiement: (id: number, p: PaiementSaisi) => request<Paiement>('PUT', `/paiements/${id}`, p),
  supprimerPaiement: (id: number) => request<void>('DELETE', `/paiements/${id}`),

  works_invoice: (building: number) => request<Travaux[]>('GET', `/travaux?building=${building}`),
  creerTravaux: (t: TravauxSaisie) => request<Travaux>('POST', '/travaux', t),
  modifierTravaux: (id: number, t: TravauxSaisie) => request<Travaux>('PUT', `/travaux/${id}`, t),
  supprimerTravaux: (id: number) => request<void>('DELETE', `/travaux/${id}`),
  travauxPdfUrl: (id: number) => `/api/travaux/${id}/pdf`,
  async joindrePdfTravaux(id: number, file: File) {
    const form = new FormData()
    form.append('file', file)
    return answer<Travaux>(await fetch(`/api/travaux/${id}/pdf`, { method: 'POST', body: form }))
  },

  company: () => request<{ company: Societe | null, partners: Associe[] }>('GET', '/societe'),
  modifierSociete: (s: Societe) => request<{ company: Societe | null, partners: Associe[] }>('PUT', '/societe', s),
  creerAssocie: (a: Omit<Associe, 'id'>) => request<Associe>('POST', '/associes', a),
  modifierAssocie: (a: Associe) => request<Associe>('PUT', `/associes/${a.id}`, a),
  supprimerAssocie: (id: number) => request<void>('DELETE', `/associes/${id}`),
  assemblees: () => request<AssembleeResumee[]>('GET', '/assemblees'),
  general_meeting: (id: number) => request<Assemblee>('GET', `/assemblees/${id}`),
  creerAssemblee: (a: { type: TypeAssemblee, date: string, place: string | null, modele: 'annuelle' | 'vide' }) =>
    request<Assemblee>('POST', '/assemblees', a),
  modifierAssemblee: (a: Assemblee) => request<Assemblee>('PUT', `/assemblees/${a.id}`, a),
  supprimerAssemblee: (id: number) => request<void>('DELETE', `/assemblees/${id}`),
  clore: (id: number) => request<Assemblee>('POST', `/assemblees/${id}/cloture`),
  pvUrl: (id: number) => `/api/assemblees/${id}/pv`,
  pvSigneUrl: (id: number) => `/api/assemblees/${id}/pv-signe`,
  async joindrePvSigne(id: number, file: File) {
    const form = new FormData()
    form.append('file', file)
    return answer<Assemblee>(await fetch(`/api/assemblees/${id}/pv-signe`, { method: 'POST', body: form }))
  },

  statements: () => request<ReleveResume[]>('GET', '/releves'),
  releve: (id: number) => request<ReleveDetail>('GET', `/releves/${id}`),
  supprimerReleve: (id: number) => request<void>('DELETE', `/releves/${id}`),
  relevePdfUrl: (id: number) => `/api/releves/${id}/pdf`,
  async importerReleve(fichier: File, releve: ReleveLu) {
    const form = new FormData()
    form.append('bank_statement', JSON.stringify(releve))
    form.append('file', fichier)
    return answer<ReleveDetail>(await fetch('/api/releves/import', { method: 'POST', body: form }))
  },
  relevesDeLaBanque: (supplier: string) =>
    request<ReleveAvecPdf[]>('GET', `/extracteurs/releves?supplier=${encodeURIComponent(supplier)}`),
  transactions: (status: 'tous' | StatutMouvement, du?: string, au?: string) =>
    request<Mouvement[]>('GET', `/mouvements?status=${status}${du ? `&from=${du}` : ''}${au ? `&to=${au}` : ''}`),
  categoriserMouvement: (id: number, category: CategorieMouvement, note: string | null = null) =>
    request<Mouvement>('PUT', `/mouvements/${id}/categorie`, { category, note }),
  retirerCategorie: (id: number) => request<Mouvement>('DELETE', `/mouvements/${id}/categorie`),
  lierMouvement: (id: number, lien: { payment_id: number } | { works_invoice_id: number } | { invoice_id: number } | { payment_ids: number[] }
    | { deposit_payment_id: number }) => request<Mouvement>('POST', `/mouvements/${id}/lier`, lien),
  delierMouvement: (id: number, lien: { payment_id: number } | { works_invoice_payment_id: number } | { invoice_payment_id: number } | { deposit_payment_id: number }) =>
    request<Mouvement>('POST', `/mouvements/${id}/delier`, lien),

  deposits: (building: number) => request<VersementDepot[]>('GET', `/depots?building=${building}`),
  creerDepot: (d: VersementDepotSaisi) => request<VersementDepot>('POST', '/depots', d),
  modifierDepot: (id: number, d: VersementDepotSaisi) => request<VersementDepot>('PUT', `/depots/${id}`, d),
  supprimerDepot: (id: number) => request<void>('DELETE', `/depots/${id}`),
  // The retention of a stay, replaced as a whole (no line: removed)
  retenue: (tenancy: number, r: { date: string, lines: LigneRetenue[] }) =>
    request<unknown[]>('PUT', `/sejours/${tenancy}/retenue`, r),

  fiscal: (building: number, year: number) => request<SyntheseFiscale>('GET', `/fiscal?building=${building}&year=${year}`),

  justificatifUrl: (id: number) => `/api/regularisations/${id}/justificatif`,
  apercuUrl: (e: Exercice, tenancy: number) => `/api/justificatif?${exerciceQuery(e)}&tenancy=${tenancy}`,

  invoices: (building: number) => request<FactureResumee[]>('GET', `/factures?building=${building}`),
  invoice: (id: number) => request<FactureDetail>('GET', `/factures/${id}`),
  enregistrer: (id: number, saisie: FactureSaisie) => request<FactureDetail>('PUT', `/factures/${id}`, saisie),
  valider: (id: number) => request<FactureRemplacee>('POST', `/factures/${id}/valider`),
  remplacer: (id: number, par: number, motif: string) =>
    request<FactureRemplacee>('POST', `/factures/${id}/remplacer`, { par, motif }),
  corriger: (id: number) => request<FactureDetail>('POST', `/factures/${id}/corriger`),
  // Payments by bank movements (ADR 0022)
  mouvementsPourFacture: (id: number) => request<MouvementPourFacture[]>('GET', `/factures/${id}/mouvements`),
  reglerFacture: (id: number, bank_transaction: number) => request<FactureDetail>('POST', `/factures/${id}/reglements`, { bank_transaction_id: bank_transaction }),
  supprimerReglementFacture: (id: number, reglement: number) => request<FactureDetail>('DELETE', `/factures/${id}/reglements/${reglement}`),
  supprimer: (id: number) => request<void>('DELETE', `/factures/${id}`),
  controler: (saisie: Pick<FactureSaisie, 'total_incl_tax' | 'lines'>) => request<Checks>('POST', '/controle', saisie),
  pdfUrl: (id: number) => `/api/factures/${id}/pdf`,

  // Version in images joined to the supporting documents (ADR 0024)
  annexePdfUrl: (id: number, version: number) => `/api/factures/${id}/annexe/pdf?v=${version}`,
  async envoyerAnnexe(id: number, pdf: Uint8Array, tenant_copy: AnnexeEnvoyee) {
    const form = new FormData()
    form.append('tenant_copy', JSON.stringify(tenant_copy))
    form.append('file', new Blob([pdf as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }), 'annexe.pdf')
    return answer<FactureDetail>(await fetch(`/api/factures/${id}/annexe`, { method: 'POST', body: form }))
  },
  verifierAnnexe: (id: number, tenant_copy: number) =>
    request<FactureDetail>('POST', `/factures/${id}/annexe/verifiee`, { tenant_copy_id: tenant_copy }),
  // ADR 0025: the zones of its scans adjusted by hand (null: those of its supplier)
  modifierZonesFacture: (id: number, zones: ZoneSaisie[] | null) => request<FactureDetail>('PUT', `/factures/${id}/zones`, { zones }),
  termesMasques: () => request<string[]>('GET', '/termes-masques'),
  modifierTermesMasques: (terms: string[]) => request<string[]>('PUT', '/termes-masques', { terms }),

  async joindrePdf(id: number, file: File) {
    const form = new FormData()
    form.append('file', file)
    return answer<FactureDetail>(await fetch(`/api/factures/${id}/pdf`, { method: 'POST', body: form }))
  },

  // Invoice typed by hand, with the PDF when there is one (not read by the parsers): draft without lines
  async creerFacture(building: number, entete: FactureEnTete & { supplier: string }, file: File | null) {
    const form = new FormData()
    for (const [name, value] of Object.entries(entete)) {
      form.append(name, value ?? '')
    }
    if (file) {
      form.append('file', file)
    }
    return answer<FactureDetail>(await fetch(`/api/factures?building=${building}`, { method: 'POST', body: form }))
  },

  // The PDF and the draft read from it in the browser (ADR 0013)
  async importer(building: number, file: File, brouillon: Brouillon) {
    const form = new FormData()
    form.append('draft', JSON.stringify(brouillon))
    form.append('file', file)
    const response = await fetch(`/api/factures/import?building=${building}`, { method: 'POST', body: form })
    return answer<FactureDetail>(response)
  },

  sante: () => request<{ status: string, version: string }>('GET', '/health'),
  suppliers: () => request<Fournisseur[]>('GET', '/fournisseurs'),
  supplier: (id: number) => request<Fournisseur>('GET', `/fournisseurs/${id}`),
  modifierFournisseur: (id: number, modif: { confidential: boolean }) => request<Fournisseur>('PATCH', `/fournisseurs/${id}`, modif),
  modifierZonesFournisseur: (id: number, zones: ZoneSaisie[]) => request<Fournisseur>('PUT', `/fournisseurs/${id}/zones`, { zones }),
  extractors: () => request<ExtracteurEnregistre[]>('GET', '/extracteurs'),
  extractor: (id: number) => request<ExtracteurEnregistre>('GET', `/extracteurs/${id}`),
  nouvelleVersion: (version: NouvelleVersion) => request<ExtracteurEnregistre>('POST', '/extracteurs', version),
  facturesDuFournisseur: (supplier: string) =>
    request<FactureAvecPdf[]>('GET', `/extracteurs/factures?supplier=${encodeURIComponent(supplier)}`),
}

import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser'

// Client of the Colibri API (same origin: /api, relayed by Vite in development and Nginx in production).
// Types mirror backend/src/invoices/types.ts and checks.ts: amounts are decimal strings, dates ISO with
// inclusive bounds.

import type { Affectation, Categorie, Energie, Reglages } from './extraction/contrat'

export type { Affectation, Categorie, Energie }
// remplacee: a validated invoice replaced by another one, or corrected (ADR 0017); out of the statements
export type Statut = 'a_verifier' | 'validee' | 'remplacee'
export const STATUTS: Record<Statut, string> = { a_verifier: 'Brouillon', validee: 'Validée', remplacee: 'Remplacée' }

export const CATEGORIES: Categorie[] = ['consommation', 'abonnement', 'taxe', 'prestation', 'penalite', 'autre']
// ADR 0013: recoverable (allocated), borne by the owner (tax summary), about another property (left out)
export const AFFECTATIONS: Record<Affectation, string> = {
  recuperable: 'récupérable',
  proprietaire: 'propriétaire',
  hors_immeuble: 'hors immeuble',
}
export const ENERGIES: Record<Energie, string> = {
  gaz: 'Gaz',
  electricite: 'Électricité',
  eau: 'Eau',
  ordures_menageres: 'Ordures ménagères',
  autre: 'Autre',
}

export type Immeuble = {
  id: number
  code: string
  nom: string
  adresse: string | null
  // ADR 0023: start of the management in the application (before: an agency, or nothing)
  debut_gestion: string | null
  nb_lots: number
  total_tantiemes: number
}

export type Lot = {
  id: number
  immeuble_id: number
  code: string
  designation: string | null
  surface_m2: string | null
  tantiemes: number
}

export type ImmeubleDetail = Omit<Immeuble, 'nb_lots'> & { lots: Lot[] }

export type Locataire = {
  id: number
  nom: string
  email: string | null
  telephone: string | null
  note: string | null
  nb_sejours: number
}

export type Sejour = {
  id: number
  lot_id: number
  lot: string
  locataire_id: number
  locataire: string
  entree: string
  // null while the stay goes on
  sortie: string | null
  note: string | null
  // Deposit of the lease
  depot_garantie: string | null
  // Kept (ADR 0021): the retention, toward unpaid months or regularisations; null without any
  depot_retenu: string | null
  // Held (ADR 0019, 0021): paid minus refunded minus kept; null without any deposit or retention recorded
  depot_detenu: string | null
}

// A deposit paid by a tenant (positive) or refunded to them (negative), seen on a bank statement when linked (ADR 0019)
export type VersementDepot = {
  id: number
  sejour_id: number
  locataire: string
  lot: string
  date_versement: string
  montant: string
  mouvement_id: number | null
  note: string | null
}
// A line of the retention on the deposit: an unpaid month, or a regularisation still open
export type LigneRetenue = { mois: string, loyer: string, provision: string } | { regularisation_id: number, regularisation: string }

export type VersementDepotSaisi = Omit<VersementDepot, 'id' | 'locataire' | 'lot' | 'mouvement_id'> & { mouvement_id?: number | null }

export type Provision = {
  // id of the yearly total entered by hand (null when the amount comes from the monthly payments)
  id: number | null
  sejour_id: number
  annee: number
  montant: string
  source: 'paiements' | 'saisie'
  note: string | null
  locataire: string
  lot: string
}

export type Exercice = { immeuble: number, debut: string, fin: string }

export const COLONNES_DECOMPTE = {
  gaz_consommation: 'Gaz conso',
  gaz_autres: 'Gaz autres',
  electricite_consommation: 'Élec. conso',
  electricite_autres: 'Élec. autres',
  eau: 'Eau',
  ordures_menageres: 'Ordures ménagères',
} as const

export type ColonneDecompte = keyof typeof COLONNES_DECOMPTE

export type LigneDecompte = {
  sejour_id: number
  locataire: string
  lot: string
  tantiemes: number
  present_du: string | null
  present_au: string | null
  jours: number
  total: string
  provisions: string
  solde: string
} & Record<ColonneDecompte, string>

export type Decompte = Exercice & {
  sejours: LigneDecompte[]
  synthese: { energie: Energie, factures: string, locataires: string, proprietaire: string }[]
  avertissements: string[]
}

export type LigneDetail = {
  ligne_id: number
  facture_id: number
  fournisseur: string
  numero: string
  date_facture: string
  energie: Energie
  categorie: Categorie
  libelle: string
  debut: string
  fin: string
  jours_ligne: number
  montant_ligne: string
  sejour_id: number | null
  locataire: string | null
  lot: string | null
  jours: number
  montant: string
}

export type Plage = { debut: string, fin: string }

type LigneCouvrante = { facture_id: number, fournisseur: string, numero: string, libelle: string } & Plage

export type Couverture = Exercice & {
  energies: { energie: Energie, couvert: Plage[], trous: Plage[] }[]
  chevauchements: (Plage & { energie: Energie, ligne_a: LigneCouvrante, ligne_b: LigneCouvrante })[]
  brouillons: { id: number, fournisseur: string, numero: string, energie: Energie, date_facture: string }[]
}

export type Regularisation = {
  id: number
  sejour_id: number
  locataire: string
  email: string | null
  lot: string
  immeuble_id: number
  debut: string
  fin: string
  montant_du: string
  provisions: string
  solde: string
  // Computed (ADR 0010): brouillon (not sent), en_attente (sent, still to be paid), soldee (paid within 1 euro)
  etat: 'brouillon' | 'en_attente' | 'soldee'
  // The only thing chosen by the owner: what remains is given up, or unrecoverable
  decision: 'abandonnee' | 'irrecouvrable' | null
  date_envoi: string | null
  // Payments received, previous regularisations of a corrective chain included
  montant_recu: string
  date_solde: string | null
  remplace_id: number | null
  remplacee_par: number | null
  // false: entered by hand (sent outside the application), no supporting document
  justificatif: boolean
  note: string | null
}

export const ETATS_REGULARISATION: Record<Regularisation['etat'], string> = {
  brouillon: 'Brouillon', en_attente: 'En attente', soldee: 'Soldée',
}

export const DECISIONS_REGULARISATION: Record<NonNullable<Regularisation['decision']>, string> = {
  abandonnee: 'Abandonnée', irrecouvrable: 'Irrécouvrable',
}

/** What to show of a regularisation: the decision when there is one, else its state. */
export const libelleRegularisation = (r: Regularisation) =>
  (r.decision ? DECISIONS_REGULARISATION[r.decision] : ETATS_REGULARISATION[r.etat])

/** Still waiting for a payment or a refund: sent, not settled, no decision. */
export const aEncaisser = (r: Regularisation) => r.etat === 'en_attente' && r.decision === null && !r.remplacee_par

export type RegularisationDetail = Regularisation & {
  suggestion: { provision_mensuelle: string | null, provision_a_partir_du: string }
  // What becomes of each invoice in the annexes now (ADR 0024)
  annexes: { facture_id: number, fournisseur: string, numero: string, etat: EtatAnnexe }[]
}

export type OptionsMail = {
  etalement: number
  provision_mensuelle: string | null
  provision_a_partir_du: string | null
  signature: string
}

export type Mail = { destinataire: string | null, objet: string, corps: string }

// The modes a payment is typed with; « depot », a retention on the deposit, is made from the stay only (ADR 0021)
export const MODES_PAIEMENT = {
  virement: 'Virement', prelevement: 'Prélèvement', cheque: 'Chèque', especes: 'Espèces', autre: 'Autre',
} as const
export const NOMS_MODES = { ...MODES_PAIEMENT, depot: 'Retenue sur dépôt' } as const

export type ModePaiement = keyof typeof NOMS_MODES

/** A retention on the deposit (ADR 0021): changed from the stay only, never seen at the bank. */
export const estRetenue = (p: { mode: ModePaiement | null }) => p.mode === 'depot'

export type Paiement = {
  id: number
  sejour_id: number
  locataire: string
  lot: string
  date_paiement: string
  // Month of rent covered (1st day), null for a regularisation payment alone
  mois: string | null
  loyer: string
  provision: string
  regularisation_id: number | null
  // Toward a regularisation; negative: refund paid by the owner
  regularisation: string
  mode: ModePaiement | null
  note: string | null
  // Movement of the bank statement it was seen on (ADR 0018)
  mouvement_id?: number | null
}

export type PaiementSaisi = Omit<Paiement, 'id' | 'locataire' | 'lot'> & {
  // Amount received (bank statement): the API checks that rent + provision + regularisation add up to it
  montant?: string | null
}

// Rent and provision called each month from a_partir_du (1st of the month) until the next row of the stay (ADR 0009)
export type Echeance = {
  id: number
  sejour_id: number
  a_partir_du: string
  loyer: string
  provision: string
  note: string | null
}

export type EcheanceSaisie = Omit<Echeance, 'id'>

export type MoisSejour = {
  sejour_id: number
  locataire: string
  lot: string
  paiements: { id: number, loyer: string, provision: string, date_paiement: string, mode: ModePaiement | null }[] | null
  precedent: { loyer: string, provision: string, mode: ModePaiement | null } | null
}

export type SyntheseFiscale = {
  immeuble: number
  annee: number
  vacance: { energie: Energie, montant: string }[]
  total_vacance: string
  departs: {
    sejour_id: number
    locataire: string
    lot: string
    entree: string
    sortie: string
    // The entry, or the start of the management when later (ADR 0023)
    debut_calcul: string
    charges: string
    provisions: string
    versements: string
    non_rembourse: string
    deductible: string
    depot_retenu: string
    incomplet: string[]
  }[]
  total_non_rembourse: string
  total_depots_retenus: string
  total_deductible: string
  non_recuperables: { facture_id: number, fournisseur: string, numero: string, date_facture: string, libelle: string, montant: string }[]
  abandons_en_cours: { regularisation_id: number, locataire: string, lot: string, debut: string, fin: string, reste: string }[]
  travaux: TravauxFiscal[]
  total_travaux_deductibles: string
  travaux_non_payes: TravauxFiscal[]
}

// Works paid by the owner (ADR 0015): deductible according to their nature; paid by bank movements only (ADR 0019),
// one or several, each in the tax year of its movement
export type NatureTravaux = 'entretien' | 'amelioration' | 'construction'
export const NATURES_TRAVAUX: Record<NatureTravaux, string> = {
  entretien: 'Entretien, réparation',
  amelioration: 'Amélioration',
  construction: 'Construction, agrandissement',
}

export type Travaux = {
  id: number
  immeuble_id: number
  lot_id: number | null
  lot: string | null
  fournisseur: string
  description: string
  nature: NatureTravaux
  date_facture: string
  montant_ttc: string
  pdf: boolean
  note: string | null
  deductible: boolean
  reglements: ReglementTravaux[]
  paye: string
  reste: string
  // Date of the last payment, null when nothing is paid
  date_paiement: string | null
}

// One payment of a works invoice: the bank movement that paid it (its date: the tax year), for an amount
export type ReglementTravaux = { id: number, mouvement_id: number, date_paiement: string, libelle: string, montant: string }

// In the tax summary: one payment of the year (date_paiement, montant), or what remains unpaid (date_paiement null)
export type TravauxFiscal = Pick<Travaux, 'id' | 'fournisseur' | 'description' | 'nature' | 'lot' | 'date_facture' | 'montant_ttc'
  | 'deductible'> & { date_paiement: string | null, montant: string }

// The company, its partners, its general meetings (ADR 0016)
export type Societe = { denomination: string, forme: string, capital: string | null, siege: string | null, rcs: string | null }
export type Associe = { id: number, nom: string, parts: number, gerant: boolean, adresse: string | null, note: string | null }
export type TypeAssemblee = 'ordinaire' | 'extraordinaire'
export type PresenceAssocie = 'present' | 'represente' | 'absent'
export const PRESENCES: Record<PresenceAssocie, string> = { present: 'Présent', represente: 'Représenté', absent: 'Absent' }

export type Resolution = {
  ordre: number
  titre: string
  texte: string
  pour: number
  contre: number
  abstention: number
  adoptee: boolean
  unanimite: boolean
}

export type Assemblee = {
  id: number
  numero: number | null
  type: TypeAssemblee
  date: string
  heure: string | null
  lieu: string | null
  ordre_du_jour: string
  president: string | null
  observations: string | null
  statut: 'brouillon' | 'close'
  close_le: string | null
  pv_signe: boolean
  parts_total: number
  parts_presentes: number
  presences: { associe_id: number, nom: string, parts: number, gerant: boolean, presence: PresenceAssocie, represente_par: string | null }[]
  resolutions: Resolution[]
}

export type AssembleeResumee = Pick<Assemblee, 'id' | 'numero' | 'type' | 'date' | 'statut' | 'pv_signe'> & { nb_resolutions: number }

// The invoice only: its payments are bank movements linked to it (« Catégorisation », or the invoice)
export type TravauxSaisie = Pick<Travaux, 'immeuble_id' | 'lot_id' | 'fournisseur' | 'description' | 'nature'
  | 'date_facture' | 'montant_ttc' | 'note'>

// ---------------------------------------------------------------- bank statements (ADR 0018)

export type Releve = {
  id: number
  banque: string
  compte: string
  date_releve: string
  solde_precedent: string
  nouveau_solde: string
  pdf: boolean
  extracteur_id: number | null
  importe_le: string
}

// suite: the opening balance is the closing balance of the previous statement of the account (null: the first one)
export type ReleveResume = Releve & { nb_mouvements: number, suite: boolean | null }

// What a bank movement is (ADR 0018, 0019, 0022), fixed in the code: « locataire », « travaux », « depot_garantie »,
// « energie », « eau » and « impots » have a detail (the payments of a tenant, the payments of works invoices, the
// deposits paid or refunded, the invoices of charges paid, linked to it); the others only a note, required for
// « autre ». sens: the movements it applies to.
export type CategorieMouvement = 'locataire' | 'travaux' | 'depot_garantie' | 'agence' | 'emprunt' | 'assurance' | 'energie' | 'eau'
  | 'impots' | 'frais_bancaires' | 'copropriete' | 'honoraires' | 'associes' | 'virement_interne' | 'autre'
export const CATEGORIES_MOUVEMENT: Record<CategorieMouvement, { nom: string, sens: 'credit' | 'debit' | 'tous', icone: string }> = {
  locataire: { nom: 'Paiement de locataire', sens: 'tous', icone: 'oi oi-users' },
  travaux: { nom: 'Travaux', sens: 'debit', icone: 'oi oi-hammer' },
  depot_garantie: { nom: 'Dépôt de garantie', sens: 'tous', icone: 'oi oi-key' },
  agence: { nom: 'Versement d\'une agence (gérance)', sens: 'tous', icone: 'oi oi-shop' },
  emprunt: { nom: 'Emprunt', sens: 'tous', icone: 'oi oi-building-columns' },
  assurance: { nom: 'Assurance', sens: 'tous', icone: 'oi oi-shield' },
  // « tous »: a credit may refund an invoice (ADR 0022)
  energie: { nom: 'Énergie (gaz, électricité)', sens: 'tous', icone: 'oi oi-bolt' },
  eau: { nom: 'Eau', sens: 'tous', icone: 'oi oi-filter' },
  impots: { nom: 'Impôts et taxes', sens: 'tous', icone: 'oi oi-percentage' },
  frais_bancaires: { nom: 'Frais bancaires', sens: 'tous', icone: 'oi oi-credit-card' },
  copropriete: { nom: 'Copropriété', sens: 'tous', icone: 'oi oi-building' },
  honoraires: { nom: 'Honoraires (comptable, agence)', sens: 'tous', icone: 'oi oi-briefcase' },
  associes: { nom: 'Associés (apports, versements)', sens: 'tous', icone: 'oi oi-user' },
  virement_interne: { nom: 'Virement entre comptes de la société', sens: 'tous', icone: 'oi oi-arrow-right-arrow-left' },
  autre: { nom: 'Autre', sens: 'tous', icone: 'oi oi-tag' },
}
// Debits that pay invoices of charges (ADR 0022): their detail is the invoices paid
export const AVEC_FACTURE: CategorieMouvement[] = ['energie', 'eau', 'impots']
export const AVEC_DETAIL: CategorieMouvement[] = ['locataire', 'travaux', 'depot_garantie', ...AVEC_FACTURE]

// a_categoriser: no category yet; incomplet: a category with a detail that does not cover the amount (a note does
// not make up for it); categorise
export type StatutMouvement = 'a_categoriser' | 'incomplet' | 'categorise'

export type Mouvement = {
  id: number
  releve_id: number
  ordre: number
  date_operation: string
  date_valeur: string | null
  libelle: string
  detail: string | null
  // Credit positive, debit negative
  montant: string
  categorie: CategorieMouvement | null
  // Required for « autre »; otherwise a comment (it never completes a detail)
  note: string | null
  compte: string
  date_releve: string
  paiements: { id: number, locataire: string, lot: string, mois: string | null, total: string }[]
  // Payments of works invoices: total is this payment; montant_ttc and reste, those of the invoice
  travaux: { id: number, reglement_id: number, description: string, fournisseur: string, total: string, montant_ttc: string, reste: string }[]
  // Payments of invoices of charges (ADR 0022), the same way
  factures: { id: number, reglement_id: number, fournisseur: string, numero: string, energie: Energie, date_facture: string,
    total: string, montant_ttc: string, reste: string }[]
  depots: { id: number, sejour_id: number, locataire: string, lot: string, date: string, montant: string }[]
  couvert: string
  statut: StatutMouvement
  // Recorded by hand, of the same amount and within ten days: to link
  possibles: ({ type: 'paiement', id: number, locataire: string, lot: string, mois: string | null, date: string }
    // An invoice whose unpaid rest is the amount; date: that of the invoice
    | { type: 'travaux', id: number, description: string, fournisseur: string, date: string | null }
    // An invoice of charges whose rest is the amount, or whose number is in the label (ADR 0022)
    | { type: 'facture', id: number, fournisseur: string, numero: string, energie: Energie, date: string | null, statut?: Statut }
    // Several payments of one tenant whose sum is the amount (a transfer of several months); mois: « 10/2025, 11/2025 »
    | { type: 'groupe', ids: number[], locataire: string, lot: string, mois: string })[]
}

export type ReleveDetail = Releve & { mouvements: Mouvement[] }

// A statement read in the browser, as sent on import
export type ReleveLu = {
  extracteur_id: number
  compte: string
  date_releve: string
  solde_precedent: string
  nouveau_solde: string
  totaux: { debit: string | null, credit: string | null } | null
  mouvements: { date_operation: string, date_valeur: string | null, libelle: string, detail: string | null, montant: string }[]
}

export type ReleveAvecPdf = { id: number, compte: string, date_releve: string, solde_precedent: string, nouveau_solde: string, extracteur_id: number | null }

export type DetailFiltre = { sejour?: number | 'proprietaire', energie?: Energie, groupe?: 'consommation' | 'autres' }

const exerciceQuery = ({ immeuble, debut, fin }: Exercice) => `immeuble=${immeuble}&debut=${debut}&fin=${fin}`

export type Ligne = {
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

// An invoice extractor as stored (ADR 0013): never changed, a correction is the next version of its supplier
export type ExtracteurEnregistre = {
  id: number
  fournisseur: string
  version: number
  // ADR 0018: an extractor reads invoices or bank statements (no energy then)
  type: 'facture' | 'releve'
  energie: Energie | null
  reglages: Reglages
  source: string
  code: string
  moteur: number
  note: string | null
  cree_le: string
  derniere: boolean
  nb_factures: number
  nb_releves: number
}

export type NouvelleVersion = Pick<ExtracteurEnregistre, 'fournisseur' | 'energie' | 'reglages' | 'source' | 'code' | 'moteur' | 'note'>
  & { type?: 'facture' | 'releve' }

// An invoice of a supplier with its PDF, every building: read again by a new version (non-regression)
export type FactureAvecPdf = {
  id: number
  numero: string
  date_facture: string
  montant_ttc: string | null
  statut: Statut
  extracteur_id: number | null
  immeuble: string
  annexe: EtatAnnexe
}

// A supplier (ADR 0014): its invoices, the last version of its extractor; « confidentiel »: never joined in annex
export type Fournisseur = {
  id: number
  nom: string
  confidentiel: boolean
  energies: Energie[] | null
  nb_factures: number
  nb_pdf: number
  // A bank (ADR 0018): its statements
  nb_releves: number
  extracteur: { id: number, version: number, type: 'facture' | 'releve' } | null
}

// What the browser read from a PDF, sent with it on import
export type Brouillon = {
  extracteur_id: number
  numero: string
  date_facture: string
  montant_ttc: string | null
  lignes: Ligne[]
}

export type Facture = {
  id: number
  immeuble_id: number
  fournisseur: string
  energie: Energie
  numero: string
  date_facture: string
  // Empty on a draft whose total is not on the PDF (ADR 0013)
  montant_ttc: string | null
  statut: Statut
  note: string | null
  pdf: boolean
  // ADR 0017: replaced by which invoice, when, why; on the draft of a correction, the invoice it will replace
  remplacee_par: number | null
  remplacee_le: string | null
  motif_remplacement: string | null
  remplace_id: number | null
  // ADR 0022: paid by bank movements, what remains, the date of the last payment
  paye: string
  reste: string
  date_paiement: string | null
  fournisseur_id: number
  // Version of the extractor that read it (null: typed by hand)
  extracteur_id: number | null
  // ADR 0024: what becomes of it in the annexes of a supporting document
  annexe: EtatAnnexe
}

/**
 * The invoice in the annexes (ADR 0024): never joined (confidential supplier), no PDF, its version in images to make
 * (none, or made from another PDF), to verify by eye, or verified.
 */
export type EtatAnnexe = 'confidentiel' | 'sans_pdf' | 'a_faire' | 'a_verifier' | 'verifiee'

/** The current version in images of an invoice. */
export type AnnexeFacture = {
  id: number
  extracteur_id: number | null
  termes: string[]
  reglages: { dpi: number, seuil: number }
  // Number of zones painted
  zones: number
  cree_le: string
  verifiee_le: string | null
}

/** A version in images made in the browser, sent with its PDF. */
export type AnnexeEnvoyee = {
  zones: { page: number, x0: number, y0: number, x1: number, y1: number, origine: string }[]
  extracteur_id: number | null
  termes: string[]
  reglages: { dpi: number, seuil: number }
}

export type ReglementFacture = { id: number, mouvement_id: number, date_paiement: string, libelle: string, montant: string }
// A debit that may pay an invoice: what remains of it; correspond, the rest of the invoice
export type MouvementPourFacture = {
  id: number, date_operation: string, libelle: string, montant: string, categorie: CategorieMouvement | null, reste: string, correspond: boolean
}

export type ReferenceFacture = { id: number, fournisseur: string, numero: string, statut: Statut }
export type LiensFacture = {
  remplacante: ReferenceFacture | null
  remplacees: ReferenceFacture[]
  corrige: ReferenceFacture | null
  correction: ReferenceFacture | null
}
// Sent regularisations whose period touches a replaced invoice: to check (« à rectifier »)
export type RegularisationTouchee = { id: number, locataire: string, lot: string, debut: string, fin: string, solde: string }

export type FactureResumee = Facture & {
  total_ok: boolean | null
  debut: string | null
  fin: string | null
  nb_lignes: number
}

export type Constat = {
  severite: 'erreur' | 'avertissement'
  code: string
  message: string
  ligne: number | null
  saisie: boolean
}

export type Controle = {
  total_lignes: string
  ecart: string
  ok: boolean
  constats: Constat[]
  enregistrable: boolean
  validable: boolean
}

export type FactureDetail = {
  facture: Facture, lignes: Ligne[], liens: LiensFacture, reglements: ReglementFacture[], controle: Controle,
  annexe: AnnexeFacture | null
}
export type FactureRemplacee = FactureDetail & { regularisations: RegularisationTouchee[] }

export type FactureEnTete = Pick<Facture, 'numero' | 'date_facture' | 'montant_ttc' | 'energie' | 'note'>

export type FactureSaisie = FactureEnTete & {
  // Lines as typed in the grid: the server reports what cannot be stored
  lignes: Ligne[]
}

// ---------------------------------------------------------------- authentication (ADR 0020)

export type Utilisateur = { id: number, email: string, nom: string }
export type Passkey = { id: string, appareil: string, cree_le: string, utilisee_le: string | null }
export type JetonApi = { id: number, nom: string, cree_le: string, utilise_le: string | null, revoque_le: string | null }

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
  session: () => request<{ utilisateur: Utilisateur }>('GET', '/auth/session'),
  connexionOptions: () => request<{ id: string, options: PublicKeyCredentialRequestOptionsJSON }>('POST', '/auth/connexion/options'),
  connexion: (id: string, reponse: unknown) => request<{ ok: true }>('POST', '/auth/connexion', { id, reponse }),
  deconnexion: () => request<void>('POST', '/auth/deconnexion'),
  // From a link (jeton), or for the account connected (this device)
  enregistrementOptions: (jeton: string | null) => request<{ id: string, options: PublicKeyCredentialCreationOptionsJSON, utilisateur: Utilisateur }>(
    'POST', '/auth/enregistrement/options', { jeton }),
  enregistrement: (id: string, reponse: unknown, appareil: string) => request<{ ok: true }>('POST', '/auth/enregistrement', { id, reponse, appareil }),
  passkeys: () => request<Passkey[]>('GET', '/auth/passkeys'),
  supprimerPasskey: (id: string) => request<void>('DELETE', `/auth/passkeys/${encodeURIComponent(id)}`),
  lienAppareil: () => request<{ url: string, expire_le: string }>('POST', '/auth/liens'),
  jetons: () => request<JetonApi[]>('GET', '/auth/jetons'),
  creerJeton: (nom: string) => request<{ id: number, jeton: string }>('POST', '/auth/jetons', { nom }),
  revoquerJeton: (id: number) => request<void>('DELETE', `/auth/jetons/${id}`),

  immeubles: () => request<Immeuble[]>('GET', '/immeubles'),
  immeuble: (id: number) => request<ImmeubleDetail>('GET', `/immeubles/${id}`),
  creerImmeuble: (data: Pick<Immeuble, 'code' | 'nom' | 'adresse'>) => request<Immeuble>('POST', '/immeubles', data),
  modifierImmeuble: (id: number, data: Pick<Immeuble, 'nom' | 'adresse' | 'debut_gestion'>) =>
    request<Immeuble>('PUT', `/immeubles/${id}`, data),
  creerLot: (immeuble: number, lot: Omit<Lot, 'id' | 'immeuble_id'>) =>
    request<Lot>('POST', `/immeubles/${immeuble}/lots`, lot),
  modifierLot: (lot: Lot) => request<Lot>('PUT', `/lots/${lot.id}`, lot),
  supprimerLot: (id: number) => request<void>('DELETE', `/lots/${id}`),

  locataires: () => request<Locataire[]>('GET', '/locataires'),
  creerLocataire: (l: Omit<Locataire, 'id' | 'nb_sejours'>) => request<Locataire>('POST', '/locataires', l),
  modifierLocataire: (l: Omit<Locataire, 'nb_sejours'>) => request<Locataire>('PUT', `/locataires/${l.id}`, l),
  supprimerLocataire: (id: number) => request<void>('DELETE', `/locataires/${id}`),

  sejours: (immeuble: number) => request<Sejour[]>('GET', `/sejours?immeuble=${immeuble}`),
  creerSejour: (s: Omit<Sejour, 'id' | 'lot' | 'locataire' | 'depot_detenu' | 'depot_retenu'>) => request<Sejour>('POST', '/sejours', s),
  modifierSejour: (s: Omit<Sejour, 'lot' | 'locataire' | 'depot_detenu' | 'depot_retenu'>) => request<Sejour>('PUT', `/sejours/${s.id}`, s),
  supprimerSejour: (id: number) => request<void>('DELETE', `/sejours/${id}`),

  echeances: (immeuble: number) => request<Echeance[]>('GET', `/echeances?immeuble=${immeuble}`),
  creerEcheance: (e: EcheanceSaisie) => request<Echeance>('POST', '/echeances', e),
  modifierEcheance: (id: number, e: EcheanceSaisie) => request<Echeance>('PUT', `/echeances/${id}`, e),
  supprimerEcheance: (id: number) => request<void>('DELETE', `/echeances/${id}`),

  provisions: (immeuble: number) => request<Provision[]>('GET', `/provisions?immeuble=${immeuble}`),
  enregistrerProvision: (p: Pick<Provision, 'sejour_id' | 'annee' | 'montant' | 'note'>) =>
    request<Provision>('PUT', '/provisions', p),
  supprimerProvision: (id: number) => request<void>('DELETE', `/provisions/${id}`),

  decompte: (e: Exercice) => request<Decompte>('GET', `/decompte?${exerciceQuery(e)}`),
  detail: (e: Exercice, f: DetailFiltre) => {
    const filtres = Object.entries(f).filter(([, v]) => v !== undefined).map(([k, v]) => `&${k}=${v}`).join('')
    return request<LigneDetail[]>('GET', `/decompte/detail?${exerciceQuery(e)}${filtres}`)
  },
  couverture: (e: Exercice) => request<Couverture>('GET', `/couverture?${exerciceQuery(e)}`),
  exportUrl: (e: Exercice) => `/api/decompte/export?${exerciceQuery(e)}`,

  regularisations: (immeuble: number) => request<Regularisation[]>('GET', `/regularisations?immeuble=${immeuble}`),
  regularisation: (id: number) => request<RegularisationDetail>('GET', `/regularisations/${id}`),
  creerRegularisation: (sejour_id: number, debut: string, fin: string) =>
    request<Regularisation>('POST', '/regularisations', { sejour_id, debut, fin }),
  saisirRegularisation: (r: { sejour_id: number, debut: string, fin: string, solde: string, provisions: string | null,
    date_envoi: string, montant_recu: string | null, note: string | null }) =>
    request<Regularisation>('POST', '/regularisations/manuelle', r),
  rectificatif: (id: number) => request<Regularisation>('POST', `/regularisations/${id}/rectificatif`),
  marquerEnvoyee: (id: number, date_envoi: string) =>
    request<Regularisation>('POST', `/regularisations/${id}/envoi`, { date_envoi }),
  // « Marquer envoyée » done by mistake: back to a draft (refused once a payment, a decision or a corrective depends on it)
  annulerEnvoi: (id: number) => request<Regularisation>('DELETE', `/regularisations/${id}/envoi`),
  supprimerRegularisation: (id: number) => request<void>('DELETE', `/regularisations/${id}`),
  mail: (id: number, options: OptionsMail) => request<Mail>('POST', `/regularisations/${id}/mail`, options),
  decisionRegularisation: (id: number, decision: Regularisation['decision']) =>
    request<Regularisation>('POST', `/regularisations/${id}/decision`, { decision }),

  // annee null: every year
  paiements: (immeuble: number, annee: number | null) =>
    request<Paiement[]>('GET', `/paiements?immeuble=${immeuble}${annee === null ? '' : `&annee=${annee}`}`),
  // Payments toward a regularisation, any year, previous regularisations of its corrective chain included
  paiementsRegularisation: (immeuble: number, regularisation: number) =>
    request<Paiement[]>('GET', `/paiements?immeuble=${immeuble}&regularisation=${regularisation}`),
  paiementsDuMois: (immeuble: number, mois: string) =>
    request<MoisSejour[]>('GET', `/paiements/mois?immeuble=${immeuble}&mois=${mois}`),
  creerPaiement: (p: PaiementSaisi) => request<Paiement>('POST', '/paiements', p),
  modifierPaiement: (id: number, p: PaiementSaisi) => request<Paiement>('PUT', `/paiements/${id}`, p),
  supprimerPaiement: (id: number) => request<void>('DELETE', `/paiements/${id}`),

  travaux: (immeuble: number) => request<Travaux[]>('GET', `/travaux?immeuble=${immeuble}`),
  creerTravaux: (t: TravauxSaisie) => request<Travaux>('POST', '/travaux', t),
  modifierTravaux: (id: number, t: TravauxSaisie) => request<Travaux>('PUT', `/travaux/${id}`, t),
  supprimerTravaux: (id: number) => request<void>('DELETE', `/travaux/${id}`),
  travauxPdfUrl: (id: number) => `/api/travaux/${id}/pdf`,
  async joindrePdfTravaux(id: number, file: File) {
    const form = new FormData()
    form.append('file', file)
    return answer<Travaux>(await fetch(`/api/travaux/${id}/pdf`, { method: 'POST', body: form }))
  },

  societe: () => request<{ societe: Societe | null, associes: Associe[] }>('GET', '/societe'),
  modifierSociete: (s: Societe) => request<{ societe: Societe | null, associes: Associe[] }>('PUT', '/societe', s),
  creerAssocie: (a: Omit<Associe, 'id'>) => request<Associe>('POST', '/associes', a),
  modifierAssocie: (a: Associe) => request<Associe>('PUT', `/associes/${a.id}`, a),
  supprimerAssocie: (id: number) => request<void>('DELETE', `/associes/${id}`),
  assemblees: () => request<AssembleeResumee[]>('GET', '/assemblees'),
  assemblee: (id: number) => request<Assemblee>('GET', `/assemblees/${id}`),
  creerAssemblee: (a: { type: TypeAssemblee, date: string, lieu: string | null, modele: 'annuelle' | 'vide' }) =>
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

  releves: () => request<ReleveResume[]>('GET', '/releves'),
  releve: (id: number) => request<ReleveDetail>('GET', `/releves/${id}`),
  supprimerReleve: (id: number) => request<void>('DELETE', `/releves/${id}`),
  relevePdfUrl: (id: number) => `/api/releves/${id}/pdf`,
  async importerReleve(fichier: File, releve: ReleveLu) {
    const form = new FormData()
    form.append('releve', JSON.stringify(releve))
    form.append('file', fichier)
    return answer<ReleveDetail>(await fetch('/api/releves/import', { method: 'POST', body: form }))
  },
  relevesDeLaBanque: (fournisseur: string) =>
    request<ReleveAvecPdf[]>('GET', `/extracteurs/releves?fournisseur=${encodeURIComponent(fournisseur)}`),
  mouvements: (statut: 'tous' | StatutMouvement, du?: string, au?: string) =>
    request<Mouvement[]>('GET', `/mouvements?statut=${statut}${du ? `&du=${du}` : ''}${au ? `&au=${au}` : ''}`),
  categoriserMouvement: (id: number, categorie: CategorieMouvement, note: string | null = null) =>
    request<Mouvement>('PUT', `/mouvements/${id}/categorie`, { categorie, note }),
  retirerCategorie: (id: number) => request<Mouvement>('DELETE', `/mouvements/${id}/categorie`),
  lierMouvement: (id: number, lien: { paiement_id: number } | { travaux_id: number } | { facture_id: number } | { paiement_ids: number[] }
    | { depot_id: number }) => request<Mouvement>('POST', `/mouvements/${id}/lier`, lien),
  delierMouvement: (id: number, lien: { paiement_id: number } | { reglement_id: number } | { reglement_facture_id: number } | { depot_id: number }) =>
    request<Mouvement>('POST', `/mouvements/${id}/delier`, lien),

  depots: (immeuble: number) => request<VersementDepot[]>('GET', `/depots?immeuble=${immeuble}`),
  creerDepot: (d: VersementDepotSaisi) => request<VersementDepot>('POST', '/depots', d),
  modifierDepot: (id: number, d: VersementDepotSaisi) => request<VersementDepot>('PUT', `/depots/${id}`, d),
  supprimerDepot: (id: number) => request<void>('DELETE', `/depots/${id}`),
  // The retention of a stay, replaced as a whole (no line: removed)
  retenue: (sejour: number, r: { date: string, lignes: LigneRetenue[] }) =>
    request<unknown[]>('PUT', `/sejours/${sejour}/retenue`, r),

  fiscal: (immeuble: number, annee: number) => request<SyntheseFiscale>('GET', `/fiscal?immeuble=${immeuble}&annee=${annee}`),

  justificatifUrl: (id: number) => `/api/regularisations/${id}/justificatif`,
  apercuUrl: (e: Exercice, sejour: number) => `/api/justificatif?${exerciceQuery(e)}&sejour=${sejour}`,

  factures: (immeuble: number) => request<FactureResumee[]>('GET', `/factures?immeuble=${immeuble}`),
  facture: (id: number) => request<FactureDetail>('GET', `/factures/${id}`),
  enregistrer: (id: number, saisie: FactureSaisie) => request<FactureDetail>('PUT', `/factures/${id}`, saisie),
  valider: (id: number) => request<FactureRemplacee>('POST', `/factures/${id}/valider`),
  remplacer: (id: number, par: number, motif: string) =>
    request<FactureRemplacee>('POST', `/factures/${id}/remplacer`, { par, motif }),
  corriger: (id: number) => request<FactureDetail>('POST', `/factures/${id}/corriger`),
  // Payments by bank movements (ADR 0022)
  mouvementsPourFacture: (id: number) => request<MouvementPourFacture[]>('GET', `/factures/${id}/mouvements`),
  reglerFacture: (id: number, mouvement: number) => request<FactureDetail>('POST', `/factures/${id}/reglements`, { mouvement_id: mouvement }),
  supprimerReglementFacture: (id: number, reglement: number) => request<FactureDetail>('DELETE', `/factures/${id}/reglements/${reglement}`),
  supprimer: (id: number) => request<void>('DELETE', `/factures/${id}`),
  controler: (saisie: Pick<FactureSaisie, 'montant_ttc' | 'lignes'>) => request<Controle>('POST', '/controle', saisie),
  pdfUrl: (id: number) => `/api/factures/${id}/pdf`,

  // Version in images joined to the supporting documents (ADR 0024)
  annexePdfUrl: (id: number, version: number) => `/api/factures/${id}/annexe/pdf?v=${version}`,
  async envoyerAnnexe(id: number, pdf: Uint8Array, annexe: AnnexeEnvoyee) {
    const form = new FormData()
    form.append('annexe', JSON.stringify(annexe))
    form.append('file', new Blob([pdf as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }), 'annexe.pdf')
    return answer<FactureDetail>(await fetch(`/api/factures/${id}/annexe`, { method: 'POST', body: form }))
  },
  verifierAnnexe: (id: number, annexe: number) =>
    request<FactureDetail>('POST', `/factures/${id}/annexe/verifiee`, { annexe_id: annexe }),
  termesMasques: () => request<string[]>('GET', '/termes-masques'),
  modifierTermesMasques: (termes: string[]) => request<string[]>('PUT', '/termes-masques', { termes }),

  async joindrePdf(id: number, file: File) {
    const form = new FormData()
    form.append('file', file)
    return answer<FactureDetail>(await fetch(`/api/factures/${id}/pdf`, { method: 'POST', body: form }))
  },

  // Invoice typed by hand, with the PDF when there is one (not read by the parsers): draft without lines
  async creerFacture(immeuble: number, entete: FactureEnTete & { fournisseur: string }, file: File | null) {
    const form = new FormData()
    for (const [name, value] of Object.entries(entete)) {
      form.append(name, value ?? '')
    }
    if (file) {
      form.append('file', file)
    }
    return answer<FactureDetail>(await fetch(`/api/factures?immeuble=${immeuble}`, { method: 'POST', body: form }))
  },

  // The PDF and the draft read from it in the browser (ADR 0013)
  async importer(immeuble: number, file: File, brouillon: Brouillon) {
    const form = new FormData()
    form.append('brouillon', JSON.stringify(brouillon))
    form.append('file', file)
    const response = await fetch(`/api/factures/import?immeuble=${immeuble}`, { method: 'POST', body: form })
    return answer<FactureDetail>(response)
  },

  sante: () => request<{ status: string, version: string }>('GET', '/health'),
  fournisseurs: () => request<Fournisseur[]>('GET', '/fournisseurs'),
  fournisseur: (id: number) => request<Fournisseur>('GET', `/fournisseurs/${id}`),
  modifierFournisseur: (id: number, modif: { confidentiel: boolean }) => request<Fournisseur>('PATCH', `/fournisseurs/${id}`, modif),
  extracteurs: () => request<ExtracteurEnregistre[]>('GET', '/extracteurs'),
  extracteur: (id: number) => request<ExtracteurEnregistre>('GET', `/extracteurs/${id}`),
  nouvelleVersion: (version: NouvelleVersion) => request<ExtracteurEnregistre>('POST', '/extracteurs', version),
  facturesDuFournisseur: (fournisseur: string) =>
    request<FactureAvecPdf[]>('GET', `/extracteurs/factures?fournisseur=${encodeURIComponent(fournisseur)}`),
}

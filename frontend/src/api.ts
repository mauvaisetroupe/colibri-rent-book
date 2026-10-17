// Client of the Colibri API (same origin: /api, relayed by Vite in development and Nginx in production).
// Types mirror backend/src/invoices/types.ts and checks.ts: amounts are decimal strings, dates ISO with
// inclusive bounds.

import type { Affectation, Categorie, Energie } from './extraction/contrat'

export type { Affectation, Categorie, Energie }
export type Statut = 'a_verifier' | 'validee'

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
  depot_garantie: string | null
  // Part of the deposit kept at exit for unpaid charges (SPEC § 9)
  depot_retenu_charges: string | null
}

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
}

export type OptionsMail = {
  etalement: number
  provision_mensuelle: string | null
  provision_a_partir_du: string | null
  signature: string
}

export type Mail = { destinataire: string | null, objet: string, corps: string }

export const MODES_PAIEMENT = {
  virement: 'Virement', prelevement: 'Prélèvement', cheque: 'Chèque', especes: 'Espèces', autre: 'Autre',
} as const

export type ModePaiement = keyof typeof MODES_PAIEMENT

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
}

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
  energie: Energie
  reglages: { toleranceHauteur: number, collage: number, colonne: number }
  source: string
  code: string
  moteur: number
  note: string | null
  cree_le: string
  derniere: boolean
  nb_factures: number
}

export type NouvelleVersion = Pick<ExtracteurEnregistre, 'fournisseur' | 'energie' | 'reglages' | 'source' | 'code' | 'moteur' | 'note'>

// An invoice of a supplier with its PDF, every building: read again by a new version (non-regression)
export type FactureAvecPdf = {
  id: number
  numero: string
  date_facture: string
  montant_ttc: string | null
  statut: Statut
  extracteur_id: number | null
  immeuble: string
}

// A supplier (ADR 0014): its invoices, the last version of its extractor; « confidentiel »: never joined in annex
export type Fournisseur = {
  id: number
  nom: string
  confidentiel: boolean
  energies: Energie[] | null
  nb_factures: number
  nb_pdf: number
  extracteur: { id: number, version: number } | null
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
}

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

export type FactureDetail = { facture: Facture, lignes: Ligne[], controle: Controle }

export type FactureEnTete = Pick<Facture, 'numero' | 'date_facture' | 'montant_ttc' | 'energie' | 'note'>

export type FactureSaisie = FactureEnTete & {
  // Lines as typed in the grid: the server reports what cannot be stored
  lignes: Ligne[]
}

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

async function answer<T>(response: Response): Promise<T> {
  if (response.status === 204) {
    return undefined as T
  }
  const json = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new ApiError(json.message ?? `Erreur ${response.status}`, response.status, json)
  }
  return json as T
}

export const api = {
  immeubles: () => request<Immeuble[]>('GET', '/immeubles'),
  immeuble: (id: number) => request<ImmeubleDetail>('GET', `/immeubles/${id}`),
  creerImmeuble: (data: Pick<Immeuble, 'code' | 'nom' | 'adresse'>) => request<Immeuble>('POST', '/immeubles', data),
  modifierImmeuble: (id: number, data: Pick<Immeuble, 'nom' | 'adresse'>) =>
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
  creerSejour: (s: Omit<Sejour, 'id' | 'lot' | 'locataire'>) => request<Sejour>('POST', '/sejours', s),
  modifierSejour: (s: Omit<Sejour, 'lot' | 'locataire'>) => request<Sejour>('PUT', `/sejours/${s.id}`, s),
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

  paiements: (immeuble: number, annee: number) => request<Paiement[]>('GET', `/paiements?immeuble=${immeuble}&annee=${annee}`),
  // Payments toward a regularisation, any year, previous regularisations of its corrective chain included
  paiementsRegularisation: (immeuble: number, regularisation: number) =>
    request<Paiement[]>('GET', `/paiements?immeuble=${immeuble}&regularisation=${regularisation}`),
  paiementsDuMois: (immeuble: number, mois: string) =>
    request<MoisSejour[]>('GET', `/paiements/mois?immeuble=${immeuble}&mois=${mois}`),
  creerPaiement: (p: PaiementSaisi) => request<Paiement>('POST', '/paiements', p),
  modifierPaiement: (id: number, p: PaiementSaisi) => request<Paiement>('PUT', `/paiements/${id}`, p),
  supprimerPaiement: (id: number) => request<void>('DELETE', `/paiements/${id}`),

  fiscal: (immeuble: number, annee: number) => request<SyntheseFiscale>('GET', `/fiscal?immeuble=${immeuble}&annee=${annee}`),

  justificatifUrl: (id: number) => `/api/regularisations/${id}/justificatif`,
  apercuUrl: (e: Exercice, sejour: number) => `/api/justificatif?${exerciceQuery(e)}&sejour=${sejour}`,

  factures: (immeuble: number) => request<FactureResumee[]>('GET', `/factures?immeuble=${immeuble}`),
  facture: (id: number) => request<FactureDetail>('GET', `/factures/${id}`),
  enregistrer: (id: number, saisie: FactureSaisie) => request<FactureDetail>('PUT', `/factures/${id}`, saisie),
  valider: (id: number) => request<FactureDetail>('POST', `/factures/${id}/valider`),
  supprimer: (id: number) => request<void>('DELETE', `/factures/${id}`),
  controler: (saisie: Pick<FactureSaisie, 'montant_ttc' | 'lignes'>) => request<Controle>('POST', '/controle', saisie),
  pdfUrl: (id: number) => `/api/factures/${id}/pdf`,

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

  fournisseurs: () => request<Fournisseur[]>('GET', '/fournisseurs'),
  fournisseur: (id: number) => request<Fournisseur>('GET', `/fournisseurs/${id}`),
  modifierFournisseur: (id: number, modif: { confidentiel: boolean }) => request<Fournisseur>('PATCH', `/fournisseurs/${id}`, modif),
  extracteurs: () => request<ExtracteurEnregistre[]>('GET', '/extracteurs'),
  extracteur: (id: number) => request<ExtracteurEnregistre>('GET', `/extracteurs/${id}`),
  nouvelleVersion: (version: NouvelleVersion) => request<ExtracteurEnregistre>('POST', '/extracteurs', version),
  facturesDuFournisseur: (fournisseur: string) =>
    request<FactureAvecPdf[]>('GET', `/extracteurs/factures?fournisseur=${encodeURIComponent(fournisseur)}`),
}

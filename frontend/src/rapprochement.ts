import Big from 'big.js'

import type { CategorieMouvement, Echeance, Mouvement, Paiement, Regularisation, Sejour } from './api'
import { attendu } from './echeances'

// What a bank movement probably is (ADR 0018), for the « Banque » screen: proposals only, the user accepts or changes
// them. Its category: the payment of a tenant whose name is in the label or the detail, else a category read in the
// label (loan, insurance, energy…). A tenant payment: for the month written in it (« LOYER 02/25 ») or else the month
// of the operation, split into rent and provision as called (ADR 0009) minus what is already paid for that month, or
// toward a regularisation still to be paid.

/** Upper case, without accents: « Hélène » and « HELENE » are the same. */
export const normaliser = (texte: string) => texte.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase()

const MOTS_VIDES = new Set(['EX', 'MME', 'MLE', 'MR', 'M', 'MLLE', 'MADAME', 'MONSIEUR', 'ET', 'DE', 'DU', 'LE', 'LA'])

/** The words of a name worth looking for: « Alice MARTIN (ex DURAND) » → ALICE, MARTIN, DURAND. */
export function motsDuNom(nom: string) {
  return normaliser(nom).split(/[^A-Z]+/).filter((m) => m.length >= 3 && !MOTS_VIDES.has(m))
}

/** First day of the month of an ISO date, as 'AAAA-MM'. */
const moisDe = (date: string) => date.slice(0, 7)

/** The stay whose tenant is named in the movement and present around its date (a month before, three after). */
export function sejourDuMouvement(m: Pick<Mouvement, 'libelle' | 'detail' | 'date_operation'>, sejours: Sejour[]): Sejour | null {
  const texte = ` ${normaliser(`${m.libelle} ${m.detail ?? ''}`).replace(/[^A-Z]+/g, ' ')} `
  const date = new Date(m.date_operation)
  const proche = (s: Sejour) => {
    const avant = new Date(s.entree)
    avant.setMonth(avant.getMonth() - 1)
    const apres = s.sortie ? new Date(s.sortie) : null
    apres?.setMonth(apres.getMonth() + 3)
    return avant <= date && (!apres || date <= apres)
  }
  let meilleur: { sejour: Sejour, score: number } | null = null
  for (const s of sejours.filter(proche)) {
    // A word of the name, or its beginning when the bank cut the label (« LOYER ET RAPPEL DE CHARGES ZIEG »)
    const tronques = texte.trim().split(' ').filter((t) => t.length >= 4)
    const score = motsDuNom(s.locataire)
      .filter((mot) => texte.includes(` ${mot} `) || tronques.some((t) => mot.startsWith(t))).length
    if (score > 0 && (!meilleur || score > meilleur.score)) {
      meilleur = { sejour: s, score }
    }
  }
  return meilleur?.sejour ?? null
}

/** The month paid: written in the movement (« LOYER 02/25 », « LOYER 02/2025 »), else the month of the operation. */
export function moisDuMouvement(m: Pick<Mouvement, 'libelle' | 'detail' | 'date_operation'>): string {
  const ecrit = `${m.libelle} ${m.detail ?? ''}`.match(/LOYER\D{0,12}(\d{1,2})[/.-](\d{2}(?:\d{2})?)\b/i)
  if (ecrit) {
    const mois = Number(ecrit[1])
    const annee = ecrit[2]!.length === 2 ? `20${ecrit[2]}` : ecrit[2]!
    if (mois >= 1 && mois <= 12) {
      return `${annee}-${String(mois).padStart(2, '0')}`
    }
  }
  return moisDe(m.date_operation)
}

export type Proposition = {
  sejour: Sejour | null
  mois: string
  loyer: string
  provision: string
  regularisation_id: number | null
  regularisation: string
  // Why the split is not the amount called: shown, not blocking
  ecart: string | null
}

/**
 * A credit split as a payment: the amount called for the month when it matches; the rest of a sent regularisation
 * when it matches that; else rent = amount − provision called (the difference shown).
 */
export function proposer(
  m: Mouvement, sejours: Sejour[], echeances: Echeance[], regularisations: Regularisation[], paiements: Paiement[] = [],
): Proposition {
  const sejour = sejourDuMouvement(m, sejours)
  const mois = moisDuMouvement(m)
  const montant = new Big(m.montant).abs().minus(m.couvert)
  const vide: Proposition = { sejour, mois, loyer: montant.toString(), provision: '0', regularisation_id: null, regularisation: '0', ecart: null }
  if (!sejour) {
    return { ...vide, ecart: 'locataire non reconnu dans le libellé' }
  }
  const regul = regularisations.find((r) => r.sejour_id === sejour.id && r.etat === 'en_attente'
    && new Big(r.solde).minus(r.montant_recu).eq(montant))
  if (regul) {
    return { ...vide, loyer: '0', regularisation_id: regul.id, regularisation: montant.toString() }
  }
  const appel = attendu(echeances, sejour, mois)
  if (!appel) {
    return { ...vide, ecart: `pas de loyer appelé connu pour ${mois}` }
  }
  // What is still due for the month: called, minus the payments of the month already recorded
  const duMois = paiements.filter((p) => p.sejour_id === sejour.id && p.mois?.slice(0, 7) === mois)
  const dejaLoyer = duMois.reduce((t, p) => t.plus(p.loyer), new Big(0))
  const dejaProvision = duMois.reduce((t, p) => t.plus(p.provision), new Big(0))
  const positif = (x: Big) => (x.lt(0) ? new Big(0) : x)
  const loyerDu = positif(new Big(appel.loyer).minus(dejaLoyer))
  const provisionDue = positif(new Big(appel.provision).minus(dejaProvision))
  const appele = { loyer: loyerDu.toString(), provision: provisionDue.toString(), total: loyerDu.plus(provisionDue).toString() }
  if (duMois.length && new Big(appele.total).eq(0)) {
    return { ...vide, ecart: `${mois.split('-').reverse().join('/')} déjà payé en entier` }
  }
  if (new Big(appele.total).eq(montant)) {
    return { ...vide, loyer: appele.loyer, provision: appele.provision }
  }
  const loyer = montant.minus(appele.provision)
  return {
    ...vide,
    loyer: (loyer.lt(0) ? montant : loyer).toString(),
    provision: loyer.lt(0) ? '0' : appele.provision,
    ecart: `${duMois.length ? 'reste dû' : 'appelé'} ${new Big(appele.total).toFixed(2)} €, reçu ${montant.toFixed(2)} €`,
  }
}

// Categories read in the label of a movement (the most frequent ones of a rental company)
const MOTS: [RegExp, CategorieMouvement][] = [
  [/\bPRET\b|ECH PRET|ECHEANCE/, 'emprunt'],
  [/ASSURANCE|AURORE|IARD|\bMAAF|\bAXA\b|ALLIANZ|MACIF|MATMUT|SINISTRE/, 'assurance'],
  [/\bENGIE\b|\bEDF\b|ELECTRICITE DE FRANCE|TOTALENERGIES|\bGAZ\b|ELECTRICITE/, 'energie'],
  [/\bEAU\b|SEAFF|VEOLIA|SUEZ|SAUR\b/, 'eau'],
  [/DGFIP|IMPOT|TAXE FONCIERE|\bTRESOR\b/, 'impots'],
  [/^FACT(URE)? SGT|FRAIS|COTISATION|COMMISSION|\bAGIOS\b|INTERETS/, 'frais_bancaires'],
  [/\bSYNDIC\b|COPROPRIETE/, 'copropriete'],
  [/APPORT|VIREMENT INTERNE|VIR(EMENT)? COMPTE/, 'virement_interne'],
]

/**
 * The probable category: a tenant named in it (a credit is a payment, a debit a refund of deposit when it says so),
 * else words of its label; null when nothing is recognised.
 */
export function categoriePropose(m: Pick<Mouvement, 'libelle' | 'detail' | 'montant' | 'date_operation'>, sejours: Sejour[] = []): CategorieMouvement | null {
  const texte = normaliser(`${m.libelle} ${m.detail ?? ''}`)
  const mot = MOTS.find(([re]) => re.test(texte))?.[1] ?? null
  if (mot && mot !== 'virement_interne') {
    return mot
  }
  if (sejourDuMouvement(m, sejours)) {
    return new Big(m.montant).gt(0) ? 'locataire' : /CAUTION|DEPOT|GARANTIE/.test(texte) ? 'remboursement_depot' : 'locataire'
  }
  return mot
}

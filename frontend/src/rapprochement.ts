import Big from 'big.js'

import type { Echeance, Mouvement, Regularisation, Sejour } from './api'
import { attendu } from './echeances'

// What a bank movement probably is (ADR 0018), for the « Banque » screen: proposals only, the user accepts or changes
// them. A credit: the payment of a tenant whose name is in the label or the detail, for the month written in it
// (« LOYER 02/25 ») or else the month of the operation, split into rent and provision as called (ADR 0009), or toward
// a regularisation still to be paid. A debit: a reason to ignore it, from its label.

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
    const score = motsDuNom(s.locataire).filter((mot) => texte.includes(` ${mot} `)).length
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
  m: Mouvement, sejours: Sejour[], echeances: Echeance[], regularisations: Regularisation[],
): Proposition {
  const sejour = sejourDuMouvement(m, sejours)
  const mois = moisDuMouvement(m)
  const montant = new Big(m.montant).minus(m.couvert)
  const vide: Proposition = { sejour, mois, loyer: montant.toString(), provision: '0', regularisation_id: null, regularisation: '0', ecart: null }
  if (!sejour) {
    return { ...vide, ecart: 'locataire non reconnu dans le libellé' }
  }
  const regul = regularisations.find((r) => r.sejour_id === sejour.id && r.etat === 'en_attente'
    && new Big(r.solde).minus(r.montant_recu).eq(montant))
  if (regul) {
    return { ...vide, loyer: '0', regularisation_id: regul.id, regularisation: montant.toString() }
  }
  const appele = attendu(echeances, sejour, mois)
  if (!appele) {
    return { ...vide, ecart: `pas de loyer appelé connu pour ${mois}` }
  }
  if (new Big(appele.total).eq(montant)) {
    return { ...vide, loyer: appele.loyer, provision: appele.provision }
  }
  const loyer = montant.minus(appele.provision)
  return {
    ...vide,
    loyer: (loyer.lt(0) ? montant : loyer).toString(),
    provision: loyer.lt(0) ? '0' : appele.provision,
    ecart: `appelé ${new Big(appele.total).toFixed(2)} €, reçu ${montant.toFixed(2)} €`,
  }
}

// Reasons to ignore a debit, from words of its label (the most frequent outgoings of a rental company)
const MOTIFS: [RegExp, string][] = [
  [/\bPRET\b|ECH PRET|ECHEANCE/, 'Emprunt'],
  [/ASSURANCE|AURORE|IARD|\bMAAF|\bAXA\b|ALLIANZ|MACIF|MATMUT/, 'Assurance'],
  [/\bENGIE\b|\bEDF\b|TOTALENERGIES|\bGAZ\b|ELECTRICITE/, 'Facture d\'énergie (prélèvement)'],
  [/\bEAU\b|SEAFF|VEOLIA|SUEZ|SAUR\b/, 'Facture d\'eau'],
  [/DGFIP|IMPOT|TAXE FONCIERE|\bTRESOR\b/, 'Impôts et taxes'],
  [/^FACT(URE)? SGT|FRAIS|COTISATION|COMMISSION|\bAGIOS\b/, 'Frais bancaires'],
  [/\bSYNDIC\b|COPROPRIETE/, 'Charges de copropriété'],
]

export function motifPropose(m: Pick<Mouvement, 'libelle' | 'detail' | 'montant'>): string | null {
  if (new Big(m.montant).gt(0)) {
    return null
  }
  const texte = normaliser(`${m.libelle} ${m.detail ?? ''}`)
  return MOTIFS.find(([re]) => re.test(texte))?.[1] ?? null
}

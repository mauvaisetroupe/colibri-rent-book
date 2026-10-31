import Big from 'big.js'

import type { CategorieMouvement, Echeance, Mouvement, Paiement, Regularisation, Sejour } from './api'
import { attendu } from './echeances'

// What a bank movement probably is (ADR 0018), for the « Banque » screen: proposals only, the user accepts or changes
// them. Its category: the payment of a tenant whose name is in the label or the detail, else a category read in the
// label (loan, insurance, energy…). A tenant payment: for the month written in it (« LOYER 02/25 ») or else the month
// of the operation, split into rent and provision as called (ADR 0009) minus what is already paid for that month, or
// toward a regularisation still to be paid.

/** Upper case, without accents: « Hélène » and « HELENE » are the same. */
export const normaliser = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase()

const MOTS_VIDES = new Set(['EX', 'MME', 'MLE', 'MR', 'M', 'MLLE', 'MADAME', 'MONSIEUR', 'ET', 'DE', 'DU', 'LE', 'LA'])

/** The words of a name worth looking for: « Alice MARTIN (ex DURAND) » → ALICE, MARTIN, DURAND. */
export function motsDuNom(name: string) {
  return normaliser(name).split(/[^A-Z]+/).filter((m) => m.length >= 3 && !MOTS_VIDES.has(m))
}

/** First day of the month of an ISO date, as 'AAAA-MM'. */
const moisDe = (date: string) => date.slice(0, 7)

/** The stay whose tenant is named in the movement and present around its date (a month before, three after). */
export function sejourDuMouvement(m: Pick<Mouvement, 'label' | 'detail' | 'transaction_date'>, tenancies: Sejour[]): Sejour | null {
  const text = ` ${normaliser(`${m.label} ${m.detail ?? ''}`).replace(/[^A-Z]+/g, ' ')} `
  const date = new Date(m.transaction_date)
  const proche = (s: Sejour) => {
    const avant = new Date(s.move_in)
    avant.setMonth(avant.getMonth() - 1)
    const apres = s.move_out ? new Date(s.move_out) : null
    apres?.setMonth(apres.getMonth() + 3)
    return avant <= date && (!apres || date <= apres)
  }
  let meilleur: { tenancy: Sejour, score: number } | null = null
  for (const s of tenancies.filter(proche)) {
    // A word of the name, or its beginning when the bank cut the label (« LOYER ET RAPPEL DE CHARGES ZIEG »)
    const tronques = text.trim().split(' ').filter((t) => t.length >= 4)
    const score = motsDuNom(s.tenant)
      .filter((mot) => text.includes(` ${mot} `) || tronques.some((t) => mot.startsWith(t))).length
    if (score > 0 && (!meilleur || score > meilleur.score)) {
      meilleur = { tenancy: s, score }
    }
  }
  return meilleur?.tenancy ?? null
}

/** The month paid: written in the movement (« LOYER 02/25 », « LOYER 02/2025 »), else the month of the operation. */
export function moisDuMouvement(m: Pick<Mouvement, 'label' | 'detail' | 'transaction_date'>): string {
  const ecrit = `${m.label} ${m.detail ?? ''}`.match(/LOYER\D{0,12}(\d{1,2})[/.-](\d{2}(?:\d{2})?)\b/i)
  if (ecrit) {
    const month = Number(ecrit[1])
    const year = ecrit[2]!.length === 2 ? `20${ecrit[2]}` : ecrit[2]!
    if (month >= 1 && month <= 12) {
      return `${year}-${String(month).padStart(2, '0')}`
    }
  }
  return moisDe(m.transaction_date)
}

export type Proposition = {
  tenancy: Sejour | null
  month: string
  rent: string
  charge_advance: string
  charge_adjustment_id: number | null
  charge_adjustment: string
  // Why the split is not the amount called: shown, not blocking
  ecart: string | null
}

/**
 * A credit split as a payment: the rest of a sent regularisation when it matches that; else the rent and provision
 * called for the month (those of the stay, ADR 0009), less what is already paid for it. A transfer of more goes, for the
 * excess, to the regularisation still to be paid when there is one (the one paid in instalments of that amount, else the
 * oldest); a transfer of less pays the rent first. Any other
 * difference is shown, never put in the rent.
 */
export function proposer(
  m: Mouvement, tenancies: Sejour[], rent_schedules: Echeance[], charge_adjustments: Regularisation[], payments: Paiement[] = [],
): Proposition {
  const tenancy = sejourDuMouvement(m, tenancies)
  const month = moisDuMouvement(m)
  const amount = new Big(m.amount).abs().minus(m.covered)
  const vide: Proposition = { tenancy, month, rent: amount.toString(), charge_advance: '0', charge_adjustment_id: null, charge_adjustment: '0', ecart: null }
  if (!tenancy) {
    return { ...vide, ecart: 'locataire non reconnu dans le libellé' }
  }
  const regul = charge_adjustments.find((r) => r.tenancy_id === tenancy.id && r.state === 'pending'
    && new Big(r.balance).minus(r.amount_received).eq(amount))
  if (regul) {
    return { ...vide, rent: '0', charge_adjustment_id: regul.id, charge_adjustment: amount.toString() }
  }
  const appel = attendu(rent_schedules, tenancy, month)
  if (!appel) {
    return { ...vide, ecart: `pas de loyer appelé connu pour ${month}` }
  }
  // What is still due for the month: called, minus the payments of the month already recorded
  const duMois = payments.filter((p) => p.tenancy_id === tenancy.id && p.month?.slice(0, 7) === month)
  const dejaLoyer = duMois.reduce((t, p) => t.plus(p.rent), new Big(0))
  const dejaProvision = duMois.reduce((t, p) => t.plus(p.charge_advance), new Big(0))
  const positif = (x: Big) => (x.lt(0) ? new Big(0) : x)
  const loyerDu = positif(new Big(appel.rent).minus(dejaLoyer))
  const provisionDue = positif(new Big(appel.charge_advance).minus(dejaProvision))
  const appele = { rent: loyerDu.toString(), charge_advance: provisionDue.toString(), total: loyerDu.plus(provisionDue).toString() }
  if (duMois.length && new Big(appele.total).eq(0)) {
    return { ...vide, ecart: `${month.split('-').reverse().join('/')} déjà payé en entier` }
  }
  if (new Big(appele.total).eq(amount)) {
    return { ...vide, rent: appele.rent, charge_advance: appele.charge_advance }
  }
  const ecart = `${duMois.length ? 'reste dû' : 'appelé'} ${new Big(appele.total).toFixed(2)} €, reçu ${amount.toFixed(2)} €`
  if (amount.lt(appele.total)) {
    // Paid in part: the rent first, then the provision
    const rent = amount.lt(loyerDu) ? amount : loyerDu
    return { ...vide, rent: rent.toString(), charge_advance: amount.minus(rent).toString(), ecart }
  }
  const surplus = amount.minus(appele.total)
  // The regularisation paid in instalments of this amount, else the oldest one still to pay
  const ouvertes = charge_adjustments.filter((r) => r.tenancy_id === tenancy.id && r.state === 'pending'
    && new Big(r.balance).minus(r.amount_received).gt(0)).sort((a, b) => a.start.localeCompare(b.start))
  const ouverte = ouvertes.find((r) => payments.some((p) => p.charge_adjustment_id === r.id && new Big(p.charge_adjustment).eq(surplus)))
    ?? ouvertes[0]
  return {
    ...vide, rent: appele.rent, charge_advance: appele.charge_advance,
    ...(ouverte ? { charge_adjustment_id: ouverte.id, charge_adjustment: surplus.toString() } : {}),
    ecart: ouverte ? `${ecart} : le surplus de ${surplus.toFixed(2)} € va à la régularisation en attente` : ecart,
  }
}

// Categories read in the label of a movement (the most frequent ones of a rental company)
const MOTS: [RegExp, CategorieMouvement][] = [
  [/\bPRET\b|ECH PRET|ECHEANCE/, 'loan'],
  [/ASSURANCE|AURORE|IARD|\bMAAF|\bAXA\b|ALLIANZ|MACIF|MATMUT|SINISTRE/, 'insurance'],
  [/\bENGIE\b|\bEDF\b|ELECTRICITE DE FRANCE|TOTALENERGIES|\bGAZ\b|ELECTRICITE/, 'energy'],
  [/\bEAU\b|SEAFF|VEOLIA|SUEZ|SAUR\b/, 'water'],
  [/DGFIP|IMPOT|TAXE FONCIERE|\bTRESOR\b/, 'taxes'],
  [/^FACT(URE)? SGT|FRAIS|COTISATION|COMMISSION|\bAGIOS\b|INTERETS/, 'bank_fees'],
  [/\bSYNDIC\b|COPROPRIETE/, 'co_ownership'],
  [/APPORT|ASSOCIE/, 'partners'],
  [/VIREMENT INTERNE|VIR(EMENT)? COMPTE/, 'internal_transfer'],
]

/**
 * The probable category: a tenant named in it (a credit is a payment, a debit a deposit refunded when it says so),
 * else words of its label; null when nothing is recognised.
 */
export function categoriePropose(m: Pick<Mouvement, 'label' | 'detail' | 'amount' | 'transaction_date'>, tenancies: Sejour[] = []): CategorieMouvement | null {
  const text = normaliser(`${m.label} ${m.detail ?? ''}`)
  const mot = MOTS.find(([re]) => re.test(text))?.[1] ?? null
  // A partner named like a tenant: the word wins, except for a transfer between accounts
  if (mot && mot !== 'internal_transfer') {
    return mot
  }
  if (sejourDuMouvement(m, tenancies)) {
    return new Big(m.amount).gt(0) ? 'tenant' : /CAUTION|DEPOT|GARANTIE/.test(text) ? 'security_deposit' : 'tenant'
  }
  return mot
}

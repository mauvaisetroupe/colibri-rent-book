import Big from 'big.js'

import type { Echeance, Sejour } from './api'

// Amount called for a month of a stay (ADR 0009): the row of the stay in force that month (latest a_partir_du not
// after it), pro rata of the days of presence when the stay starts or ends during the month. Display only: the
// amounts stay text, computed with big.js.

/** Number of days of the month 'AAAA-MM'. */
const joursDuMois = (mois: string) => new Date(Number(mois.slice(0, 4)), Number(mois.slice(5, 7)), 0).getDate()

/** Days of presence of the stay during the month (both dates of the stay included). */
export function joursPresents(s: Sejour, mois: string) {
  const premier = `${mois}-01`
  const dernier = `${mois}-${String(joursDuMois(mois)).padStart(2, '0')}`
  const du = s.entree > premier ? s.entree : premier
  const au = s.sortie !== null && s.sortie < dernier ? s.sortie : dernier
  if (du > au) {
    return 0
  }
  return Number(au.slice(8, 10)) - Number(du.slice(8, 10)) + 1
}

/** Row in force for the month, or null when no amount called is recorded yet. */
export function echeanceDuMois(echeances: Echeance[], sejourId: number, mois: string) {
  return echeances
    .filter((e) => e.sejour_id === sejourId && e.a_partir_du.slice(0, 7) <= mois)
    .sort((a, b) => b.a_partir_du.localeCompare(a.a_partir_du))[0] ?? null
}

/** Rent and provision called for the month, pro rata of the days of presence, rounded to the cent; null if unknown. */
export function attendu(echeances: Echeance[], s: Sejour, mois: string) {
  const e = echeanceDuMois(echeances, s.id, mois)
  const jours = joursPresents(s, mois)
  if (!e || jours === 0) {
    return null
  }
  const part = (montant: string) => new Big(montant).times(jours).div(joursDuMois(mois)).round(2).toString()
  const loyer = part(e.loyer)
  const provision = part(e.provision)
  return { loyer, provision, total: new Big(loyer).plus(provision).toString(), complet: jours === joursDuMois(mois) }
}

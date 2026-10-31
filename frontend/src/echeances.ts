import Big from 'big.js'

import type { Echeance, Sejour } from './api'

// Amount called for a month of a stay (ADR 0009): the row of the stay in force that month (latest a_partir_du not
// after it), pro rata of the days of presence when the stay starts or ends during the month. Display only: the
// amounts stay text, computed with big.js.

/** Number of days of the month 'AAAA-MM'. */
const joursDuMois = (month: string) => new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()

/** Days of presence of the stay during the month (both dates of the stay included). */
export function joursPresents(s: Sejour, month: string) {
  const premier = `${month}-01`
  const last = `${month}-${String(joursDuMois(month)).padStart(2, '0')}`
  const du = s.move_in > premier ? s.move_in : premier
  const au = s.move_out !== null && s.move_out < last ? s.move_out : last
  if (du > au) {
    return 0
  }
  return Number(au.slice(8, 10)) - Number(du.slice(8, 10)) + 1
}

/** Row in force for the month, or null when no amount called is recorded yet. */
export function echeanceDuMois(rent_schedules: Echeance[], sejourId: number, month: string) {
  return rent_schedules
    .filter((e) => e.tenancy_id === sejourId && e.from_month.slice(0, 7) <= month)
    .sort((a, b) => b.from_month.localeCompare(a.from_month))[0] ?? null
}

/** Rent and provision called for the month, pro rata of the days of presence, rounded to the cent; null if unknown. */
export function attendu(rent_schedules: Echeance[], s: Sejour, month: string) {
  const e = echeanceDuMois(rent_schedules, s.id, month)
  const days = joursPresents(s, month)
  if (!e || days === 0) {
    return null
  }
  const part = (amount: string) => new Big(amount).times(days).div(joursDuMois(month)).round(2).toString()
  const rent = part(e.rent)
  const charge_advance = part(e.charge_advance)
  return { rent, charge_advance, total: new Big(rent).plus(charge_advance).toString(), complet: days === joursDuMois(month) }
}

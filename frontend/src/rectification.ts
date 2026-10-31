import Big from 'big.js'

import { api, type Decompte, type LigneDecompte, type Regularisation } from './api'

// Is a regularisation still right? Its frozen balance compared with the statement of its stay recomputed today over
// its period (what a corrective one would give). Display only: amounts stay text, computed with big.js.

/** From this gap on, the regularisation is to be corrected; below, a rounding gap is only shown (2023: invoices typed
 * from the totals of the legacy workbook, about 1 €). */
export const SEUIL_RECTIFICATION = new Big('5')

export type Comparaison = {
  actuel: { total: string, advances: string, balance: string }
  // Current balance − frozen balance: negative, asked too much; positive, asked too little
  ecart: string
  state: 'juste' | 'arrondi' | 'a_rectifier' | 'a_recreer'
}

/** Statements of the periods of the regularisations, one request per period. */
export async function decomptesDesPeriodes(building: number, charge_adjustments: Regularisation[]) {
  const periodes = [...new Set(charge_adjustments.map((r) => `${r.start}/${r.end}`))]
  const decomptes = await Promise.all(periodes.map((p) =>
    api.charge_statement({ building, start: p.slice(0, 10), end: p.slice(11) })))
  return new Map(periodes.map((p, i) => [p, decomptes[i]!]))
}

export function comparer(r: Regularisation, decomptes: Map<string, Decompte>): Comparaison | null {
  // Nothing to correct once the owner decided to give it up or that it will never be paid
  if (r.replaced_by || r.decision !== null) {
    return null
  }
  const ligne: LigneDecompte | undefined = decomptes.get(`${r.start}/${r.end}`)?.tenancies.find((s) => s.tenancy_id === r.tenancy_id)
  if (!ligne) {
    return null
  }
  const centimes = (v: string) => new Big(v).round(2).toString()
  const actuel = { total: centimes(ligne.total), advances: centimes(ligne.advances), balance: centimes(ligne.balance) }
  const ecart = new Big(actuel.balance).minus(r.balance)
  const state = ecart.eq(0) ? 'juste'
    : ecart.abs().lt(SEUIL_RECTIFICATION) ? 'arrondi'
      : r.state === 'draft' ? 'a_recreer' : 'a_rectifier'
  return { actuel, ecart: ecart.toString(), state }
}

/** The regularisation in force in the chain of `id`: itself, or its last corrective one. A payment made before a
 * correction counts for it (the amount received adds up the chain) and is moved to it when edited, the API taking
 * payments on the current regularisation only. */
export function regularisationCourante(id: number, charge_adjustments: Regularisation[]): number {
  let current = id
  for (let r = charge_adjustments.find((x) => x.id === id); r?.replaced_by; r = charge_adjustments.find((x) => x.id === current)) {
    current = r.replaced_by
  }
  return current
}

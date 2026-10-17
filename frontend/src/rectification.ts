import Big from 'big.js'

import { api, type Decompte, type LigneDecompte, type Regularisation } from './api'

// Is a regularisation still right? Its frozen balance compared with the statement of its stay recomputed today over
// its period (what a corrective one would give). Display only: amounts stay text, computed with big.js.

/** From this gap on, the regularisation is to be corrected; below, a rounding gap is only shown (2023: invoices typed
 * from the totals of the legacy workbook, about 1 €). */
export const SEUIL_RECTIFICATION = new Big('5')

export type Comparaison = {
  actuel: { total: string, provisions: string, solde: string }
  // Current balance − frozen balance: negative, asked too much; positive, asked too little
  ecart: string
  etat: 'juste' | 'arrondi' | 'a_rectifier' | 'a_recreer'
}

/** Statements of the periods of the regularisations, one request per period. */
export async function decomptesDesPeriodes(immeuble: number, regularisations: Regularisation[]) {
  const periodes = [...new Set(regularisations.map((r) => `${r.debut}/${r.fin}`))]
  const decomptes = await Promise.all(periodes.map((p) =>
    api.decompte({ immeuble, debut: p.slice(0, 10), fin: p.slice(11) })))
  return new Map(periodes.map((p, i) => [p, decomptes[i]!]))
}

export function comparer(r: Regularisation, decomptes: Map<string, Decompte>): Comparaison | null {
  // Nothing to correct once the owner decided to give it up or that it will never be paid
  if (r.remplacee_par || r.decision !== null) {
    return null
  }
  const ligne: LigneDecompte | undefined = decomptes.get(`${r.debut}/${r.fin}`)?.sejours.find((s) => s.sejour_id === r.sejour_id)
  if (!ligne) {
    return null
  }
  const centimes = (v: string) => new Big(v).round(2).toString()
  const actuel = { total: centimes(ligne.total), provisions: centimes(ligne.provisions), solde: centimes(ligne.solde) }
  const ecart = new Big(actuel.solde).minus(r.solde)
  const etat = ecart.eq(0) ? 'juste'
    : ecart.abs().lt(SEUIL_RECTIFICATION) ? 'arrondi'
      : r.etat === 'brouillon' ? 'a_recreer' : 'a_rectifier'
  return { actuel, ecart: ecart.toString(), etat }
}

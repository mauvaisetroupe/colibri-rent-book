import Big from 'big.js'

import { estRetenue, type Echeance, type Paiement, type Regularisation, type Sejour } from './api'
import { attendu } from './echeances'

// What a retention on the deposit can cover (ADR 0021), proposed by « Retenue… » in the deposit of the stay: the months
// still unpaid (rent and provision called, ADR 0009, less what was paid for them) and the sent regularisations still
// open (their balance less their payments), the oldest first, filled up to the deposit paid. The retention being made
// again as a whole, its current lines are left out of what was paid. Proposals only: the amounts can be changed.

export type Du = {
  // 'AAAA-MM' for a month, the regularisation's id otherwise
  cle: string
  libelle: string
  // Sorting date: the month, or the end of the regularised period
  date: string
  mois: string | null
  regularisation_id: number | null
  loyer: string
  provision: string
  // What is owed, and the part of the deposit proposed for it
  du: string
  propose: string
}

const plusGrand = (a: Big, b: Big | number) => (a.gt(b) ? a : new Big(b))
const plusPetit = (a: Big, b: Big) => (a.lt(b) ? a : b)

const moisSuivant = (m: string) => {
  const [a, mm] = m.split('-').map(Number)
  return mm === 12 ? `${a! + 1}-01` : `${a}-${String(mm! + 1).padStart(2, '0')}`
}

export function dusDuSejour(s: Sejour, echeances: Echeance[], paiements: Paiement[], regularisations: Regularisation[],
  verse: string, aujourdhui = new Date().toISOString().slice(0, 10)): Du[] {
  const siens = paiements.filter((p) => p.sejour_id === s.id && !estRetenue(p))
  const dus: Omit<Du, 'propose'>[] = []

  // Months: from the first one paid (the months before were not followed here), to the exit or this month
  const payes = siens.filter((p) => p.mois).map((p) => p.mois!.slice(0, 7)).sort()
  const fin = [s.sortie ?? aujourdhui, aujourdhui].sort()[0]!.slice(0, 7)
  for (let m = payes[0] ?? s.entree.slice(0, 7); m <= fin; m = moisSuivant(m)) {
    const a = attendu(echeances, s, m)
    if (!a) {
      continue
    }
    const duMois = siens.filter((p) => p.mois?.startsWith(m))
    const loyer = plusGrand(new Big(a.loyer).minus(duMois.reduce((t, p) => t.plus(p.loyer), new Big(0))), 0)
    const provision = plusGrand(new Big(a.provision).minus(duMois.reduce((t, p) => t.plus(p.provision), new Big(0))), 0)
    if (loyer.plus(provision).gt(0)) {
      dus.push({ cle: m, libelle: `Loyer ${m.slice(5, 7)}/${m.slice(0, 4)}`, date: `${m}-01`, mois: m, regularisation_id: null,
        loyer: loyer.toString(), provision: provision.toString(), du: loyer.plus(provision).toString() })
    }
  }

  // Regularisations sent, current, without a decision, still owed (without the current retention); one settled within
  // 1 euro (ADR 0010) only when the retention is what settles it
  const retenu = (r: Regularisation) => paiements.filter((p) => estRetenue(p) && p.regularisation_id === r.id)
    .reduce((t, p) => t.plus(p.regularisation), new Big(0))
  for (const r of regularisations.filter((x) => x.sejour_id === s.id && x.etat !== 'brouillon' && !x.remplacee_par && !x.decision)) {
    const reste = new Big(r.solde).minus(r.montant_recu).plus(retenu(r))
    if (reste.gt(0) && (r.etat === 'en_attente' || retenu(r).gt(0))) {
      dus.push({ cle: `r${r.id}`, libelle: `Régularisation ${r.debut.slice(0, 4)}${r.fin.slice(0, 4) !== r.debut.slice(0, 4) ? `-${r.fin.slice(0, 4)}` : ''}`,
        date: r.fin, mois: null, regularisation_id: r.id, loyer: '0', provision: '0', du: reste.toString() })
    }
  }

  // The oldest first, up to the deposit paid
  let reste = plusGrand(new Big(verse), 0)
  return dus.sort((a, b) => a.date.localeCompare(b.date)).map((d) => {
    const propose = reste.lt(d.du) ? reste : new Big(d.du)
    reste = reste.minus(propose)
    return { ...d, propose: propose.toString() }
  })
}

/** A month kept in part: the rent first, then the provision. */
export function partageMois(d: Du, montant: string) {
  const loyer = plusPetit(new Big(montant), new Big(d.loyer))
  return { loyer: loyer.toString(), provision: new Big(montant).minus(loyer).toString() }
}

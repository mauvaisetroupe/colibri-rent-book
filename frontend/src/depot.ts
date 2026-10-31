import Big from 'big.js'

import { estRetenue, type Echeance, type Paiement, type Regularisation, type Sejour } from './api'
import { attendu } from './echeances'

// What a retention on the deposit can cover (ADR 0021), proposed by « Retenue… » in the deposit of the stay: the months
// still unpaid (rent and provision called, ADR 0009, less what was paid for them) and the sent regularisations still
// open (their balance less their payments), the oldest first, filled up to the deposit paid. The retention being made
// again as a whole, its current lines are left out of what was paid. The provision of a month a regularisation covers
// is not proposed: the regularisation was computed on the provisions paid (ADR 0008), its balance already holds what
// is missing, and keeping it on the month too would count it twice. Proposals only: the amounts can be changed.

export type Du = {
  // 'AAAA-MM' for a month, the regularisation's id otherwise
  cle: string
  label: string
  // Sorting date: the month, or the end of the regularised period
  date: string
  month: string | null
  charge_adjustment_id: number | null
  rent: string
  charge_advance: string
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

export function dusDuSejour(s: Sejour, rent_schedules: Echeance[], payments: Paiement[], charge_adjustments: Regularisation[],
  paid: string, aujourdhui = new Date().toISOString().slice(0, 10)): Du[] {
  const siens = payments.filter((p) => p.tenancy_id === s.id && !estRetenue(p))
  const dus: Omit<Du, 'propose'>[] = []

  // Months: from the first one paid (the months before were not followed here), to the exit or this month
  const payes = siens.filter((p) => p.month).map((p) => p.month!.slice(0, 7)).sort()
  const end = [s.move_out ?? aujourdhui, aujourdhui].sort()[0]!.slice(0, 7)
  const regularise = (m: string) => charge_adjustments.some((r) => r.tenancy_id === s.id && !r.replaced_by
    && r.start <= `${m}-01` && `${m}-01` <= r.end)
  for (let m = payes[0] ?? s.move_in.slice(0, 7); m <= end; m = moisSuivant(m)) {
    const a = attendu(rent_schedules, s, m)
    if (!a) {
      continue
    }
    const duMois = siens.filter((p) => p.month?.startsWith(m))
    const rent = plusGrand(new Big(a.rent).minus(duMois.reduce((t, p) => t.plus(p.rent), new Big(0))), 0)
    const charge_advance = regularise(m) ? new Big(0)
      : plusGrand(new Big(a.charge_advance).minus(duMois.reduce((t, p) => t.plus(p.charge_advance), new Big(0))), 0)
    if (rent.plus(charge_advance).gt(0)) {
      dus.push({ cle: m, label: `Loyer ${m.slice(5, 7)}/${m.slice(0, 4)}`, date: `${m}-01`, month: m, charge_adjustment_id: null,
        rent: rent.toString(), charge_advance: charge_advance.toString(), du: rent.plus(charge_advance).toString() })
    }
  }

  // Regularisations sent, current, without a decision, still owed (without the current retention); one settled within
  // 1 euro (ADR 0010) only when the retention is what settles it
  const retained = (r: Regularisation) => payments.filter((p) => estRetenue(p) && p.charge_adjustment_id === r.id)
    .reduce((t, p) => t.plus(p.charge_adjustment), new Big(0))
  for (const r of charge_adjustments.filter((x) => x.tenancy_id === s.id && x.state !== 'draft' && !x.replaced_by && !x.decision)) {
    const remaining = new Big(r.balance).minus(r.amount_received).plus(retained(r))
    if (remaining.gt(0) && (r.state === 'pending' || retained(r).gt(0))) {
      dus.push({ cle: `r${r.id}`, label: `Régularisation ${r.start.slice(0, 4)}${r.end.slice(0, 4) !== r.start.slice(0, 4) ? `-${r.end.slice(0, 4)}` : ''}`,
        date: r.end, month: null, charge_adjustment_id: r.id, rent: '0', charge_advance: '0', du: remaining.toString() })
    }
  }

  // The oldest first, up to the deposit paid
  let remaining = plusGrand(new Big(paid), 0)
  return dus.sort((a, b) => a.date.localeCompare(b.date)).map((d) => {
    const propose = remaining.lt(d.du) ? remaining : new Big(d.du)
    remaining = remaining.minus(propose)
    return { ...d, propose: propose.toString() }
  })
}

/** A month kept in part: the rent first, then the provision. */
export function partageMois(d: Du, amount: string) {
  const rent = plusPetit(new Big(amount), new Big(d.rent))
  return { rent: rent.toString(), charge_advance: new Big(amount).minus(rent).toString() }
}

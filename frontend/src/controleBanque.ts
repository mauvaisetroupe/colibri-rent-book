import { estRetenue, type FactureResumee, type Mouvement, type Paiement, type ReleveResume } from './api'

// State of the bank over an exercise (ADR 0018), for the checks and the home: statements missing (a gap between two
// statements of an account, or none for the last weeks of the exercise), movements not categorised or whose detail is
// incomplete, and the payments of the exercise that no statement shows (typed twice, or not received), counted only
// over the dates the statements cover.

export type CompteBanque = { account: string, premier: string, last: string, manquants: string[] }

export type EtatBanque = {
  comptes: CompteBanque[]
  // The statements end more than a month before the end of the exercise (or today): the last ones to import
  finManquante: string | null
  aCategoriser: Mouvement[]
  incomplets: Mouvement[]
  sansMouvement: Paiement[]
}

const plusJours = (date: string, days: number) => new Date(new Date(date).getTime() + days * 864e5).toISOString().slice(0, 10)

export function etatBanque(statements: ReleveResume[], transactions: Mouvement[], payments: Paiement[], start: string, end: string,
  aujourdhui = new Date().toISOString().slice(0, 10)): EtatBanque {
  const parCompte = new Map<string, ReleveResume[]>()
  for (const r of [...statements].sort((a, b) => a.statement_date.localeCompare(b.statement_date))) {
    parCompte.set(r.account, [...(parCompte.get(r.account) ?? []), r])
  }
  const comptes = [...parCompte].map(([account, liste]) => ({
    account,
    premier: liste[0]!.statement_date,
    last: liste.at(-1)!.statement_date,
    manquants: liste.filter((r) => r.suite === false && r.statement_date >= start && r.statement_date <= plusJours(end, 31))
      .map((r) => r.statement_date),
  }))
  const premier = comptes.map((c) => c.premier).sort()[0] ?? null
  const last = comptes.map((c) => c.last).sort().at(-1) ?? null
  const attendu = [end, aujourdhui].sort()[0]!
  const finManquante = comptes.length && last! < plusJours(attendu, -31) && attendu >= start ? last : null

  const surExercice = transactions.filter((m) => m.transaction_date >= start && m.transaction_date <= end)
  // A retention on the deposit (ADR 0021) is seen on no statement
  const sansMouvement = premier === null ? [] : payments.filter((p) => !p.bank_transaction_id && !estRetenue(p) && p.payment_date >= start
    && p.payment_date <= end && p.payment_date >= premier && p.payment_date <= last!)
  return {
    comptes,
    finManquante,
    aCategoriser: surExercice.filter((m) => m.status === 'to_categorise'),
    incomplets: surExercice.filter((m) => m.status === 'incomplet'),
    sansMouvement: sansMouvement.sort((a, b) => a.payment_date.localeCompare(b.payment_date)),
  }
}

export const nbProblemesBanque = (e: EtatBanque) =>
  e.comptes.reduce((n, c) => n + c.manquants.length, 0) + (e.finManquante ? 1 : 0) + e.aCategoriser.length
  + e.incomplets.length + e.sansMouvement.length

/**
 * Validated invoices paid a little more than their total (ADR 0022: a balance rounded by the supplier, up to 1 euro),
 * whose last payment falls in the exercise: shown in the checks, not a problem.
 */
export const facturesAvecEcart = (invoices: FactureResumee[], start: string, end: string) => invoices
  .filter((f) => f.status === 'validated' && Number(f.remaining) < 0 && f.payment_date !== null && f.payment_date >= start
    && f.payment_date <= end)

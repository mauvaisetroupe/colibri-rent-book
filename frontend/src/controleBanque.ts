import { estRetenue, type Mouvement, type Paiement, type ReleveResume } from './api'

// State of the bank over an exercise (ADR 0018), for the checks and the home: statements missing (a gap between two
// statements of an account, or none for the last weeks of the exercise), movements not categorised or whose detail is
// incomplete, and the payments of the exercise that no statement shows (typed twice, or not received), counted only
// over the dates the statements cover.

export type CompteBanque = { compte: string, premier: string, dernier: string, manquants: string[] }

export type EtatBanque = {
  comptes: CompteBanque[]
  // The statements end more than a month before the end of the exercise (or today): the last ones to import
  finManquante: string | null
  aCategoriser: Mouvement[]
  incomplets: Mouvement[]
  sansMouvement: Paiement[]
}

const plusJours = (date: string, jours: number) => new Date(new Date(date).getTime() + jours * 864e5).toISOString().slice(0, 10)

export function etatBanque(releves: ReleveResume[], mouvements: Mouvement[], paiements: Paiement[], debut: string, fin: string,
  aujourdhui = new Date().toISOString().slice(0, 10)): EtatBanque {
  const parCompte = new Map<string, ReleveResume[]>()
  for (const r of [...releves].sort((a, b) => a.date_releve.localeCompare(b.date_releve))) {
    parCompte.set(r.compte, [...(parCompte.get(r.compte) ?? []), r])
  }
  const comptes = [...parCompte].map(([compte, liste]) => ({
    compte,
    premier: liste[0]!.date_releve,
    dernier: liste.at(-1)!.date_releve,
    manquants: liste.filter((r) => r.suite === false && r.date_releve >= debut && r.date_releve <= plusJours(fin, 31))
      .map((r) => r.date_releve),
  }))
  const premier = comptes.map((c) => c.premier).sort()[0] ?? null
  const dernier = comptes.map((c) => c.dernier).sort().at(-1) ?? null
  const attendu = [fin, aujourdhui].sort()[0]!
  const finManquante = comptes.length && dernier! < plusJours(attendu, -31) && attendu >= debut ? dernier : null

  const surExercice = mouvements.filter((m) => m.date_operation >= debut && m.date_operation <= fin)
  // A retention on the deposit (ADR 0021) is seen on no statement
  const sansMouvement = premier === null ? [] : paiements.filter((p) => !p.mouvement_id && !estRetenue(p) && p.date_paiement >= debut
    && p.date_paiement <= fin && p.date_paiement >= premier && p.date_paiement <= dernier!)
  return {
    comptes,
    finManquante,
    aCategoriser: surExercice.filter((m) => m.statut === 'a_categoriser'),
    incomplets: surExercice.filter((m) => m.statut === 'incomplet'),
    sansMouvement: sansMouvement.sort((a, b) => a.date_paiement.localeCompare(b.date_paiement)),
  }
}

export const nbProblemesBanque = (e: EtatBanque) =>
  e.comptes.reduce((n, c) => n + c.manquants.length, 0) + (e.finManquante ? 1 : 0) + e.aCategoriser.length
  + e.incomplets.length + e.sansMouvement.length

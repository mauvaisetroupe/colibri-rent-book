import Big from 'big.js'

import type { Decompte, LigneDecompte, Regularisation } from './api'

// Missing regularisations: a stay present during a finished exercise, with charges or provisions over it, and no
// current regularisation (not replaced) whose period covers its presence. Both ways: the tenant owes (provisions too
// low) or is owed (provisions too high), even a zero balance is to be sent. A stay with neither charges nor provisions
// (a house whose charges the owner does not manage) has nothing to regularise.

export type Manquante = { debut: string, fin: string, sejour: LigneDecompte }

export function regularisationsManquantes(decompte: Decompte, regularisations: Regularisation[], aujourdhui: string,
  debutGestion: string | null = null): Manquante[] {
  // Not before the start of the management of the building (ADR 0023), nor for an exercise not finished
  if (decompte.fin >= aujourdhui || (debutGestion !== null && decompte.fin < debutGestion)) {
    return []
  }
  return decompte.sejours
    .filter((s) => s.jours > 0 && s.present_du && s.present_au
      && !(new Big(s.total).eq(0) && new Big(s.provisions).eq(0))
      && !regularisations.some((r) => r.sejour_id === s.sejour_id && !r.remplacee_par
        && r.debut <= s.present_du! && r.fin >= s.present_au!))
    .map((sejour) => ({ debut: decompte.debut, fin: decompte.fin, sejour }))
}

/**
 * The calendar years to look at: from the start of the management of the building (ADR 0023), else from the first one
 * a regularisation was made for, to the last finished one.
 */
export function anneesARegulariser(regularisations: Regularisation[], aujourdhui: string, debutGestion: string | null = null): number[] {
  const premiere = debutGestion !== null ? Number(debutGestion.slice(0, 4))
    : regularisations.map((r) => Number(r.debut.slice(0, 4))).sort()[0]
  const derniere = Number(aujourdhui.slice(0, 4)) - 1
  return premiere === undefined ? [] : Array.from({ length: Math.max(0, derniere - premiere + 1) }, (_, i) => premiere + i)
}

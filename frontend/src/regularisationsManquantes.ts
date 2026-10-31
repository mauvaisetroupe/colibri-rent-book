import Big from 'big.js'

import type { Decompte, LigneDecompte, Regularisation } from './api'

// Missing regularisations: a stay present during a finished exercise, with charges or provisions over it, and no
// current regularisation (not replaced) whose period covers its presence. Both ways: the tenant owes (provisions too
// low) or is owed (provisions too high), even a zero balance is to be sent. A stay with neither charges nor provisions
// (a house whose charges the owner does not manage) has nothing to regularise.

export type Manquante = { start: string, end: string, tenancy: LigneDecompte }

export function regularisationsManquantes(charge_statement: Decompte, charge_adjustments: Regularisation[], aujourdhui: string,
  debutGestion: string | null = null): Manquante[] {
  // Not before the start of the management of the building (ADR 0023), nor for an exercise not finished
  if (charge_statement.end >= aujourdhui || (debutGestion !== null && charge_statement.end < debutGestion)) {
    return []
  }
  return charge_statement.tenancies
    .filter((s) => s.days > 0 && s.present_from && s.present_to
      && !(new Big(s.total).eq(0) && new Big(s.advances).eq(0))
      && !charge_adjustments.some((r) => r.tenancy_id === s.tenancy_id && !r.replaced_by
        && r.start <= s.present_from! && r.end >= s.present_to!))
    .map((tenancy) => ({ start: charge_statement.start, end: charge_statement.end, tenancy }))
}

/**
 * The calendar years to look at: from the start of the management of the building (ADR 0023), else from the first one
 * a regularisation was made for, to the last finished one.
 */
export function anneesARegulariser(charge_adjustments: Regularisation[], aujourdhui: string, debutGestion: string | null = null): number[] {
  const premiere = debutGestion !== null ? Number(debutGestion.slice(0, 4))
    : charge_adjustments.map((r) => Number(r.start.slice(0, 4))).sort()[0]
  const latest = Number(aujourdhui.slice(0, 4)) - 1
  return premiere === undefined ? [] : Array.from({ length: Math.max(0, latest - premiere + 1) }, (_, i) => premiere + i)
}

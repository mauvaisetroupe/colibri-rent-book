import Big from 'big.js'

import type { Ligne } from '../api'

// « Tester sur les factures » (ADR 0013): what a version reads in the PDF of an invoice, compared with what is stored
// (lines as validated, corrections by hand included). Pure: no network, testable in Node.
// - a field the extractor gives as null (« not on this PDF, typed by hand ») is no difference;
// - lines are paired by label and period, not by position (the stored order may differ);
// - a stored line that the PDF does not give was added by hand: a remark, not a failure;
// - a line read but not stored, a different amount, category or allocation: a failure.

export type Lecture = { numero: string | null, date: string | null, total: string | null, lignes: Ligne[] }
export type Enregistree = { numero: string, date_facture: string, montant_ttc: string | null, lignes: Ligne[] }

export type Ecarts = {
  // Make the invoice fail the test
  differences: string[]
  // Shown, without failing the test (corrections by hand)
  remarques: string[]
}

const memeMontant = (a: string | null, b: string | null) =>
  a === b || (!!a && !!b && new Big(a).eq(b))

const cle = (l: Ligne) => `${l.libelle}|${l.debut}|${l.fin}`
const nom = (l: Ligne) => `« ${l.libelle} » du ${l.debut} au ${l.fin}`

export function ecarts(lue: Lecture, enregistree: Enregistree): Ecarts {
  const differences: string[] = []
  const remarques: string[] = []

  if (lue.numero !== null && lue.numero !== enregistree.numero) {
    differences.push(`numéro ${lue.numero} au lieu de ${enregistree.numero}`)
  }
  if (lue.date !== null && lue.date !== enregistree.date_facture) {
    differences.push(`date ${lue.date} au lieu de ${enregistree.date_facture}`)
  }
  if (lue.total === null) {
    if (enregistree.montant_ttc) {
      remarques.push('total saisi à la main')
    }
  } else if (!memeMontant(lue.total, enregistree.montant_ttc)) {
    differences.push(`total ${lue.total} au lieu de ${enregistree.montant_ttc ?? '—'}`)
  }

  const restantes = [...enregistree.lignes]
  for (const l of lue.lignes) {
    const i = restantes.findIndex((e) => cle(e) === cle(l))
    if (i < 0) {
      differences.push(`ligne lue absente de la base : ${nom(l)}, ${l.montant_ttc}`)
      continue
    }
    const [e] = restantes.splice(i, 1) as [Ligne]
    const champs = (['categorie', 'affectation', 'note'] as const)
      .filter((c) => (l[c] ?? null) !== (e[c] ?? null))
      .map((c) => `${c} « ${l[c] ?? ''} » au lieu de « ${e[c] ?? ''} »`)
    if (!memeMontant(l.montant_ttc, e.montant_ttc)) {
      champs.push(`montant ${l.montant_ttc} au lieu de ${e.montant_ttc}`)
    }
    if (champs.length) {
      differences.push(`${nom(e)} : ${champs.join(', ')}`)
    }
  }
  for (const e of restantes) {
    remarques.push(`ligne ajoutée à la main : ${nom(e)}, ${e.montant_ttc}`)
  }

  const somme = lue.lignes.reduce((t, l) => t.plus(l.montant_ttc || 0), new Big(0))
  if (lue.total !== null && somme.minus(lue.total).abs().gt('0.05')) {
    differences.push(`somme des lignes lues ${somme.toFixed(2)} ≠ total lu ${lue.total}`)
  }
  return { differences, remarques }
}

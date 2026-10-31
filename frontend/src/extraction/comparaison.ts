import Big from 'big.js'

import type { Ligne } from '../api'

// « Tester sur les factures » (ADR 0013): what a version reads in the PDF of an invoice, compared with what is stored
// (lines as validated, corrections by hand included). Pure: no network, testable in Node.
// - a field the extractor gives as null (« not on this PDF, typed by hand ») is no difference;
// - lines are paired by label and period, not by position (the stored order may differ);
// - a stored line that the PDF does not give was added by hand: a remark, not a failure;
// - a line read but not stored, a different amount, category or allocation: a failure.

export type Lecture = { number: string | null, date: string | null, total: string | null, lines: Ligne[] }
// Names of the fields of a line, as the messages show them
const CHAMPS = { category: 'catégorie', allocation: 'affectation', note: 'note' }

export type Enregistree = { number: string, invoice_date: string, total_incl_tax: string | null, lines: Ligne[] }

export type Ecarts = {
  // Make the invoice fail the test
  differences: string[]
  // Shown, without failing the test (corrections by hand)
  remarques: string[]
}

const memeMontant = (a: string | null, b: string | null) =>
  a === b || (!!a && !!b && new Big(a).eq(b))

const cle = (l: Ligne) => `${l.label}|${l.start}|${l.end}`
const name = (l: Ligne) => `« ${l.label} » du ${l.start} au ${l.end}`

export function ecarts(lue: Lecture, enregistree: Enregistree): Ecarts {
  const differences: string[] = []
  const remarques: string[] = []

  if (lue.number !== null && lue.number !== enregistree.number) {
    differences.push(`numéro ${lue.number} au lieu de ${enregistree.number}`)
  }
  if (lue.date !== null && lue.date !== enregistree.invoice_date) {
    differences.push(`date ${lue.date} au lieu de ${enregistree.invoice_date}`)
  }
  if (lue.total === null) {
    if (enregistree.total_incl_tax) {
      remarques.push('total saisi à la main')
    }
  } else if (!memeMontant(lue.total, enregistree.total_incl_tax)) {
    differences.push(`total ${lue.total} au lieu de ${enregistree.total_incl_tax ?? '—'}`)
  }

  const restantes = [...enregistree.lines]
  for (const l of lue.lines) {
    const i = restantes.findIndex((e) => cle(e) === cle(l))
    if (i < 0) {
      differences.push(`ligne lue absente de la base : ${name(l)}, ${l.amount_incl_tax}`)
      continue
    }
    const [e] = restantes.splice(i, 1) as [Ligne]
    const champs = (['category', 'allocation', 'note'] as const)
      .filter((c) => (l[c] ?? null) !== (e[c] ?? null))
      .map((c) => `${CHAMPS[c]} « ${l[c] ?? ''} » au lieu de « ${e[c] ?? ''} »`)
    if (!memeMontant(l.amount_incl_tax, e.amount_incl_tax)) {
      champs.push(`montant ${l.amount_incl_tax} au lieu de ${e.amount_incl_tax}`)
    }
    if (champs.length) {
      differences.push(`${name(e)} : ${champs.join(', ')}`)
    }
  }
  for (const e of restantes) {
    remarques.push(`ligne ajoutée à la main : ${name(e)}, ${e.amount_incl_tax}`)
  }

  const somme = lue.lines.reduce((t, l) => t.plus(l.amount_incl_tax || 0), new Big(0))
  if (lue.total !== null && somme.minus(lue.total).abs().gt('0.05')) {
    differences.push(`somme des lignes lues ${somme.toFixed(2)} ≠ total lu ${lue.total}`)
  }
  return { differences, remarques }
}

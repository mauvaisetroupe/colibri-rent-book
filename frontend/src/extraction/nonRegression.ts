import Big from 'big.js'

import { api, type FactureAvecPdf, type Ligne } from '../api'
import type { ClasseExtracteur, Reglages } from './contrat'
import { documentDe, extraire, reconnait } from './moteur'
import { morceauxDuPdf } from './navigateur'

// « Tester sur les factures » (ADR 0013): the version being edited reads again the PDFs of the invoices of its
// supplier; what it gives is compared with what is stored (lines as validated, corrections by hand included), and its
// lines must add up to the total.

export type Comparaison = {
  facture: FactureAvecPdf
  differences: string[]
}

const memeMontant = (a: string | null, b: string | null) =>
  a === b || (a !== null && b !== null && a !== '' && b !== '' && new Big(a).eq(b))

const CHAMPS: (keyof Ligne)[] = ['categorie', 'libelle', 'debut', 'fin', 'affectation', 'note']

// The stored order may differ from the PDF (seed, lines reordered by hand): both sides are compared in one order
const cle = (l: Ligne) => [l.debut, l.fin, l.categorie, l.libelle, l.montant_ttc ? new Big(l.montant_ttc).toFixed(3) : ''].join('|')
const trier = (lignes: Ligne[]) => [...lignes].sort((a, b) => cle(a).localeCompare(cle(b)))

function differencesDeLignes(luesDansLOrdre: Ligne[], enregistreesDansLOrdre: Ligne[]): string[] {
  const lues = trier(luesDansLOrdre)
  const enregistrees = trier(enregistreesDansLOrdre)
  const differences: string[] = []
  if (lues.length !== enregistrees.length) {
    differences.push(`${lues.length} lignes lues, ${enregistrees.length} enregistrées`)
  }
  enregistrees.forEach((e, i) => {
    const l = lues[i]
    if (!l) {
      return
    }
    const ecarts = CHAMPS.filter((c) => (l[c] ?? null) !== (e[c] ?? null)).map((c) => `${c} « ${l[c] ?? ''} » au lieu de « ${e[c] ?? ''} »`)
    if (!memeMontant(l.montant_ttc, e.montant_ttc)) {
      ecarts.push(`montant ${l.montant_ttc} au lieu de ${e.montant_ttc}`)
    }
    if (ecarts.length) {
      differences.push(`${e.libelle} du ${e.debut} : ${ecarts.join(', ')}`)
    }
  })
  return differences
}

export async function comparer(extracteur: ClasseExtracteur, reglages: Reglages, facture: FactureAvecPdf): Promise<Comparaison> {
  try {
    const pdf = await (await fetch(api.pdfUrl(facture.id))).blob()
    const document = documentDe(await morceauxDuPdf(pdf), reglages)
    if (!reconnait(extracteur, document)) {
      return { facture, differences: ['PDF non reconnu par cette version'] }
    }
    const lue = extraire(extracteur, document)
    const { facture: enregistree, lignes } = await api.facture(facture.id)
    const differences = (['numero', 'date', 'total', 'lignes'] as const)
      .filter((c) => lue[c].erreur).map((c) => `${c} : ${lue[c].erreur}`)
    if (lue.numero.valeur !== enregistree.numero) {
      differences.push(`numéro ${lue.numero.valeur ?? '—'} au lieu de ${enregistree.numero}`)
    }
    if (lue.date.valeur !== enregistree.date_facture) {
      differences.push(`date ${lue.date.valeur ?? '—'} au lieu de ${enregistree.date_facture}`)
    }
    if (!memeMontant(lue.total.valeur, enregistree.montant_ttc)) {
      differences.push(`total ${lue.total.valeur ?? '—'} au lieu de ${enregistree.montant_ttc ?? '—'}`)
    }
    if (lue.lignes.valeur) {
      differences.push(...differencesDeLignes(lue.lignes.valeur, lignes))
      const somme = lue.lignes.valeur.reduce((t, l) => t.plus(l.montant_ttc || 0), new Big(0))
      if (lue.total.valeur && somme.minus(lue.total.valeur).abs().gt('0.05')) {
        differences.push(`somme des lignes ${somme.toFixed(2)} ≠ total ${lue.total.valeur}`)
      }
    }
    return { facture, differences }
  } catch (e) {
    return { facture, differences: [`lecture impossible : ${(e as Error).message}`] }
  }
}

import { api, type FactureAvecPdf } from '../api'
import { ecarts } from './comparaison'
import type { ClasseExtracteur, Reglages } from './contrat'
import { documentDe, extraire, reconnait } from './moteur'
import { morceauxDuPdf } from './navigateur'

// « Tester sur les factures » (ADR 0013): the version being edited reads again the PDF of an invoice of its supplier,
// compared with what is stored (comparaison.ts).

export type Comparaison = {
  invoice: FactureAvecPdf
  differences: string[]
  remarques: string[]
}

export async function comparer(extractor: ClasseExtracteur, settings: Reglages, invoice: FactureAvecPdf): Promise<Comparaison> {
  try {
    const pdf = await (await fetch(api.pdfUrl(invoice.id))).blob()
    const document = documentDe(await morceauxDuPdf(pdf), settings)
    if (!reconnait(extractor, document)) {
      return { invoice, differences: ['PDF non reconnu par cette version'], remarques: [] }
    }
    const lue = extraire(extractor, document)
    const { invoice: enregistree, lines } = await api.invoice(invoice.id)
    const erreurs = (['number', 'date', 'total', 'lines'] as const)
      .filter((c) => lue[c].erreur).map((c) => `${c} : ${lue[c].erreur}`)
    const { differences, remarques } = ecarts(
      { number: lue.number.valeur, date: lue.date.valeur, total: lue.total.valeur, lines: lue.lines.valeur ?? [] },
      { ...enregistree, lines },
    )
    return { invoice, differences: [...erreurs, ...differences], remarques }
  } catch (e) {
    return { invoice, differences: [`lecture impossible : ${(e as Error).message}`], remarques: [] }
  }
}

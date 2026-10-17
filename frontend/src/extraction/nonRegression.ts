import { api, type FactureAvecPdf } from '../api'
import { ecarts } from './comparaison'
import type { ClasseExtracteur, Reglages } from './contrat'
import { documentDe, extraire, reconnait } from './moteur'
import { morceauxDuPdf } from './navigateur'

// « Tester sur les factures » (ADR 0013): the version being edited reads again the PDF of an invoice of its supplier,
// compared with what is stored (comparaison.ts).

export type Comparaison = {
  facture: FactureAvecPdf
  differences: string[]
  remarques: string[]
}

export async function comparer(extracteur: ClasseExtracteur, reglages: Reglages, facture: FactureAvecPdf): Promise<Comparaison> {
  try {
    const pdf = await (await fetch(api.pdfUrl(facture.id))).blob()
    const document = documentDe(await morceauxDuPdf(pdf), reglages)
    if (!reconnait(extracteur, document)) {
      return { facture, differences: ['PDF non reconnu par cette version'], remarques: [] }
    }
    const lue = extraire(extracteur, document)
    const { facture: enregistree, lignes } = await api.facture(facture.id)
    const erreurs = (['numero', 'date', 'total', 'lignes'] as const)
      .filter((c) => lue[c].erreur).map((c) => `${c} : ${lue[c].erreur}`)
    const { differences, remarques } = ecarts(
      { numero: lue.numero.valeur, date: lue.date.valeur, total: lue.total.valeur, lignes: lue.lignes.valeur ?? [] },
      { ...enregistree, lignes },
    )
    return { facture, differences: [...erreurs, ...differences], remarques }
  } catch (e) {
    return { facture, differences: [`lecture impossible : ${(e as Error).message}`], remarques: [] }
  }
}

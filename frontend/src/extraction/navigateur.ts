import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

import type { Brouillon, ExtracteurEnregistre } from '../api'
import type { ClasseExtracteur, Morceau } from './contrat'
import { charger, documentDe, extraire, reconnait, type Extraction } from './moteur'
import { morceaux } from './pdf'

// Reading an invoice PDF in the browser (ADR 0013): pdf.js, then the last version of each supplier's extractor.

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export async function morceauxDuPdf(fichier: Blob): Promise<Morceau[][]> {
  const chargement = pdfjs.getDocument({ data: new Uint8Array(await fichier.arrayBuffer()), verbosity: 0 })
  try {
    return await morceaux(await chargement.promise)
  } finally {
    await chargement.destroy()
  }
}

export type Candidat = { enregistre: ExtracteurEnregistre, extracteur: ClasseExtracteur }

const charges = new Map<number, ClasseExtracteur>()

/** The class of the extractor of a stored version (its JavaScript, loaded once). */
export function extracteurDe(enregistre: ExtracteurEnregistre): ClasseExtracteur {
  let extracteur = charges.get(enregistre.id)
  if (!extracteur) {
    extracteur = charger(enregistre.code)
    charges.set(enregistre.id, extracteur)
  }
  return extracteur
}

/** The last versions that recognise the PDF; each one reads it with its own grouping settings. */
export function candidats(pages: Morceau[][], enregistres: ExtracteurEnregistre[]): Candidat[] {
  return enregistres.filter((e) => e.derniere).flatMap((enregistre) => {
    try {
      const extracteur = extracteurDe(enregistre)
      return reconnait(extracteur, documentDe(pages, enregistre.reglages)) ? [{ enregistre, extracteur }] : []
    } catch {
      // An extractor whose code does not load recognises nothing
      return []
    }
  })
}

export const lire = (pages: Morceau[][], { enregistre, extracteur }: Candidat): Extraction =>
  extraire(extracteur, documentDe(pages, enregistre.reglages))

/** The draft sent on import; null with the reason when the number or the date was not read. */
export function brouillonDe(extraction: Extraction, extracteurId: number): { brouillon: Brouillon | null, probleme: string | null } {
  const erreurs = (['numero', 'date', 'total', 'lignes'] as const)
    .filter((c) => extraction[c].erreur)
    .map((c) => `${c} : ${extraction[c].erreur}`)
  if (!extraction.numero.valeur || !extraction.date.valeur || extraction.lignes.erreur) {
    return { brouillon: null, probleme: erreurs.join(' ; ') || 'numéro ou date introuvable' }
  }
  return {
    brouillon: {
      extracteur_id: extracteurId,
      numero: extraction.numero.valeur,
      date_facture: extraction.date.valeur,
      montant_ttc: extraction.total.valeur,
      lignes: extraction.lignes.valeur ?? [],
    },
    probleme: null,
  }
}

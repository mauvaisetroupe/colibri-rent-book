import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

import { api, type Brouillon, type ExtracteurEnregistre, type Facture, type FactureDetail } from '../api'
import { binariser, pdfEnImages, REGLAGES_ANNEXE, type PageImage } from './annexe'
import { REGLAGES_PAR_DEFAUT, type ClasseExtracteur, type Morceau, type Reglages } from './contrat'
import { masquage, type PageLue, type Zone } from './masquage'
import { charger, documentDe, extraire, reconnait, type Extraction } from './moteur'
import {
  chargerReleve, documentReleve, extraireReleve, reconnaitReleve, type ClasseExtracteurReleve, type ExtractionReleve,
} from './moteurReleve'
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
  return enregistres.filter((e) => e.derniere && (e.type ?? 'facture') === 'facture').flatMap((enregistre) => {
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

// ---------------------------------------------------------------- bank statements (ADR 0018)

export type CandidatReleve = { enregistre: ExtracteurEnregistre, extracteur: ClasseExtracteurReleve }

const chargesReleve = new Map<number, ClasseExtracteurReleve>()

export function extracteurReleveDe(enregistre: ExtracteurEnregistre): ClasseExtracteurReleve {
  let extracteur = chargesReleve.get(enregistre.id)
  if (!extracteur) {
    extracteur = chargerReleve(enregistre.code)
    chargesReleve.set(enregistre.id, extracteur)
  }
  return extracteur
}

/** The last versions of the statement extractors that recognise the PDF. */
export function candidatsReleve(pages: Morceau[][], enregistres: ExtracteurEnregistre[]): CandidatReleve[] {
  return enregistres.filter((e) => e.derniere && e.type === 'releve').flatMap((enregistre) => {
    try {
      const extracteur = extracteurReleveDe(enregistre)
      return reconnaitReleve(extracteur, documentReleve(pages, enregistre.reglages)) ? [{ enregistre, extracteur }] : []
    } catch {
      return []
    }
  })
}

export const lireReleve = (pages: Morceau[][], { enregistre, extracteur }: CandidatReleve): ExtractionReleve =>
  extraireReleve(extracteur, documentReleve(pages, enregistre.reglages))

// ---------------------------------------------------------------- copy joined to a supporting document (ADR 0024)

/** The last version of the invoice extractor of a supplier, if it has one. */
const extracteurDuFournisseur = (fournisseur: string, enregistres: ExtracteurEnregistre[]) =>
  enregistres.find((e) => e.derniere && (e.type ?? 'facture') === 'facture' && e.fournisseur === fournisseur) ?? null

/** Each page drawn by pdf.js, its zones painted black, in black and white. */
async function pagesEnImages(pdf: pdfjs.PDFDocumentProxy, zones: Zone[]): Promise<PageImage[]> {
  const { dpi, seuil } = REGLAGES_ANNEXE
  const images: PageImage[] = []
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n)
    const taille = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: dpi / 72 })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const contexte = canvas.getContext('2d', { willReadFrequently: true })!
    contexte.fillStyle = '#fff'
    contexte.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvas, canvasContext: contexte, viewport }).promise
    contexte.fillStyle = '#000'
    for (const z of zones.filter((z) => z.page === n)) {
      contexte.fillRect(z.x0 * canvas.width, z.y0 * canvas.height, (z.x1 - z.x0) * canvas.width, (z.y1 - z.y0) * canvas.height)
    }
    const { data } = contexte.getImageData(0, 0, canvas.width, canvas.height)
    images.push({
      largeur: taille.width, hauteur: taille.height, largeurPx: canvas.width, hauteurPx: canvas.height,
      bits: binariser(data, canvas.width, canvas.height, seuil),
    })
    canvas.width = canvas.height = 0
    page.cleanup()
  }
  return images
}

/**
 * The copy of a PDF joined to the supporting documents: the masked terms and the redactions of an extractor (with its
 * grouping settings) found in its text, every page in images, the zones painted black.
 */
export async function copieEnImages(
  contenu: Uint8Array, termes: string[], extracteur: { classe: ClasseExtracteur, reglages: Reglages } | null,
): Promise<{ pdf: Uint8Array, zones: Zone[] }> {
  const chargement = pdfjs.getDocument({ data: contenu, verbosity: 0 })
  try {
    const pdf = await chargement.promise
    const pieces = await morceaux(pdf)
    const pages: PageLue[] = []
    for (let n = 1; n <= pdf.numPages; n++) {
      const { width, height } = (await pdf.getPage(n)).getViewport({ scale: 1 })
      pages.push({ largeur: width, hauteur: height, morceaux: pieces[n - 1] ?? [] })
    }
    const zones = masquage(pages, extracteur?.reglages ?? REGLAGES_PAR_DEFAUT, termes, extracteur?.classe ?? null)
    return { pdf: await pdfEnImages(await pagesEnImages(pdf, zones)), zones }
  } finally {
    await chargement.destroy()
  }
}

/**
 * Makes the copy of an invoice joined to the supporting documents and sends it, to be verified: the masked terms and
 * the redactions of the last extractor of its supplier. `donnees`: the terms and the extractors, when several invoices
 * are made at once.
 */
export async function preparerAnnexe(
  facture: Pick<Facture, 'id' | 'fournisseur'>,
  donnees?: { termes: string[], extracteurs: ExtracteurEnregistre[] },
): Promise<FactureDetail> {
  const [termes, extracteurs] = donnees ? [donnees.termes, donnees.extracteurs] : await Promise.all([api.termesMasques(), api.extracteurs()])
  const enregistre = extracteurDuFournisseur(facture.fournisseur, extracteurs)
  const contenu = new Uint8Array(await (await (await fetch(api.pdfUrl(facture.id))).blob()).arrayBuffer())
  const { pdf, zones } = await copieEnImages(contenu, termes,
    enregistre ? { classe: extracteurDe(enregistre), reglages: enregistre.reglages } : null)
  return api.envoyerAnnexe(facture.id, pdf, { zones, extracteur_id: enregistre?.id ?? null, termes, reglages: REGLAGES_ANNEXE })
}

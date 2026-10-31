import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

import { api, type Brouillon, type ExtracteurEnregistre, type Facture, type FactureDetail } from '../api'
import { binariser, pdfEnImages, REGLAGES_ANNEXE, type PageImage } from './annexe'
import { REGLAGES_PAR_DEFAUT, type ClasseExtracteur, type Morceau, type Reglages } from './contrat'
import { masquage, type PageLue, type Zone, type ZoneSaisie } from './masquage'
import { charger, documentDe, extraire, reconnait, type Extraction } from './moteur'
import {
  chargerReleve, documentReleve, extraireReleve, reconnaitReleve, type ClasseExtracteurReleve, type ExtractionReleve,
} from './moteurReleve'
import { estScannee, morceaux } from './pdf'

// Reading an invoice PDF in the browser (ADR 0013): pdf.js, then the last version of each supplier's extractor.

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/** Opening a PDF: its decoders of images in WebAssembly (the scans), else their images are left out (vite.config.ts). */
const ouvrir = (data: Uint8Array) => pdfjs.getDocument({ data, verbosity: 0, wasmUrl: __PDFJS_WASM__ })

export async function morceauxDuPdf(fichier: Blob): Promise<Morceau[][]> {
  const chargement = ouvrir(new Uint8Array(await fichier.arrayBuffer()))
  try {
    return await morceaux(await chargement.promise)
  } finally {
    await chargement.destroy()
  }
}

export type Candidat = { enregistre: ExtracteurEnregistre, extractor: ClasseExtracteur }

const charges = new Map<number, ClasseExtracteur>()

/** The class of the extractor of a stored version (its JavaScript, loaded once). */
export function extracteurDe(enregistre: ExtracteurEnregistre): ClasseExtracteur {
  let extractor = charges.get(enregistre.id)
  if (!extractor) {
    extractor = charger(enregistre.code)
    charges.set(enregistre.id, extractor)
  }
  return extractor
}

/** The last versions that recognise the PDF; each one reads it with its own grouping settings. */
export function candidats(pages: Morceau[][], enregistres: ExtracteurEnregistre[]): Candidat[] {
  return enregistres.filter((e) => e.latest && (e.type ?? 'invoice') === 'invoice').flatMap((enregistre) => {
    try {
      const extractor = extracteurDe(enregistre)
      return reconnait(extractor, documentDe(pages, enregistre.settings)) ? [{ enregistre, extractor }] : []
    } catch {
      // An extractor whose code does not load recognises nothing
      return []
    }
  })
}

export const lire = (pages: Morceau[][], { enregistre, extractor }: Candidat): Extraction =>
  extraire(extractor, documentDe(pages, enregistre.settings))

/** The draft sent on import; null with the reason when the number or the date was not read. */
export function brouillonDe(extraction: Extraction, extracteurId: number): { brouillon: Brouillon | null, probleme: string | null } {
  const erreurs = (['number', 'date', 'total', 'lines'] as const)
    .filter((c) => extraction[c].erreur)
    .map((c) => `${c} : ${extraction[c].erreur}`)
  if (!extraction.number.valeur || !extraction.date.valeur || extraction.lines.erreur) {
    return { brouillon: null, probleme: erreurs.join(' ; ') || 'numéro ou date introuvable' }
  }
  return {
    brouillon: {
      extractor_id: extracteurId,
      number: extraction.number.valeur,
      invoice_date: extraction.date.valeur,
      total_incl_tax: extraction.total.valeur,
      lines: extraction.lines.valeur ?? [],
    },
    probleme: null,
  }
}

// ---------------------------------------------------------------- bank statements (ADR 0018)

export type CandidatReleve = { enregistre: ExtracteurEnregistre, extractor: ClasseExtracteurReleve }

const chargesReleve = new Map<number, ClasseExtracteurReleve>()

export function extracteurReleveDe(enregistre: ExtracteurEnregistre): ClasseExtracteurReleve {
  let extractor = chargesReleve.get(enregistre.id)
  if (!extractor) {
    extractor = chargerReleve(enregistre.code)
    chargesReleve.set(enregistre.id, extractor)
  }
  return extractor
}

/** The last versions of the statement extractors that recognise the PDF. */
export function candidatsReleve(pages: Morceau[][], enregistres: ExtracteurEnregistre[]): CandidatReleve[] {
  return enregistres.filter((e) => e.latest && e.type === 'bank_statement').flatMap((enregistre) => {
    try {
      const extractor = extracteurReleveDe(enregistre)
      return reconnaitReleve(extractor, documentReleve(pages, enregistre.settings)) ? [{ enregistre, extractor }] : []
    } catch {
      return []
    }
  })
}

export const lireReleve = (pages: Morceau[][], { enregistre, extractor }: CandidatReleve): ExtractionReleve =>
  extraireReleve(extractor, documentReleve(pages, enregistre.settings))

// ---------------------------------------------------------------- copy joined to a supporting document (ADR 0024)

/** The last version of the invoice extractor of a supplier, if it has one. */
const extracteurDuFournisseur = (supplier: string, enregistres: ExtracteurEnregistre[]) =>
  enregistres.find((e) => e.latest && (e.type ?? 'invoice') === 'invoice' && e.supplier === supplier) ?? null

/** Each page drawn by pdf.js, its zones painted black, in black and white. */
async function pagesEnImages(pdf: pdfjs.PDFDocumentProxy, zones: Zone[]): Promise<PageImage[]> {
  const { dpi, threshold } = REGLAGES_ANNEXE
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
      bits: binariser(data, canvas.width, canvas.height, threshold),
    })
    canvas.width = canvas.height = 0
    page.cleanup()
  }
  return images
}

/** The numbers (from 1) of the scanned pages of a PDF: their text is not trusted, zones drawn by hand mask them. */
async function scanneesDe(pdf: pdfjs.PDFDocumentProxy): Promise<number[]> {
  const scannees: number[] = []
  for (let n = 1; n <= pdf.numPages; n++) {
    if (await estScannee(await pdf.getPage(n), pdfjs.OPS)) {
      scannees.push(n)
    }
  }
  return scannees
}

/** Zones drawn by hand for the scans of an invoice: its own (`main`), or else those of its supplier (`modele`). */
export type ZonesDesScans = { zones: ZoneSaisie[], origin: 'template' | 'manual' }

type ExtracteurLu = { classe: ClasseExtracteur, settings: Reglages }

/** The zones of an open PDF (see `masquage`), and its scanned pages. */
async function zonesDu(pdf: pdfjs.PDFDocumentProxy, terms: string[], extractor: ExtracteurLu | null, scans: ZonesDesScans) {
  const pieces = await morceaux(pdf)
  const pages: PageLue[] = []
  for (let n = 1; n <= pdf.numPages; n++) {
    const { width, height } = (await pdf.getPage(n)).getViewport({ scale: 1 })
    pages.push({ largeur: width, hauteur: height, morceaux: pieces[n - 1] ?? [] })
  }
  const scannees = await scanneesDe(pdf)
  const zones = masquage(pages, extractor?.settings ?? REGLAGES_PAR_DEFAUT, terms, extractor?.classe ?? null,
    { pages: scannees, ...scans })
  return { zones, scannees }
}

/**
 * The copy of a PDF joined to the supporting documents: on its pages of text, the masked terms and the redactions of
 * an extractor (with its grouping settings) found in its text, but not on its scanned pages; on every page, the zones
 * drawn by hand. Every page in images, the zones painted black.
 */
export async function copieEnImages(
  contenu: Uint8Array, terms: string[], extractor: ExtracteurLu | null,
  scans: ZonesDesScans = { zones: [], origin: 'template' },
): Promise<{ pdf: Uint8Array, zones: Zone[], scannees: number[] }> {
  const chargement = ouvrir(contenu)
  try {
    const pdf = await chargement.promise
    const { zones, scannees } = await zonesDu(pdf, terms, extractor, scans)
    return { pdf: await pdfEnImages(await pagesEnImages(pdf, zones)), zones, scannees }
  } finally {
    await chargement.destroy()
  }
}

/**
 * Makes the copy of an invoice joined to the supporting documents and sends it, to be verified: the masked terms and
 * the redactions of the last extractor of its supplier, the zones drawn by hand (its own, else those of its supplier).
 * `donnees`: the terms, the extractors and the zones of the supplier, when several invoices are made at once.
 */
export async function preparerAnnexe(
  invoice: Pick<Facture, 'id' | 'supplier' | 'supplier_id' | 'masked_zones'>,
  donnees?: { terms: string[], extractors: ExtracteurEnregistre[], modele: ZoneSaisie[] },
): Promise<FactureDetail> {
  const [terms, extractors, modele] = donnees
    ? [donnees.terms, donnees.extractors, donnees.modele]
    : await Promise.all([api.termesMasques(), api.extractors(),
      api.supplier(invoice.supplier_id).then((f) => f.masked_zones)])
  const enregistre = extracteurDuFournisseur(invoice.supplier, extractors)
  const contenu = new Uint8Array(await (await (await fetch(api.pdfUrl(invoice.id))).blob()).arrayBuffer())
  const { pdf, zones, scannees } = await copieEnImages(contenu, terms,
    enregistre ? { classe: extracteurDe(enregistre), settings: enregistre.settings } : null,
    invoice.masked_zones ? { zones: invoice.masked_zones, origin: 'manual' } : { zones: modele, origin: 'template' })
  return api.envoyerAnnexe(invoice.id, pdf, {
    zones, extractor_id: enregistre?.id ?? null, terms, settings: REGLAGES_ANNEXE, scanned_pages: scannees,
  })
}

/**
 * What the masked terms and the last extractor of a supplier mask on a PDF, without the zones drawn by hand: shown in
 * the editor of zones, where there is no need to draw them again.
 */
export async function zonesAutomatiques(contenu: Uint8Array, supplier: string): Promise<Zone[]> {
  const [terms, extractors] = await Promise.all([api.termesMasques(), api.extractors()])
  const enregistre = extracteurDuFournisseur(supplier, extractors)
  const chargement = ouvrir(contenu)
  try {
    return (await zonesDu(await chargement.promise, terms,
      enregistre ? { classe: extracteurDe(enregistre), settings: enregistre.settings } : null, { zones: [], origin: 'template' })).zones
  } finally {
    await chargement.destroy()
  }
}

/** A page drawn for the editor of zones: its image, its size in points, whether it is a scan (ADR 0025). */
export type ApercuPage = { url: string, largeur: number, hauteur: number, scannee: boolean }

/** The pages of a PDF drawn `largeurPx` wide, in colour as received, to draw zones on. */
export async function apercuPages(contenu: Uint8Array, largeurPx: number): Promise<ApercuPage[]> {
  const chargement = ouvrir(contenu)
  try {
    const pdf = await chargement.promise
    const scannees = await scanneesDe(pdf)
    const pages: ApercuPage[] = []
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n)
      const taille = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: (largeurPx * window.devicePixelRatio) / taille.width })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      const contexte = canvas.getContext('2d')!
      contexte.fillStyle = '#fff'
      contexte.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvas, canvasContext: contexte, viewport }).promise
      const url = URL.createObjectURL(await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('page non dessinée'))), 'image/png')))
      pages.push({ url, largeur: taille.width, hauteur: taille.height, scannee: scannees.includes(n) })
      canvas.width = canvas.height = 0
      page.cleanup()
    }
    return pages
  } finally {
    await chargement.destroy()
  }
}

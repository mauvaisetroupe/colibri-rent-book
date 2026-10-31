import type { ClasseExtracteur, Document, Morceau, Reglages } from './contrat'
import type { Redaction } from './extractor'
import { documentDe } from './moteur'
import { lignesAvecMorceaux, type Portion } from './regroupement'

// What to mask on the copy of an invoice joined to a supporting document (ADR 0024): the terms masked on every invoice
// and the redactions of the extractor of its supplier, found in the lines of text of pdf.js, become rectangles in
// fractions of the page. Zones drawn by hand (ADR 0025), those of the invoice or else those of its supplier, are added on
// every page; a scanned page is not searched, its text read by the scanner is not trusted: only they mask it. Only
// rectangles leave the browser; the copy in images is painted from them (annexe.ts).

/** A page as pdf.js gives it: its size in points and its pieces of text. */
export type PageLue = { largeur: number, hauteur: number, morceaux: Morceau[] }

/** Where a zone comes from: found in the text, or drawn by hand (the model of the supplier, the invoice). */
export type Origin = 'terms' | 'extractor' | 'template' | 'manual'

/** A zone drawn by hand (ADR 0025): page from 1, bounds in fractions of the page from its top-left. */
export type ZoneSaisie = { page: number, x0: number, y0: number, x1: number, y1: number }

/** A rectangle painted black, in fractions of the page from its top-left corner; page 1 is the first one. */
export type Zone = { page: number, x0: number, y0: number, x1: number, y1: number, origin: Origin }

// Points added around a text found, so that no stroke of a letter is left
const MARGE = 1
// Below the baseline: the descenders (p, g, comma)
const DESCENTE = 0.3
// pdf.js gives no height for some pieces: a common font size
const HAUTEUR_MINIMALE = 6

/** A text without its spaces and in lower case, with where each of its characters is in the text. */
function compacter(text: string): { compact: string, positions: number[] } {
  let compact = ''
  const positions: number[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (!/\s/.test(c)) {
      compact += c.toLowerCase()[0]
      positions.push(i)
    }
  }
  return { compact, positions }
}

/** Spans [debut, fin[ of a line where a text is, spaces and case ignored. */
function occurrences(ligne: string, text: string): [number, number][] {
  const cherche = compacter(text).compact
  if (!cherche) {
    return []
  }
  const { compact, positions } = compacter(ligne)
  const trouvees: [number, number][] = []
  for (let i = compact.indexOf(cherche); i >= 0; i = compact.indexOf(cherche, i + cherche.length)) {
    trouvees.push([positions[i]!, positions[i + cherche.length - 1]! + 1])
  }
  return trouvees
}

/** Spans of a line where a regular expression matches (every match, even without the « g » flag). */
function correspondances(ligne: string, motif: RegExp): [number, number][] {
  const global = new RegExp(motif.source, motif.flags.includes('g') ? motif.flags : `${motif.flags}g`)
  return [...ligne.matchAll(global)].filter((m) => m[0].length).map((m) => [m.index, m.index + m[0].length])
}

/** The rectangle covering the characters [debut, fin[ of a line, in points. */
function rectangle(portions: Portion[], start: number, end: number) {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const { morceau: m, start: d, end: f } of portions) {
    if (f <= start || d >= end) {
      continue
    }
    // A piece partly covered: its width shared out among its characters. pdf.js gives no position per character and
    // their widths differ: a bound inside the piece is only an estimate, widened by one character
    const parCaractere = m.largeur / Math.max(1, f - d)
    const hauteur = Math.max(m.hauteur, HAUTEUR_MINIMALE)
    x0 = Math.min(x0, start <= d ? m.x : m.x + parCaractere * (start - d - 1))
    x1 = Math.max(x1, end >= f ? m.x + m.largeur : m.x + parCaractere * (end - d + 1))
    y0 = Math.min(y0, m.y - hauteur)
    y1 = Math.max(y1, m.y + hauteur * DESCENTE)
  }
  return x0 <= x1 ? { x0: x0 - MARGE, y0: y0 - MARGE, x1: x1 + MARGE, y1: y1 + MARGE } : null
}

const borner = (v: number) => Math.min(1, Math.max(0, v))

/** The zones of a page where texts or regular expressions are found. */
function zonesDuTexte(page: PageLue, number: number, settings: Reglages, cherches: { regle: Redaction, origin: Origin }[]): Zone[] {
  const zones: Zone[] = []
  for (const { text, portions } of lignesAvecMorceaux(page.morceaux, settings)) {
    for (const { regle, origin } of cherches) {
      const spans = 'text' in regle ? occurrences(text, regle.text) : 'pattern' in regle ? correspondances(text, regle.pattern) : []
      for (const [start, end] of spans) {
        const r = rectangle(portions, start, end)
        if (r) {
          zones.push({
            page: number, origin,
            x0: borner(r.x0 / page.largeur), y0: borner(r.y0 / page.hauteur),
            x1: borner(r.x1 / page.largeur), y1: borner(r.y1 / page.hauteur),
          })
        }
      }
    }
  }
  return zones
}

/**
 * The zones to paint on the pages of text of an invoice: every occurrence of the masked terms, and the redactions of
 * the extractor (texts, regular expressions). The scanned pages (numbers from 1) are left out. An error of the
 * extractor is thrown: nothing is masked half.
 */
export function zonesAMasquer(
  pages: PageLue[], settings: Reglages, terms: string[], regles: Redaction[] = [], scannees: number[] = [],
): Zone[] {
  const cherches = [
    ...terms.map((t) => ({ regle: { text: t } as Redaction, origin: 'terms' as const })),
    ...regles.filter((r) => 'text' in r || 'pattern' in r).map((regle) => ({ regle, origin: 'extractor' as const })),
  ]
  return pages.flatMap((page, i) => (scannees.includes(i + 1) ? [] : zonesDuTexte(page, i + 1, settings, cherches)))
}

/** The zones drawn by hand, on any page: a scan, or a page of text where the terms and the extractor miss something. */
export const zonesTracees = (zones: ZoneSaisie[], origin: 'template' | 'manual'): Zone[] =>
  zones.map(({ page, x0, y0, x1, y1 }) => ({ page, x0, y0, x1, y1, origin }))

/** The redactions of an extractor for a document (the text of a PDF grouped with its settings). */
export function reglesDuDocument(classe: ClasseExtracteur, document: Document): Redaction[] {
  const regles = new classe(document).redactions()
  if (!Array.isArray(regles)) {
    throw new Error('redactions : une liste attendue')
  }
  return regles
}

/** The redactions of an extractor for this PDF, read with its own grouping settings. */
export const reglesDe = (classe: ClasseExtracteur, pages: PageLue[], settings: Reglages): Redaction[] =>
  reglesDuDocument(classe, documentDe(pages.map((p) => p.morceaux), settings))

/** A part of a line of text, masked (and why) or not: the editor shows what the copy hides. */
export type SegmentMasque = { text: string, origin: Origin | null }

/** Each line cut where a masked term or a redaction of the extractor (text, regular expression) is found. */
export function lignesMasquees(lines: string[], terms: string[], regles: Redaction[]): SegmentMasque[][] {
  const cherches = [
    ...terms.map((t) => ({ regle: { text: t } as Redaction, origin: 'terms' as const })),
    ...regles.filter((r) => 'text' in r || 'pattern' in r).map((regle) => ({ regle, origin: 'extractor' as const })),
  ]
  return lines.map((ligne) => {
    const marques = new Array<Origin | null>(ligne.length).fill(null)
    for (const { regle, origin } of cherches) {
      const spans = 'text' in regle ? occurrences(ligne, regle.text) : 'pattern' in regle ? correspondances(ligne, regle.pattern) : []
      for (const [start, end] of spans) {
        // The extractor wins over the terms where both match
        marques.fill(origin, start, end)
      }
    }
    const segments: SegmentMasque[] = []
    for (let k = 0; k < ligne.length; k++) {
      const last = segments.at(-1)
      if (last && last.origin === marques[k]) {
        last.text += ligne[k]
      } else {
        segments.push({ text: ligne[k]!, origin: marques[k]! })
      }
    }
    return segments
  })
}

/**
 * The zones of an invoice: on its pages of text, the masked terms and the redactions of its extractor when there is
 * one; on every page, the zones drawn by hand (`scans.zones`: those of the invoice, `main`, or of its supplier), the only
 * ones on its scanned pages (`scans.pages`).
 */
export function masquage(
  pages: PageLue[], settings: Reglages, terms: string[], classe: ClasseExtracteur | null = null,
  scans: { pages: number[], zones: ZoneSaisie[], origin: 'template' | 'manual' } = { pages: [], zones: [], origin: 'template' },
): Zone[] {
  return [
    ...zonesAMasquer(pages, settings, terms, classe ? reglesDe(classe, pages, settings) : [], scans.pages),
    ...zonesTracees(scans.zones.filter((z) => z.page <= pages.length), scans.origin),
  ]
}

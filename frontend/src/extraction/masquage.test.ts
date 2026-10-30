import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { PDFDocument, setTextRenderingMode, StandardFonts, TextRenderingMode } from 'pdf-lib'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import ts from 'typescript'

import { binariser, pdfEnImages } from './annexe'
import { compiler } from './compilation'
import { REGLAGES_PAR_DEFAUT } from './contrat'
import { lignesMasquees, masquage } from './masquage'
import { charger } from './moteur'
import { estScannee, morceaux } from './pdf'

// The copy of an invoice joined to a supporting document (ADR 0024), on a made-up invoice: where the masked terms and
// the redactions of an extractor are, and the PDF in images, where no text is left. A scanned page (ADR 0025): told
// apart, its text not searched, masked by the zones drawn by hand.

const LARGEUR = 595
const HAUTEUR = 842

/** A one-page PDF: each row is [x, text] pieces on a line, from the top, in 10-point Helvetica. */
async function facture(lignes: [number, string][][]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([LARGEUR, HAUTEUR])
  const police = await pdf.embedFont(StandardFonts.Helvetica)
  lignes.forEach((ligne, i) => {
    for (const [x, texte] of ligne) {
      page.drawText(texte, { x, y: 800 - i * 16, size: 10, font: police })
    }
  })
  return pdf.save()
}

async function pagesDe(contenu: Uint8Array) {
  const pdf = await getDocument({ data: contenu, verbosity: 0 }).promise
  const pages = await morceaux(pdf)
  return pages.map((m) => ({ largeur: LARGEUR, hauteur: HAUTEUR, morceaux: m }))
}

const FACTURE: [number, string][][] = [
  [[40, 'NOM DU FOURNISSEUR'], [350, 'MME EXEMPLE CLAIRE']],
  [[350, '12 RUE DES EXEMPLES']],
  [[40, 'Référence client : 123 456 789'], [350, '99999 VILLE']],
  [[40, 'Total TTC'], [450, '150,50 €']],
]

const EXTRACTEUR = `
import { InvoiceExtractor, type Redaction } from 'extractor'
export default class Exemple extends InvoiceExtractor {
  readonly energy = 'eau'
  recognizes() { return true }
  invoiceNumber() { return null }
  invoiceDate() { return null }
  total() { return null }
  findLine() { return null }
  readLine() { return null }
  redactions(): Redaction[] {
    return [{ pattern: /Référence client : ([\\d ]+)/ }]
  }
}`

describe('zones to mask', () => {
  test('a term is found with its spaces and case ignored, on its line only', async () => {
    const pages = await pagesDe(await facture(FACTURE))
    const zones = masquage(pages, REGLAGES_PAR_DEFAUT, ['Mme Exemple', '12 RUE DES EXEMPLES', 'absent'])
    assert.equal(zones.length, 2)
    const [nom, rue] = zones
    assert.equal(nom!.origine, 'termes')
    // « MME EXEMPLE » starts at x = 350 and is shorter than its piece (« MME EXEMPLE CLAIRE »)
    assert.ok(Math.abs(nom!.x0 * LARGEUR - 349) < 1, String(nom!.x0 * LARGEUR))
    assert.ok(nom!.x1 * LARGEUR < 350 + 100, 'not the whole piece')
    // First line: baseline at 842 - 800 = 42 points from the top
    assert.ok(nom!.y0 * HAUTEUR < 42 - 9 && nom!.y1 * HAUTEUR > 42, `${nom!.y0 * HAUTEUR} ${nom!.y1 * HAUTEUR}`)
    assert.ok(rue!.y0 > nom!.y1 - 0.01, 'second line below')
  })

  test('the redactions of an extractor: a regular expression', async () => {
    const classe = charger(compiler(EXTRACTEUR, ts))
    const pages = await pagesDe(await facture(FACTURE))
    const zones = masquage(pages, REGLAGES_PAR_DEFAUT, [], classe)
    assert.deepEqual(zones.map((z) => z.origine), ['extracteur'])
    assert.ok(zones[0]!.x0 * LARGEUR < 41 && zones[0]!.x1 * LARGEUR > 150, 'the whole match')
  })

  test('a scanned page: its text is not searched, the zones drawn by hand mask it', async () => {
    const classe = charger(compiler(EXTRACTEUR, ts))
    const pages = await pagesDe(await facture(FACTURE))
    const dessinees = [{ page: 1, x0: 0.5, y0: 0.05, x1: 0.95, y1: 0.12 }, { page: 2, x0: 0, y0: 0, x1: 1, y1: 1 }]
    assert.deepEqual(masquage(pages, REGLAGES_PAR_DEFAUT, ['MME EXEMPLE'], classe, { pages: [1], zones: dessinees, origine: 'main' }),
      [{ page: 1, x0: 0.5, y0: 0.05, x1: 0.95, y1: 0.12, origine: 'main' }], 'neither the terms nor the extractor, no page 2')
  })

  test('a page of text: the zones drawn by hand are added to the terms and the extractor', async () => {
    const classe = charger(compiler(EXTRACTEUR, ts))
    const pages = await pagesDe(await facture(FACTURE))
    const zones = masquage(pages, REGLAGES_PAR_DEFAUT, ['MME EXEMPLE'], classe,
      { pages: [], zones: [{ page: 1, x0: 0.1, y0: 0.8, x1: 0.3, y1: 0.95 }], origine: 'modele' })
    assert.deepEqual(zones.map((z) => z.origine).sort(), ['extracteur', 'modele', 'termes'])
  })
})

describe('scanned pages', () => {
  /** Page 1: an image of the whole page under invisible text, as a scanner makes it; page 2: visible text. */
  async function scanPuisTexte(): Promise<Uint8Array> {
    const bits = new Uint8Array(Math.ceil(100 / 8) * 140).fill(0xff)
    const pdf = await PDFDocument.load(await pdfEnImages([{ largeur: LARGEUR, hauteur: HAUTEUR, largeurPx: 100, hauteurPx: 140, bits }]))
    const police = await pdf.embedFont(StandardFonts.Helvetica)
    const scan = pdf.getPage(0)
    scan.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible))
    scan.drawText('MME EXEMPLE CLAIRE', { x: 350, y: 800, size: 10, font: police })
    pdf.addPage([LARGEUR, HAUTEUR]).drawText('Total TTC', { x: 40, y: 800, size: 10, font: police })
    return pdf.save()
  }

  test('a page covered by an image whose text is invisible is a scan, not a page of text', async () => {
    const pdf = await getDocument({ data: await scanPuisTexte(), verbosity: 0 }).promise
    assert.deepEqual([await estScannee(await pdf.getPage(1), OPS), await estScannee(await pdf.getPage(2), OPS)], [true, false])
  })
})

describe('copy in images', () => {
  test('black and white, 1 bit per pixel, rows padded to a byte', () => {
    // 10 × 2 pixels: first row white then black, second row grey under and over the threshold
    const rgba = new Uint8ClampedArray(10 * 2 * 4)
    for (let x = 0; x < 10; x++) {
      const v = x < 5 ? 255 : 0
      rgba.set([v, v, v, 255], x * 4)
      rgba.set(x % 2 ? [180, 180, 180, 255] : [160, 160, 160, 255], (10 + x) * 4)
    }
    assert.deepEqual([...binariser(rgba, 10, 2, 170)], [0b11111000, 0b00000000, 0b01010101, 0b01000000])
  })

  test('a PDF of images only: same pages, no text left', async () => {
    const bits = new Uint8Array(Math.ceil(100 / 8) * 140).fill(0xff)
    const contenu = await pdfEnImages([
      { largeur: LARGEUR, hauteur: HAUTEUR, largeurPx: 100, hauteurPx: 140, bits },
      { largeur: LARGEUR, hauteur: HAUTEUR, largeurPx: 100, hauteurPx: 140, bits },
    ])
    const pdf = await getDocument({ data: contenu, verbosity: 0 }).promise
    assert.equal(pdf.numPages, 2)
    const page = await pdf.getPage(1)
    assert.deepEqual(page.getViewport({ scale: 1 }).viewBox, [0, 0, LARGEUR, HAUTEUR])
    assert.equal((await page.getTextContent()).items.length, 0)
    const { info } = await pdf.getMetadata() as { info: Record<string, unknown> }
    assert.equal(info.Producer, undefined, 'no metadata')
  })
})

describe('what the editor shows masked', () => {
  test('a line cut where a term or a redaction is, the extractor over the terms', () => {
    const lignes = ['Référence client : 123 456 789', 'Rien ici']
    const [premiere, seconde] = lignesMasquees(lignes, ['client'], [{ pattern: /\d[\d ]+/ }])
    assert.deepEqual(premiere, [
      { texte: 'Référence ', origine: null },
      { texte: 'client', origine: 'termes' },
      { texte: ' : ', origine: null },
      { texte: '123 456 789', origine: 'extracteur' },
    ])
    assert.deepEqual(seconde, [{ texte: 'Rien ici', origine: null }])
  })
})

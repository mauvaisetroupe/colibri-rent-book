import type { Morceau } from './contrat'

// Pieces of text of each page of a PDF opened with pdf.js. The caller opens the document: the browser with
// `pdfjs-dist` and its worker, the tests in Node with `pdfjs-dist/legacy`, same version (package-lock, ADR 0013).

type TextItem = { str: string, transform: number[], width: number, height: number }

export type PdfDocument = {
  numPages: number
  getPage: (n: number) => Promise<{
    getViewport: (options: { scale: number }) => { height: number }
    getTextContent: () => Promise<{ items: unknown[] }>
  }>
}

export async function morceaux(pdf: PdfDocument): Promise<Morceau[][]> {
  const pages: Morceau[][] = []
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n)
    const { height } = page.getViewport({ scale: 1 })
    const { items } = await page.getTextContent()
    pages.push((items as TextItem[]).filter((i) => typeof i.str === 'string' && i.transform).map((i) => ({
      text: i.str,
      x: i.transform[4]!,
      // pdf.js counts from the bottom of the page
      y: height - i.transform[5]!,
      largeur: i.width,
      hauteur: i.height,
    })))
  }
  return pages
}

// ---------------------------------------------------------------- scanned pages (ADR 0025)

/** The operators of pdf.js that tell a scan (its `OPS`, given by the caller as pdf.js is). */
export type Operateurs = Record<'save' | 'restore' | 'transform' | 'paintFormXObjectBegin' | 'paintFormXObjectEnd'
  | 'paintImageXObject' | 'paintInlineImageXObject' | 'setTextRenderingMode' | 'showText' | 'showSpacedText'
  | 'nextLineShowText' | 'nextLineSetSpacingShowText', number>

export type PageOperateurs = {
  view: number[]
  getOperatorList: () => Promise<{ fnArray: number[], argsArray: unknown[] }>
}

// An image covering this share of the page makes it a scan
const COUVERTURE_SCAN = 0.85
// Text rendering modes that draw nothing: invisible (3), clip only (7)
const INVISIBLE = [3, 7]

type Matrice = [number, number, number, number, number, number]

/** m then c, as the operator « cm » does (m × c). */
const produit = (m: Matrice, c: Matrice): Matrice => [
  m[0] * c[0] + m[1] * c[2], m[0] * c[1] + m[1] * c[3],
  m[2] * c[0] + m[3] * c[2], m[2] * c[1] + m[3] * c[3],
  m[4] * c[0] + m[5] * c[2] + c[4], m[4] * c[1] + m[5] * c[3] + c[5],
]

/**
 * A scanned page: an image covers it and its text, if any, is invisible (what a scanner reads and lays under the
 * image). Its text is not trusted: only zones drawn by hand are masked on it.
 */
export async function estScannee(page: PageOperateurs, OPS: Operateurs): Promise<boolean> {
  const { fnArray, argsArray } = await page.getOperatorList()
  const [vx0 = 0, vy0 = 0, vx1 = 0, vy1 = 0] = page.view
  const surface = Math.abs((vx1 - vx0) * (vy1 - vy0))
  let ctm: Matrice = [1, 0, 0, 1, 0, 0]
  let method = 0
  const pile: { ctm: Matrice, method: number }[] = []
  let image = false
  let texteVisible = false
  fnArray.forEach((fn, i) => {
    const args = argsArray[i] as unknown[] | null
    if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) {
      pile.push({ ctm, method })
      const matrice = fn === OPS.save ? null : args?.[0] as Matrice | null
      if (matrice) {
        ctm = produit(matrice, ctm)
      }
    } else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) {
      ({ ctm, method } = pile.pop() ?? { ctm, method })
    } else if (fn === OPS.transform) {
      ctm = produit(args as unknown as Matrice, ctm)
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      // An image fills the unit square: its area on the page is the determinant of the matrix
      image ||= Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]) >= COUVERTURE_SCAN * surface
    } else if (fn === OPS.setTextRenderingMode) {
      method = Number(args?.[0])
    } else if ([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText].includes(fn)) {
      texteVisible ||= !INVISIBLE.includes(method)
    }
  })
  return image && !texteVisible
}

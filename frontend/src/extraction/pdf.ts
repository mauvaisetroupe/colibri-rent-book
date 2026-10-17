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
      texte: i.str,
      x: i.transform[4]!,
      // pdf.js counts from the bottom of the page
      y: height - i.transform[5]!,
      largeur: i.width,
      hauteur: i.height,
    })))
  }
  return pages
}

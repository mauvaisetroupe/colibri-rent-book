import { concatTransformationMatrix, drawObject, PDFDocument, popGraphicsState, pushGraphicsState } from 'pdf-lib'

// The copy of an invoice joined to a supporting document (ADR 0024): every page an image in black and white, the zones
// to mask painted black, in a new PDF where nothing of the original is copied (no text, no font, no metadata). The
// pages are drawn by pdf.js in the browser (navigateur.ts); what is here runs in Node too (tests).

/** How the pages are drawn: resolution, and the grey level (0 to 255) from which a pixel is white. */
export type ReglagesAnnexe = { dpi: number, threshold: number }

export const REGLAGES_ANNEXE: ReglagesAnnexe = { dpi: 200, threshold: 170 }

/** A page drawn in black and white: its size in points, its pixels, 1 bit each, rows padded to a byte. */
export type PageImage = { largeur: number, hauteur: number, largeurPx: number, hauteurPx: number, bits: Uint8Array }

/**
 * The pixels of a canvas (RGBA, 4 bytes per pixel) in black and white, 1 bit per pixel: 1 white, 0 black, as the
 * colour space DeviceGray reads them; each row starts on a byte.
 */
export function binariser(rgba: Uint8ClampedArray, largeurPx: number, hauteurPx: number, threshold: number): Uint8Array {
  const parLigne = Math.ceil(largeurPx / 8)
  const bits = new Uint8Array(parLigne * hauteurPx)
  for (let y = 0; y < hauteurPx; y++) {
    for (let x = 0; x < largeurPx; x++) {
      const i = (y * largeurPx + x) * 4
      // Luminance (ITU-R BT.601); a transparent pixel is white paper
      const a = rgba[i + 3]! / 255
      const gris = (0.299 * rgba[i]! + 0.587 * rgba[i + 1]! + 0.114 * rgba[i + 2]!) * a + 255 * (1 - a)
      if (gris >= threshold) {
        bits[y * parLigne + (x >> 3)]! |= 0x80 >> (x & 7)
      }
    }
  }
  return bits
}

/** A PDF of these pages, each one only its image. */
export async function pdfEnImages(pages: PageImage[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false })
  for (const p of pages) {
    const page = pdf.addPage([p.largeur, p.hauteur])
    // The image as it is, 1 bit per pixel (embedPng would turn it into colours, ten times bigger)
    const image = pdf.context.register(pdf.context.flateStream(p.bits, {
      Type: 'XObject', Subtype: 'Image', Width: p.largeurPx, Height: p.hauteurPx,
      ColorSpace: 'DeviceGray', BitsPerComponent: 1,
    }))
    const name = page.node.newXObject('Im', image)
    page.pushOperators(
      pushGraphicsState(), concatTransformationMatrix(p.largeur, 0, 0, p.hauteur, 0, 0), drawObject(name), popGraphicsState(),
    )
  }
  return pdf.save()
}

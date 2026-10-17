import type { Document, Morceau, Reglages } from './contrat'

// From the pieces of text of pdf.js to lines of text (ADR 0013). pdf.js knows no lines: it gives pieces with their
// position, in drawing order. Sorted top to bottom, pieces whose baselines are close form a line; sorted left to
// right, they are joined according to the gap between the end of one and the start of the next. The settings are
// stored with each extractor: changing them changes what the extractor reads.

/** Lines of text of a page. */
export function regrouperPage(morceaux: Morceau[], reglages: Reglages): string[] {
  const tries = morceaux.filter((m) => m.texte.trim()).sort((a, b) => a.y - b.y || a.x - b.x)
  const lignes: { y: number, morceaux: Morceau[] }[] = []
  for (const morceau of tries) {
    const derniere = lignes.at(-1)
    if (derniere && morceau.y - derniere.y <= reglages.toleranceHauteur) {
      derniere.morceaux.push(morceau)
    } else {
      lignes.push({ y: morceau.y, morceaux: [morceau] })
    }
  }
  return lignes.map(({ morceaux: ligne }) => {
    ligne.sort((a, b) => a.x - b.x)
    let texte = ''
    let fin: number | null = null
    for (const m of ligne) {
      if (fin !== null) {
        const ecart = m.x - fin
        texte += ecart <= reglages.collage ? '' : ecart > reglages.colonne ? '   ' : ' '
      }
      texte += m.texte
      fin = m.x + m.largeur
    }
    return texte.trimEnd()
  })
}

export function regrouper(pages: Morceau[][], reglages: Reglages): Document {
  const lignesParPage = pages.map((page) => regrouperPage(page, reglages))
  const lignes = lignesParPage.flat()
  return { pages: lignesParPage, lines: lignes, text: lignes.join('\n') }
}

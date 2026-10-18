import type { Document, Morceau, Reglages } from './contrat'
import type { Row } from './bank-extractor'

// From the pieces of text of pdf.js to lines of text (ADR 0013). pdf.js knows no lines: it gives pieces with their
// position, in drawing order. Sorted top to bottom, pieces whose baselines are close form a line; sorted left to
// right, they are joined according to the gap between the end of one and the start of the next. The settings are
// stored with each extractor: changing them changes what the extractor reads. Bank statements (ADR 0018) also get
// each line with its pieces and their abscissa (debit or credit is a matter of column); their settings may set a
// margin, left of which pieces are ignored (a code printed vertically).

/** Lines of a page, with their pieces. */
function rangeesDeLaPage(morceaux: Morceau[], reglages: Reglages, page: number): Omit<Row, 'index'>[] {
  const marge = reglages.marge ?? null
  const tries = morceaux.filter((m) => m.texte.trim() && (marge === null || m.x >= marge)).sort((a, b) => a.y - b.y || a.x - b.x)
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
    return {
      text: texte.trimEnd(),
      pieces: ligne.map((m) => ({ text: m.texte.trim(), x: m.x, right: m.x + m.largeur })),
      page,
    }
  })
}

/** Lines of text of a page. */
export const regrouperPage = (morceaux: Morceau[], reglages: Reglages): string[] =>
  rangeesDeLaPage(morceaux, reglages, 1).map((r) => r.text)

export function regrouper(pages: Morceau[][], reglages: Reglages): Document & { rows: Row[] } {
  const parPage = pages.map((page, i) => rangeesDeLaPage(page, reglages, i + 1))
  const rows = parPage.flat().map((r, index) => ({ ...r, index }))
  const lignesParPage = parPage.map((rangees) => rangees.map((r) => r.text))
  const lignes = rows.map((r) => r.text)
  return { pages: lignesParPage, lines: lignes, text: lignes.join('\n'), rows }
}

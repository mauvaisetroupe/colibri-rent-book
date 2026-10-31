import type { Document, Morceau, Reglages } from './contrat'
import type { Row } from './bank-extractor'

// From the pieces of text of pdf.js to lines of text (ADR 0013). pdf.js knows no lines: it gives pieces with their
// position, in drawing order. Sorted top to bottom, pieces whose baselines are close form a line; sorted left to
// right, they are joined according to the gap between the end of one and the start of the next. The settings are
// stored with each extractor: changing them changes what the extractor reads. Bank statements (ADR 0018) also get
// each line with its pieces and their abscissa (debit or credit is a matter of column); their settings may set a
// margin, left of which pieces are ignored (a code printed vertically).

/** A piece of a line of text and where its text is in the line (ADR 0024: what to mask is found in the lines). */
export type Portion = { morceau: Morceau, start: number, end: number }

/** The lines of a page as text, each with the pieces it is made of. */
export function lignesAvecMorceaux(morceaux: Morceau[], settings: Reglages): { text: string, portions: Portion[] }[] {
  const margin = settings.margin ?? null
  const tries = morceaux.filter((m) => m.text.trim() && (margin === null || m.x >= margin)).sort((a, b) => a.y - b.y || a.x - b.x)
  const lines: { y: number, morceaux: Morceau[] }[] = []
  for (const morceau of tries) {
    const latest = lines.at(-1)
    if (latest && morceau.y - latest.y <= settings.lineTolerance) {
      latest.morceaux.push(morceau)
    } else {
      lines.push({ y: morceau.y, morceaux: [morceau] })
    }
  }
  return lines.map(({ morceaux: ligne }) => {
    ligne.sort((a, b) => a.x - b.x)
    let text = ''
    let end: number | null = null
    const portions: Portion[] = []
    for (const m of ligne) {
      if (end !== null) {
        const ecart = m.x - end
        text += ecart <= settings.joinGap ? '' : ecart > settings.columnGap ? '   ' : ' '
      }
      portions.push({ morceau: m, start: text.length, end: text.length + m.text.length })
      text += m.text
      end = m.x + m.largeur
    }
    return { text: text.trimEnd(), portions }
  })
}

/** Lines of a page, with their pieces. */
function rangeesDeLaPage(morceaux: Morceau[], settings: Reglages, page: number): Omit<Row, 'index'>[] {
  return lignesAvecMorceaux(morceaux, settings).map(({ text, portions }) => ({
    text: text,
    pieces: portions.map(({ morceau: m }) => ({ text: m.text.trim(), x: m.x, right: m.x + m.largeur })),
    page,
  }))
}

/** Lines of text of a page. */
export const regrouperPage = (morceaux: Morceau[], settings: Reglages): string[] =>
  rangeesDeLaPage(morceaux, settings, 1).map((r) => r.text)

export function regrouper(pages: Morceau[][], settings: Reglages): Document & { rows: Row[] } {
  const parPage = pages.map((page, i) => rangeesDeLaPage(page, settings, i + 1))
  const rows = parPage.flat().map((r, index) => ({ ...r, index }))
  const lignesParPage = parPage.map((rangees) => rangees.map((r) => r.text))
  const lines = rows.map((r) => r.text)
  return { pages: lignesParPage, lines: lines, text: lines.join('\n'), rows }
}

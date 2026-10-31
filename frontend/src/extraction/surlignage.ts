import type { Document } from './contrat'
import type { Correspondance, LigneEnErreur, NomDeChamp } from './moteur'

// What the regular expressions of an extractor found, as spans of the lines of the text (editor, ADR 0013). A match on
// a line read alone (line.match) highlights every line equal to it; a match on a whole text (doc.text, a page) is
// placed by its offset. A match on a string built by the code (a label put together) is not shown. A line found by
// findLine whose reading failed keeps its highlighting and gets the error message (a red cross in the editor).

export type Segment = { text: string, champ: NomDeChamp | null }

/** The segments of a line; whether findLine found it, whether it is in a narrowed zone; its error if not read. */
export type LigneSurlignee = { segments: Segment[], trouvee: boolean, dansZone: boolean, erreur: string | null }

// When spans overlap, the header fields win over what readLine reads
const PRIORITE: Record<NomDeChamp, number> = { lecture: 1, number: 2, date: 2, total: 2 }

export function surligner(
  document: Document, correspondances: Correspondance[],
  { enErreur = [], zone = [], trouvees = [] }: { enErreur?: LigneEnErreur[], zone?: number[], trouvees?: number[] } = {},
): LigneSurlignee[] {
  const { lines: lines, text: text } = document
  const marques: (NomDeChamp | null)[][] = lines.map((l) => new Array<NomDeChamp | null>(l.length).fill(null))
  const marquer = (i: number, start: number, end: number, champ: NomDeChamp) => {
    const ligne = marques[i]!
    for (let k = Math.max(0, start); k < Math.min(end, ligne.length); k++) {
      const actuel = ligne[k]
      if (!actuel || PRIORITE[champ] >= PRIORITE[actuel]) {
        ligne[k] = champ
      }
    }
  }

  const parTexte = new Map<string, number[]>()
  lines.forEach((l, i) => parTexte.set(l, [...(parTexte.get(l) ?? []), i]))
  const debuts: number[] = []
  let position = 0
  for (const l of lines) {
    debuts.push(position)
    position += l.length + 1
  }
  const decalages = new Map<string, number>()

  for (const c of correspondances) {
    const egales = parTexte.get(c.move_in)
    if (egales) {
      egales.forEach((i) => marquer(i, c.start, c.end, c.champ))
      continue
    }
    if (!c.move_in.includes('\n')) {
      continue
    }
    let decalage = decalages.get(c.move_in)
    if (decalage === undefined) {
      decalage = text.indexOf(c.move_in)
      decalages.set(c.move_in, decalage)
    }
    if (decalage < 0) {
      continue
    }
    const start = decalage + c.start
    const end = decalage + c.end
    lines.forEach((l, i) => {
      const d = debuts[i]!
      if (d + l.length >= start && d < end) {
        marquer(i, start - d, end - d, c.champ)
      }
    })
  }

  const erreurs = new Map(enErreur.map((e) => [e.position, e.erreur]))
  // The lines of the zone are marked when the zone is narrower than the whole text
  const dansZone = new Set(zone)
  const zoneRestreinte = zone.length > 0 && zone.length < lines.length
  const trouveesIci = new Set(trouvees)
  return lines.map((l, i) => {
    const erreur = erreurs.get(i) ?? null
    const segments: Segment[] = []
    for (let k = 0; k < l.length; k++) {
      const champ = marques[i]![k]!
      const last = segments.at(-1)
      if (last && last.champ === champ) {
        last.text += l[k]
      } else {
        segments.push({ text: l[k]!, champ })
      }
    }
    return { segments, trouvee: trouveesIci.has(i), dansZone: zoneRestreinte && dansZone.has(i), erreur }
  })
}

import type { Document } from './contrat'
import type { Correspondance, LigneEnErreur, NomDeChamp } from './moteur'

// What the regular expressions of an extractor found, as spans of the lines of the text (editor, ADR 0013). A match on
// a line read alone (line.match) highlights every line equal to it; a match on a whole text (doc.text, a page) is
// placed by its offset. A match on a string built by the code (a label put together) is not shown. A line found by
// findLine whose reading failed keeps its highlighting and gets the error message (a red cross in the editor).

export type Segment = { texte: string, champ: NomDeChamp | null }

/** The segments of a line; whether findLine found it, whether it is in a narrowed zone; its error if not read. */
export type LigneSurlignee = { segments: Segment[], trouvee: boolean, dansZone: boolean, erreur: string | null }

// When spans overlap, the header fields win over what readLine reads
const PRIORITE: Record<NomDeChamp, number> = { lecture: 1, numero: 2, date: 2, total: 2 }

export function surligner(
  document: Document, correspondances: Correspondance[],
  { enErreur = [], zone = [], trouvees = [] }: { enErreur?: LigneEnErreur[], zone?: number[], trouvees?: number[] } = {},
): LigneSurlignee[] {
  const { lines: lignes, text: texte } = document
  const marques: (NomDeChamp | null)[][] = lignes.map((l) => new Array<NomDeChamp | null>(l.length).fill(null))
  const marquer = (i: number, debut: number, fin: number, champ: NomDeChamp) => {
    const ligne = marques[i]!
    for (let k = Math.max(0, debut); k < Math.min(fin, ligne.length); k++) {
      const actuel = ligne[k]
      if (!actuel || PRIORITE[champ] >= PRIORITE[actuel]) {
        ligne[k] = champ
      }
    }
  }

  const parTexte = new Map<string, number[]>()
  lignes.forEach((l, i) => parTexte.set(l, [...(parTexte.get(l) ?? []), i]))
  const debuts: number[] = []
  let position = 0
  for (const l of lignes) {
    debuts.push(position)
    position += l.length + 1
  }
  const decalages = new Map<string, number>()

  for (const c of correspondances) {
    const egales = parTexte.get(c.entree)
    if (egales) {
      egales.forEach((i) => marquer(i, c.debut, c.fin, c.champ))
      continue
    }
    if (!c.entree.includes('\n')) {
      continue
    }
    let decalage = decalages.get(c.entree)
    if (decalage === undefined) {
      decalage = texte.indexOf(c.entree)
      decalages.set(c.entree, decalage)
    }
    if (decalage < 0) {
      continue
    }
    const debut = decalage + c.debut
    const fin = decalage + c.fin
    lignes.forEach((l, i) => {
      const d = debuts[i]!
      if (d + l.length >= debut && d < fin) {
        marquer(i, debut - d, fin - d, c.champ)
      }
    })
  }

  const erreurs = new Map(enErreur.map((e) => [e.position, e.erreur]))
  // The lines of the zone are marked when the zone is narrower than the whole text
  const dansZone = new Set(zone)
  const zoneRestreinte = zone.length > 0 && zone.length < lignes.length
  const trouveesIci = new Set(trouvees)
  return lignes.map((l, i) => {
    const erreur = erreurs.get(i) ?? null
    const segments: Segment[] = []
    for (let k = 0; k < l.length; k++) {
      const champ = marques[i]![k]!
      const dernier = segments.at(-1)
      if (dernier && dernier.champ === champ) {
        dernier.texte += l[k]
      } else {
        segments.push({ texte: l[k]!, champ })
      }
    }
    return { segments, trouvee: trouveesIci.has(i), dansZone: zoneRestreinte && dansZone.has(i), erreur }
  })
}

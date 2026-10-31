import type { Ligne } from '../api'
import {
  NOTE_PENALITE, NOTE_PERIODE_PAR_DEFAUT, type ClasseExtracteur, type Document, type Energie, type LigneLue, type Morceau,
  type Reglages,
} from './contrat'
import * as extractor from './extractor'
import { regrouper } from './regroupement'

// Runs an extractor on the pieces of a PDF (ADR 0013), in the browser (import, editor) and in Node (tests). One
// instance of its class per PDF; each method runs on its own: an error is kept next to its field. Invoice lines: each
// line found in the zone is read on its own, an error marks that line and the others are still read.

/**
 * The class of an extractor from its JavaScript, as produced from its TypeScript source (CommonJS module whose
 * default export extends InvoiceExtractor). Its only import is 'extractor'.
 */
export function charger(code: string): ClasseExtracteur {
  const module: { exports: Record<string, unknown> } = { exports: {} }
  const require = (name: string) => {
    if (name !== 'extractor') {
      throw new Error(`Import non disponible dans un extracteur : ${name} (seulement 'extractor')`)
    }
    return extractor
  }
  new Function('require', 'module', 'exports', code)(require, module, module.exports)
  const classe = module.exports.default as ClasseExtracteur | undefined
  if (typeof classe !== 'function' || !(classe.prototype instanceof extractor.InvoiceExtractor)) {
    throw new Error('Le code doit exporter par défaut une classe qui étend InvoiceExtractor')
  }
  return classe
}

const DOCUMENT_VIDE: Document = { pages: [], lines: [], text: '' }

// The versions of an extractor stored before the names went English (docs/glossary.md) give their values in French,
// and a version is never changed: read in English here, whatever version gave them.
const LEGACY: Record<string, string> = {
  consommation: 'consumption', abonnement: 'subscription', taxe: 'tax', prestation: 'service', penalite: 'penalty',
  autre: 'other', recuperable: 'recoverable', proprietaire: 'owner', hors_immeuble: 'outside_building',
  gaz: 'gas', electricite: 'electricity', eau: 'water', ordures_menageres: 'household_waste',
}
const english = <T extends string>(value: T): T => (LEGACY[value] ?? value) as T

/** Energy of the invoices read by an extractor. */
export const energieDe = (classe: ClasseExtracteur): Energie => english(new classe(DOCUMENT_VIDE).energy)

export type Champ<T> = { valeur: T | null, erreur: string | null }

// lecture: matches of the regular expressions of readLine and after (what an invoice line is read from). The lines
// found by findLine are given as positions (Extraction.trouvees): what matters is its answer, not its expressions.
export type NomDeChamp = 'number' | 'date' | 'total' | 'lecture'

/** A successful match of a regular expression while a field was read: the string searched and the span found. */
export type Correspondance = { champ: NomDeChamp, move_in: string, start: number, end: number }

/** A line found by findLine whose reading failed: its position in the document and the error. */
export type LigneEnErreur = { position: number, text: string, erreur: string }

export type Extraction = {
  document: Document
  number: Champ<string>
  date: Champ<string>
  total: Champ<string>
  // Lines read; « erreur » when lines could not be read (listed in lignesEnErreur) or when the zone failed
  lines: Champ<Ligne[]>
  lignesEnErreur: LigneEnErreur[]
  // Positions in the document of the lines of the zone (where findLine looks) and of the lines it found
  zone: number[]
  trouvees: number[]
}

function champ<T>(lire: () => T | null): Champ<T> {
  try {
    return { valeur: lire() ?? null, erreur: null }
  } catch (e) {
    return { valeur: null, erreur: (e as Error).message }
  }
}

/**
 * Runs `lire` while recording every successful match of a regular expression (editor: what the code found is
 * highlighted in the text). String.match, RegExp.test, matchAll… all go through RegExp.prototype.exec; it is replaced
 * for the time of the call only (the extraction is synchronous).
 */
function avecCorrespondances<T>(name: NomDeChamp, notes: Correspondance[] | undefined, lire: () => T): T {
  if (!notes) {
    return lire()
  }
  const exec = RegExp.prototype.exec
  RegExp.prototype.exec = function (this: RegExp, move_in: string) {
    const m = exec.call(this, move_in)
    if (m && m[0].length) {
      notes.push({ champ: name, move_in: String(move_in), start: m.index, end: m.index + m[0].length })
    }
    return m
  }
  try {
    return lire()
  } finally {
    RegExp.prototype.exec = exec
  }
}

export const documentDe = (pages: Morceau[][], settings: Reglages) => regrouper(pages, settings)

export function reconnait(classe: ClasseExtracteur, document: Document): boolean {
  try {
    return new classe(document).recognizes() === true
  } catch {
    return false
  }
}

/** Reads the invoice; `correspondances`, when given, receives the matches of the regular expressions of each field. */
export function extraire(classe: ClasseExtracteur, document: Document, correspondances?: Correspondance[]): Extraction {
  const lignesEnErreur: LigneEnErreur[] = []
  let instance: extractor.InvoiceExtractor
  try {
    instance = new classe(document)
  } catch (e) {
    const erreur = { valeur: null, erreur: `constructeur : ${(e as Error).message}` }
    return { document, number: erreur, date: erreur, total: erreur, lines: erreur, lignesEnErreur, zone: [], trouvees: [] }
  }
  const number = champ(() => avecCorrespondances('number', correspondances, () => instance.invoiceNumber()))
  const date = champ(() => avecCorrespondances('date', correspondances, () => instance.invoiceDate()))
  const total = champ(() => avecCorrespondances('total', correspondances, () => instance.total()))

  const lues: LigneLue[] = []
  let positions: number[] = []
  const trouvees: number[] = []
  const lines = champ(() => {
    const zone = instance.linesZone()
    positions = positionsDans(document.lines, zone)
    zone.forEach((ligne, index) => {
      const contexte = { line: ligne, index, lines: zone, previous: zone[index - 1], next: zone[index + 1] }
      try {
        const trouvee = instance.findLine(ligne, contexte)
        if (!trouvee) {
          return
        }
        trouvees.push(positions[index] ?? -1)
        const correspondance = trouvee === true
          ? Object.assign([ligne], { index: 0, input: ligne }) as unknown as RegExpMatchArray
          : trouvee
        const lue = avecCorrespondances('lecture', correspondances, () => instance.readLine(correspondance, contexte))
        lues.push(...(Array.isArray(lue) ? lue : lue ? [lue] : []))
      } catch (e) {
        lignesEnErreur.push({ position: positions[index] ?? -1, text: ligne, erreur: (e as Error).message })
      }
    })
    const finales = avecCorrespondances('lecture', correspondances,
      () => instance.after(lues, { number: number.valeur, date: date.valeur, total: total.valeur }))
    return completer(finales, date.valeur)
  })
  if (!lines.erreur && lignesEnErreur.length) {
    lines.erreur = `${lignesEnErreur.length} ligne(s) trouvée(s) mais non lue(s)`
  }
  return { document, number, date, total, lines, lignesEnErreur, zone: positions.filter((p) => p >= 0), trouvees }
}

/** Position in the document of each line of the zone (a zone is the lines of the document in their order, or some). */
function positionsDans(lines: string[], zone: string[]): number[] {
  let depuis = 0
  return zone.map((ligne) => {
    const position = lines.indexOf(ligne, depuis)
    if (position >= 0) {
      depuis = position + 1
    }
    return position
  })
}

/**
 * What every invoice needs (SPEC R5, R6): a penalty is borne by the owner and dated on the invoice; a line without
 * a printed period gets the consumption period of the invoice, with a note the checks show as « à confirmer ». The
 * lines are given in the format of the API.
 */
function completer(luesTelles: LigneLue[], dateFacture: string | null): Ligne[] {
  const lues = luesTelles.map((l) => ({
    ...l, category: english(l.category), allocation: l.allocation === undefined ? undefined : english(l.allocation),
  }))
  const consommations = lues.filter((l) => l.category === 'consumption' && l.start && l.end)
  const debutConso = consommations.map((l) => l.start!).sort()[0]
  const finConso = consommations.map((l) => l.end!).sort().at(-1)
  return lues.map((l) => {
    const penalite = l.category === 'penalty'
    let { start: start, end: end } = l
    let note = l.note ?? null
    if (!start || !end) {
      if (penalite && dateFacture) {
        start = end = dateFacture
      } else if (debutConso && finConso) {
        start = debutConso
        end = finConso
        note ??= NOTE_PERIODE_PAR_DEFAUT
      }
    }
    if (penalite && !l.allocation) {
      note ??= NOTE_PENALITE
    }
    return {
      category: l.category,
      label: l.label,
      start: start ?? '',
      end: end ?? '',
      kwh: null,
      amount_excl_tax: null,
      vat_rate: null,
      amount_incl_tax: l.amount,
      allocation: l.allocation ?? (penalite ? 'owner' : 'recoverable'),
      note,
    }
  })
}

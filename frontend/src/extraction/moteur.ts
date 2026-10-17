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
  const require = (nom: string) => {
    if (nom !== 'extractor') {
      throw new Error(`Import non disponible dans un extracteur : ${nom} (seulement 'extractor')`)
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

/** Energy of the invoices read by an extractor. */
export const energieDe = (classe: ClasseExtracteur): Energie => new classe(DOCUMENT_VIDE).energy

export type Champ<T> = { valeur: T | null, erreur: string | null }

// lecture: matches of the regular expressions of readLine and after (what an invoice line is read from). The lines
// found by findLine are given as positions (Extraction.trouvees): what matters is its answer, not its expressions.
export type NomDeChamp = 'numero' | 'date' | 'total' | 'lecture'

/** A successful match of a regular expression while a field was read: the string searched and the span found. */
export type Correspondance = { champ: NomDeChamp, entree: string, debut: number, fin: number }

/** A line found by findLine whose reading failed: its position in the document and the error. */
export type LigneEnErreur = { position: number, texte: string, erreur: string }

export type Extraction = {
  document: Document
  numero: Champ<string>
  date: Champ<string>
  total: Champ<string>
  // Lines read; « erreur » when lines could not be read (listed in lignesEnErreur) or when the zone failed
  lignes: Champ<Ligne[]>
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
function avecCorrespondances<T>(nom: NomDeChamp, notes: Correspondance[] | undefined, lire: () => T): T {
  if (!notes) {
    return lire()
  }
  const exec = RegExp.prototype.exec
  RegExp.prototype.exec = function (this: RegExp, entree: string) {
    const m = exec.call(this, entree)
    if (m && m[0].length) {
      notes.push({ champ: nom, entree: String(entree), debut: m.index, fin: m.index + m[0].length })
    }
    return m
  }
  try {
    return lire()
  } finally {
    RegExp.prototype.exec = exec
  }
}

export const documentDe = (pages: Morceau[][], reglages: Reglages) => regrouper(pages, reglages)

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
    return { document, numero: erreur, date: erreur, total: erreur, lignes: erreur, lignesEnErreur, zone: [], trouvees: [] }
  }
  const numero = champ(() => avecCorrespondances('numero', correspondances, () => instance.invoiceNumber()))
  const date = champ(() => avecCorrespondances('date', correspondances, () => instance.invoiceDate()))
  const total = champ(() => avecCorrespondances('total', correspondances, () => instance.total()))

  const lues: LigneLue[] = []
  let positions: number[] = []
  const trouvees: number[] = []
  const lignes = champ(() => {
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
        lignesEnErreur.push({ position: positions[index] ?? -1, texte: ligne, erreur: (e as Error).message })
      }
    })
    const finales = avecCorrespondances('lecture', correspondances,
      () => instance.after(lues, { number: numero.valeur, date: date.valeur, total: total.valeur }))
    return completer(finales, date.valeur)
  })
  if (!lignes.erreur && lignesEnErreur.length) {
    lignes.erreur = `${lignesEnErreur.length} ligne(s) trouvée(s) mais non lue(s)`
  }
  return { document, numero, date, total, lignes, lignesEnErreur, zone: positions.filter((p) => p >= 0), trouvees }
}

/** Position in the document of each line of the zone (a zone is the lines of the document in their order, or some). */
function positionsDans(lignes: string[], zone: string[]): number[] {
  let depuis = 0
  return zone.map((ligne) => {
    const position = lignes.indexOf(ligne, depuis)
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
function completer(lues: LigneLue[], dateFacture: string | null): Ligne[] {
  const consommations = lues.filter((l) => l.category === 'consommation' && l.start && l.end)
  const debutConso = consommations.map((l) => l.start!).sort()[0]
  const finConso = consommations.map((l) => l.end!).sort().at(-1)
  return lues.map((l) => {
    const penalite = l.category === 'penalite'
    let { start: debut, end: fin } = l
    let note = l.note ?? null
    if (!debut || !fin) {
      if (penalite && dateFacture) {
        debut = fin = dateFacture
      } else if (debutConso && finConso) {
        debut = debutConso
        fin = finConso
        note ??= NOTE_PERIODE_PAR_DEFAUT
      }
    }
    if (penalite && !l.allocation) {
      note ??= NOTE_PENALITE
    }
    return {
      categorie: l.category,
      libelle: l.label,
      debut: debut ?? '',
      fin: fin ?? '',
      kwh: null,
      montant_ht: null,
      taux_tva: null,
      montant_ttc: l.amount,
      affectation: l.allocation ?? (penalite ? 'proprietaire' : 'recuperable'),
      note,
    }
  })
}

import Big from 'big.js'

import type { Morceau, Reglages } from './contrat'
import * as bankExtractor from './bank-extractor'
import type { BankStatementExtractor, Row, StatementDocument, Totals } from './bank-extractor'
import type { Champ, LigneEnErreur } from './moteur'
import { regrouper } from './regroupement'

// Runs a bank statement extractor on the pieces of a PDF (ADR 0018), in the browser (import, editor) and in Node
// (tests). As for invoices, each method runs on its own and an error stays next to its field; each movement is read
// on its own. The rows that follow a movement in the zone, up to the next movement, are its detail (but those the
// extractor ignores). Then the check: opening balance + credits − debits = closing balance, and the printed totals.

export type ClasseExtracteurReleve = new (doc: StatementDocument) => BankStatementExtractor

/** A movement in the format of the API: amount signed (credit positive), dates ISO. */
export type MouvementReleve = {
  date_operation: string
  date_valeur: string | null
  libelle: string
  detail: string | null
  montant: string
}

export type ControleReleve = {
  credits: string
  debits: string
  // Opening balance + credits − debits; null when a balance is not read
  calcule: string | null
  equilibre: boolean | null
  // Printed totals equal to the movements read; null when none is printed
  totaux: boolean | null
}

export type ExtractionReleve = {
  document: StatementDocument
  compte: Champ<string>
  date: Champ<string>
  soldePrecedent: Champ<string>
  nouveauSolde: Champ<string>
  totaux: Champ<Totals>
  mouvements: Champ<MouvementReleve[]>
  mouvementsEnErreur: LigneEnErreur[]
  // Positions (doc.rows) of the zone, of the rows that start a movement, of the detail rows
  zone: number[]
  trouvees: number[]
  details: number[]
  controle: ControleReleve
}

/** The class of a statement extractor from its JavaScript (CommonJS, default export, only import 'bank-extractor'). */
export function chargerReleve(code: string): ClasseExtracteurReleve {
  const module: { exports: Record<string, unknown> } = { exports: {} }
  const require = (nom: string) => {
    if (nom !== 'bank-extractor') {
      throw new Error(`Import non disponible dans un extracteur de relevé : ${nom} (seulement 'bank-extractor')`)
    }
    return bankExtractor
  }
  new Function('require', 'module', 'exports', code)(require, module, module.exports)
  const classe = module.exports.default as ClasseExtracteurReleve | undefined
  if (typeof classe !== 'function' || !(classe.prototype instanceof bankExtractor.BankStatementExtractor)) {
    throw new Error('Le code doit exporter par défaut une classe qui étend BankStatementExtractor')
  }
  return classe
}

/** Is this JavaScript a statement extractor (rather than an invoice one)? */
export function estReleve(code: string) {
  try {
    chargerReleve(code)
    return true
  } catch {
    return false
  }
}

export const documentReleve = (pages: Morceau[][], reglages: Reglages): StatementDocument => regrouper(pages, reglages)

export function reconnaitReleve(classe: ClasseExtracteurReleve, document: StatementDocument): boolean {
  try {
    return new classe(document).recognizes() === true
  } catch {
    return false
  }
}

function champ<T>(lire: () => T | null | undefined): Champ<T> {
  try {
    return { valeur: lire() ?? null, erreur: null }
  } catch (e) {
    return { valeur: null, erreur: (e as Error).message }
  }
}

const decimal = (valeur: string, quoi: string) => {
  try {
    return new Big(valeur).toString()
  } catch {
    throw new Error(`${quoi} : « ${valeur} » n'est pas un nombre décimal`)
  }
}

export function extraireReleve(classe: ClasseExtracteurReleve, document: StatementDocument): ExtractionReleve {
  const mouvementsEnErreur: LigneEnErreur[] = []
  const zone: number[] = []
  const trouvees: number[] = []
  const details: number[] = []
  let instance: BankStatementExtractor
  try {
    instance = new classe(document)
  } catch (e) {
    const erreur = { valeur: null, erreur: `constructeur : ${(e as Error).message}` }
    return {
      document, compte: erreur, date: erreur, soldePrecedent: erreur, nouveauSolde: erreur, totaux: erreur, mouvements: erreur,
      mouvementsEnErreur, zone, trouvees, details,
      controle: { credits: '0', debits: '0', calcule: null, equilibre: null, totaux: null },
    }
  }
  const compte = champ(() => instance.account())
  const date = champ(() => instance.statementDate())
  const soldePrecedent = champ(() => decimal(instance.openingBalance(), 'openingBalance'))
  const nouveauSolde = champ(() => decimal(instance.closingBalance(), 'closingBalance'))
  const totaux = champ(() => instance.printedTotals())

  const mouvements = champ(() => {
    const lus: (MouvementReleve & { lignes: string[] })[] = []
    const rangees: Row[] = instance.movementsZone()
    let courant: (typeof lus)[number] | null = null
    rangees.forEach((row, index) => {
      zone.push(row.index)
      const contexte = { row, index, rows: rangees }
      try {
        if (instance.ignoreRow(row)) {
          return
        }
        const trouvee = instance.findMovement(row, contexte)
        if (!trouvee) {
          // The detail of the movement above (« LOYER 02/25 », the payer…)
          if (courant) {
            courant.lignes.push(row.text.trim())
            details.push(row.index)
          }
          return
        }
        trouvees.push(row.index)
        courant = null
        const correspondance = trouvee === true
          ? Object.assign([row.text], { index: 0, input: row.text }) as unknown as RegExpMatchArray
          : trouvee
        const m = instance.readMovement(correspondance, contexte)
        const montant = new Big(decimal(m.amount, 'amount')).abs()
        if (m.side !== 'debit' && m.side !== 'credit') {
          throw new Error(`side : « ${String(m.side)} » (debit ou credit attendu)`)
        }
        courant = {
          date_operation: m.date,
          date_valeur: m.valueDate ?? null,
          libelle: m.label.trim(),
          detail: null,
          montant: (m.side === 'debit' ? montant.neg() : montant).toString(),
          lignes: [],
        }
        lus.push(courant)
      } catch (e) {
        courant = null
        mouvementsEnErreur.push({ position: row.index, texte: row.text, erreur: (e as Error).message })
      }
    })
    if (mouvementsEnErreur.length) {
      throw new Error(`${mouvementsEnErreur.length} mouvement(s) trouvé(s) mais non lu(s)`)
    }
    return lus.map(({ lignes, ...m }) => ({ ...m, detail: lignes.join('\n') || null }))
  })

  const liste = mouvements.valeur ?? []
  const credits = liste.filter((m) => new Big(m.montant).gt(0)).reduce((s, m) => s.plus(m.montant), new Big(0))
  const debits = liste.filter((m) => new Big(m.montant).lt(0)).reduce((s, m) => s.plus(m.montant), new Big(0)).abs()
  const calcule = soldePrecedent.valeur === null ? null : new Big(soldePrecedent.valeur).plus(credits).minus(debits)
  const imprimes = totaux.valeur
  const controle: ControleReleve = {
    credits: credits.toString(),
    debits: debits.toString(),
    calcule: calcule?.toString() ?? null,
    equilibre: calcule === null || nouveauSolde.valeur === null || mouvements.erreur ? null : calcule.eq(nouveauSolde.valeur),
    totaux: !imprimes || mouvements.erreur ? null
      : (imprimes.debit === null || debits.eq(imprimes.debit)) && (imprimes.credit === null || credits.eq(imprimes.credit)),
  }
  return {
    document, compte, date, soldePrecedent, nouveauSolde, totaux, mouvements, mouvementsEnErreur, zone, trouvees, details,
    controle,
  }
}

/** What is sent on import; null with the reasons when the statement is not read entirely or does not add up. */
export function releveAImporter(extraction: ExtractionReleve, extracteurId: number) {
  const champs = ['compte', 'date', 'soldePrecedent', 'nouveauSolde', 'totaux', 'mouvements'] as const
  const problemes = champs.filter((c) => extraction[c].erreur).map((c) => `${c} : ${extraction[c].erreur}`)
  if (extraction.controle.equilibre === false) {
    problemes.push(`solde précédent + crédits − débits = ${extraction.controle.calcule}, nouveau solde ${extraction.nouveauSolde.valeur}`)
  }
  if (extraction.controle.totaux === false) {
    problemes.push('les mouvements lus ne retombent pas sur les totaux imprimés')
  }
  if (problemes.length || !extraction.compte.valeur || !extraction.date.valeur) {
    return { releve: null, probleme: problemes.join(' ; ') || 'compte ou date introuvable' }
  }
  return {
    releve: {
      extracteur_id: extracteurId,
      compte: extraction.compte.valeur,
      date_releve: extraction.date.valeur,
      solde_precedent: extraction.soldePrecedent.valeur!,
      nouveau_solde: extraction.nouveauSolde.valeur!,
      totaux: extraction.totaux.valeur,
      mouvements: extraction.mouvements.valeur ?? [],
    },
    probleme: null,
  }
}

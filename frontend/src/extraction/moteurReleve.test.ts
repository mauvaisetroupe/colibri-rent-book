import assert from 'node:assert/strict'
import { test } from 'node:test'

import ts from 'typescript'

import { compiler } from './compilation'
import { REGLAGES_RELEVE_PAR_DEFAUT, type Morceau } from './contrat'
import { chargerReleve, documentReleve, estReleve, extraireReleve, releveAImporter } from './moteurReleve'

// The statement engine (ADR 0018) on a made-up statement: pieces placed as on a PDF, debit and credit told by their
// column, detail rows attached, margin ignored, balances checked.

const piece = (texte: string, x: number, y: number, largeur = texte.length * 4): Morceau => ({ texte, x, y, largeur, hauteur: 8 })
// Right edges: « Débit » column ends at 460, « Crédit » at 534
const droite = (texte: string, fin: number, y: number) => piece(texte, fin - texte.length * 4, y)

const page = [
  piece('BANQUE EXEMPLE', 60, 10),
  piece('Compte 0001 au 16/10/2026', 60, 20),
  droite('Débit', 460, 30), droite('Crédit', 534, 30),
  piece('Ancien solde', 60, 40), droite('1.000,00', 534, 40),
  piece('05/10/2026', 60, 50), piece('VIR DE ALICE', 150, 50), droite('590,00', 534, 50),
  piece('LOYER 10/26', 150, 60),
  piece('7', 14, 62),
  piece('06/10/2026', 60, 70), piece('ECH PRET', 150, 70), droite('1.697,54', 460, 70),
  piece('Nouveau solde', 60, 80), droite('-107,54', 534, 80),
]

const SOURCE = `
import { BankStatementExtractor, rx, AMOUNT, DATE, type MovementContext, type Row } from 'bank-extractor'
export default class Exemple extends BankStatementExtractor {
  recognizes() { return this.doc.text.includes('BANQUE EXEMPLE') }
  account() { return this.capture(this.doc.text, /Compte (\\d+)/) }
  statementDate() { return this.frenchDate(this.capture(this.doc.text, rx\`au (\${DATE})\`)) }
  openingBalance() { return this.amount(this.rowsMatching(/Ancien solde/)[0]!.pieces.at(-1)!.text) }
  closingBalance() { return this.amount(this.rowsMatching(/Nouveau solde/)[0]!.pieces.at(-1)!.text) }
  movementsZone() { return this.betweenRows(/Ancien solde/, /Nouveau solde/) }
  findMovement(row: Row) { return row.text.match(rx\`^(\${DATE}) (.+?)\\s+(\${AMOUNT})$\`) }
  readMovement(m: RegExpMatchArray, { row }: MovementContext) {
    const p = row.pieces.at(-1)!
    return { date: this.frenchDate(m[1]), label: m[2]!, amount: this.amount(p.text), side: this.column(p, { debit: /^Débit/, credit: /^Crédit/ }) }
  }
}`

test('a made-up statement is read: columns, detail, margin, balances', () => {
  const code = compiler(SOURCE, ts)
  assert.equal(estReleve(code), true)
  const lu = extraireReleve(chargerReleve(code), documentReleve([page], REGLAGES_RELEVE_PAR_DEFAUT))
  assert.deepEqual([lu.compte.valeur, lu.date.valeur, lu.soldePrecedent.valeur, lu.nouveauSolde.valeur],
    ['0001', '2026-10-16', '1000', '-107.54'])
  assert.deepEqual(lu.mouvements.valeur, [
    { date_operation: '2026-10-05', date_valeur: null, libelle: 'VIR DE ALICE', detail: 'LOYER 10/26', montant: '590' },
    { date_operation: '2026-10-06', date_valeur: null, libelle: 'ECH PRET', detail: null, montant: '-1697.54' },
  ])
  assert.equal(lu.controle.equilibre, true)
  assert.equal(releveAImporter(lu, 7).releve?.extracteur_id, 7)
})

test('a statement that does not add up is not imported', () => {
  const faux = page.map((p) => (p.texte === '-107,54' ? { ...p, texte: '-100,00' } : p))
  const lu = extraireReleve(chargerReleve(compiler(SOURCE, ts)), documentReleve([faux], REGLAGES_RELEVE_PAR_DEFAUT))
  assert.equal(lu.controle.equilibre, false)
  assert.match(releveAImporter(lu, 7).probleme!, /nouveau solde -100/)
})

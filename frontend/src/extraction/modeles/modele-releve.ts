// New bank: template to adapt (ADR 0018). Each method reads one piece of information from this.doc: text, lines, and
// rows (each line with its pieces and their abscissa). The text of the sample PDF, row by row, is shown next to the
// code: the rows that start a movement are highlighted, their detail rows shaded.
//   rx`…`                         regular expression without doubling the « \ », with ${AMOUNT} (1.234,56), ${DATE}
//   this.capture(text, re)        first group of re in text
//   this.amount('1.234,56') → '1234.56'   this.frenchDate('05/10/2026')   this.longFrenchDate('16 octobre 2026')
//   this.rowsMatching(re)   this.betweenRows(/from/, /to/)
//   this.column(piece, { debit: /Débit/, credit: /Crédit/ })   under which column title is an amount
// The engine checks: opening balance + credits − debits = closing balance (and the printed totals, if any).
import { BankStatementExtractor, rx, AMOUNT, DATE, type MovementContext, type Row } from 'bank-extractor'

const COLONNES = { debit: /^Débit/, credit: /^Crédit/ }

export default class NewBankExtractor extends BankStatementExtractor {
  recognizes() {
    return this.doc.text.includes('NOM DE LA BANQUE')
  }

  account() {
    return this.capture(this.doc.text, /Compte n° (\S+)/)
  }

  statementDate() {
    return this.frenchDate(this.capture(this.doc.text, rx`Relevé au (${DATE})`))
  }

  openingBalance() {
    return this.amount(this.capture(this.doc.text, rx`Ancien solde\s+(${AMOUNT})`))
  }

  closingBalance() {
    return this.amount(this.capture(this.doc.text, rx`Nouveau solde\s+(${AMOUNT})`))
  }

  movementsZone() {
    return this.betweenRows(/Ancien solde/, /Nouveau solde/)
  }

  findMovement(row: Row) {
    return row.text.match(rx`^(${DATE})\s+(.+?)\s+(${AMOUNT})$`)
  }

  readMovement(match: RegExpMatchArray, { row }: MovementContext) {
    const montant = row.pieces.at(-1)!
    return {
      date: this.frenchDate(match[1]),
      label: match[2]!,
      amount: this.amount(montant.text),
      side: this.column(montant, COLONNES),
    }
  }
}

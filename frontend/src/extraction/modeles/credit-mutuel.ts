// Relevés « RELEVE ET INFORMATIONS BANCAIRES » du Crédit Mutuel (ADR 0018). Réglages : marge 40, le code imprimé à la
// verticale dans la marge de gauche (« GH.2026… ») est ignoré.
// Débit ou crédit : la colonne du montant, sous « Débit EUROS » ou « Crédit EUROS ». Les lignes qui suivent une
// opération (émetteur, « LOYER 02/25 », référence) sont son détail : elles commencent sous le libellé, 13 points à
// gauche du titre « Opération » de leur page (la mise en page se décale d'une page à l'autre) ; les hauts et bas de
// page, quand une opération continue sur la page suivante, commencent ailleurs.
import { BankStatementExtractor, rx, AMOUNT, DATE, type MovementContext, type Row } from 'bank-extractor'

const SOLDE = /SOLDE (CREDITEUR|DEBITEUR) AU/
const COLONNES = { debit: /^Débit/, credit: /^Crédit/ }

export default class CreditMutuelExtractor extends BankStatementExtractor {
  recognizes() {
    return this.doc.text.includes('RELEVE ET INFORMATIONS BANCAIRES') && this.doc.text.includes('CMCIFR2A')
  }

  account() {
    return this.capture(this.doc.text, /N° (\d{11}) en euros/)
  }

  // « 16 octobre 2026 », seule sur sa ligne sous le titre
  statementDate() {
    return this.longFrenchDate(this.capture(this.doc.text, /^\s*(\d{1,2}(?:er)? \p{L}+ \d{4})$/mu))
  }

  // « SOLDE CREDITEUR AU 01/10/2026   41.345,26 » : le premier est le solde précédent, le dernier le nouveau solde
  openingBalance() {
    return this.balance(this.rowsMatching(SOLDE)[0])
  }

  closingBalance() {
    return this.balance(this.rowsMatching(SOLDE).at(-1))
  }

  // Les opérations : entre le solde précédent et le « Total des mouvements »
  movementsZone() {
    return this.betweenRows(SOLDE, /Total des mouvements/)
  }

  // « 05/10/2026 05/10/2026 VIR DE MME ALICE EXEMPLE   590,00 »
  findMovement(row: Row) {
    return row.text.match(rx`^(${DATE}) (${DATE}) (.+?)\s+(${AMOUNT})$`)
  }

  readMovement(match: RegExpMatchArray, { row }: MovementContext) {
    const amount = row.pieces.at(-1)!
    return {
      date: this.frenchDate(match[1]),
      valueDate: this.frenchDate(match[2]),
      label: match[3]!,
      amount: this.amount(amount.text),
      side: this.column(amount, COLONNES),
    }
  }

  // Ni une opération ni la colonne du libellé : haut ou bas de page
  ignoreRow(row: Row) {
    const column = this.colonneLibelle(row.page)
    return !this.findMovement(row) && !(column !== null && Math.abs(row.pieces[0]!.x - column) <= 4)
  }

  // « Total des mouvements   4.961,84   590,00 », chaque montant sous sa colonne
  printedTotals() {
    const row = this.rowsMatching(/Total des mouvements/)[0]
    return row ? this.amountsByColumn(row, COLONNES) : null
  }

  // Abscisse des libellés d'une page : 13 points à gauche du titre « Opération »
  private colonneLibelle(page: number): number | null {
    const title = this.doc.rows.filter((r) => r.page === page).flatMap((r) => r.pieces).find((p) => p.text === 'Opération')
    return title ? title.x - 13 : null
  }

  // « SOLDE DEBITEUR » : solde négatif
  private balance(row: Row | undefined) {
    if (!row) {
      throw new Error('solde introuvable')
    }
    const value = this.amount(row.pieces.at(-1)!.text)
    return /DEBITEUR/.test(row.text) ? `-${value}` : value
  }
}

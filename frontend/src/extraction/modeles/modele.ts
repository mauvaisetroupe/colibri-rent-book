// New supplier: template to adapt. Each method reads one piece of information from this.doc (text, lines, pages);
// null means « not on this PDF », typed by hand in the draft. The text of the sample PDF, line by line, is shown next
// to the code: the regular expressions are written from it, what they find is highlighted.
//   rx`…`                     regular expression without doubling the « \ », with ${AMOUNT} (1 234,56), ${DATE} (17/10/2023)
//   this.capture(text, re)    first group of re in text (error « introuvable » otherwise)
//   this.amount('1 234,56') → '1234.56'   this.frenchDate('17/10/23') → '2023-10-17'   this.withVat(excl, vat)
//   this.between(lines, /from/, /to/)    lines between two marks
// Invoice lines: linesZone() the lines to look at, findLine() which are invoice lines (highlighted), readLine() reads
// each of them on its own (an error marks that line in red, the others go on).
// The application completes: missing period = consumption period (R6), penalty borne by the owner.
import { AMOUNT, DATE, InvoiceExtractor, rx, type Category } from 'extractor'

const LINE = rx`^(.+?)\s+du (${DATE}) au (${DATE})\s.*?(${AMOUNT}) €$`

export default class NewSupplierExtractor extends InvoiceExtractor {
  readonly energy = 'eau'

  recognizes() {
    return this.doc.text.includes('NOM DU FOURNISSEUR')
  }

  invoiceNumber() {
    return this.capture(this.doc.text, /Facture n° (\S+)/)
  }

  invoiceDate() {
    return this.frenchDate(this.capture(this.doc.text, rx`Date de la facture : (${DATE})`))
  }

  total() {
    return this.amount(this.capture(this.doc.text, rx`Total TTC\s+(${AMOUNT}) €`))
  }

  linesZone() {
    return this.between(this.doc.lines, /Détail/, /^Total/)
  }

  findLine(line: string) {
    return line.match(LINE)
  }

  readLine([, label, start, end, amount]: RegExpMatchArray) {
    return {
      ...this.categorize(label!),
      start: this.frenchDate(start),
      end: this.frenchDate(end),
      amount: this.amount(amount),
    }
  }

  /** Category and normalised label, from the start of the printed label. */
  private categorize(label: string): { category: Category, label: string } {
    if (label.startsWith('Consommation')) return { category: 'consommation', label }
    if (label.startsWith('Abonnement')) return { category: 'abonnement', label }
    return { category: 'autre', label }
  }
}

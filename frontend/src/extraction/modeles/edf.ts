// EDF électricité (Tarif Bleu), mises en page 2023-2026. Each line of the detail holds on one text line:
// « label   du DD/MM/YYYY au DD/MM/YYYY   …   excl. VAT €   VAT % ». EDF prints no amount including VAT per line:
// excl. VAT × (1 + VAT), rounded to the cent (a 0.01 € gap with the total is possible).
// Masked on the copy joined to the supporting documents: the customer's accounts and contract, the bank account, the
// mail sorting code; labels stay readable, and so do the delivery point and the meter (they name the building, not the
// customer).
import { AMOUNT, DATE, InvoiceExtractor, rx, type Category, type Redaction } from 'extractor'

const LINE = rx`^(.+?)\s+du (${DATE}) au (${DATE})\s.*?(${AMOUNT}) €\s+(${AMOUNT}) %$`

export default class EdfExtractor extends InvoiceExtractor {
  readonly energy = 'electricity'

  recognizes() {
    return this.doc.text.includes('EDF') && this.doc.text.includes('Détail de votre facture')
  }

  invoiceNumber() {
    return this.capture(this.doc.text, rx`Détail de votre facture du ${DATE} n° (\d+)`)
  }

  invoiceDate() {
    return this.frenchDate(this.capture(this.doc.text, rx`Détail de votre facture du (${DATE})`))
  }

  total() {
    return this.amount(this.capture(this.doc.text, rx`Total TTC pour ce site\s+(${AMOUNT}) €`))
  }

  linesZone() {
    return this.between(this.doc.lines, /Détail de votre facture du/, /^Total TTC pour ce site/)
  }

  findLine(line: string) {
    return line.match(LINE)
  }

  readLine([, label, start, end, excludingVat, vat]: RegExpMatchArray) {
    return {
      ...this.categorize(label!),
      start: this.frenchDate(start),
      end: this.frenchDate(end),
      amount: this.withVat(excludingVat, vat),
    }
  }

  redactions(): Redaction[] {
    return [
      // Mail sorting code, printed above the address
      { pattern: /\bFLX\d+-\w+/ },
      { pattern: /(?<=Compte de facturation :)\s*\S+/ },
      { pattern: /(?<=Compte commercial :)\s*\S+/ },
      { pattern: /(?<=Réf\. de votre contrat)\s*\S+/ },
      { pattern: /(?<=sur le compte bancaire :)\s*FR[\dX ]*\d[\dX ]*/ },
    ]
  }

  /** Category and normalised label, from the start of the printed label. */
  private categorize(label: string): { category: Category, label: string } {
    if (label.startsWith('Electricit')) return { category: 'consumption', label: 'Consommation électricité' }
    if (label.startsWith('Abonnement')) return { category: 'subscription', label: 'Abonnement électricité' }
    if (label.startsWith('Contribution au Service') || label.startsWith('Accise')) {
      return { category: 'tax', label: 'Accise sur l\'électricité (ex-CSPE)' }
    }
    if (label.startsWith('Contribution Tarifaire')) {
      return { category: 'tax', label: 'CTA (Contribution Tarifaire d\'Acheminement)' }
    }
    return { category: 'other', label }
  }
}

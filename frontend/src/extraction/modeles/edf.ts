// EDF électricité (Tarif Bleu), mises en page 2023-2026. Each line of the detail holds on one text line:
// « label   du DD/MM/YYYY au DD/MM/YYYY   …   excl. VAT €   VAT % ». EDF prints no amount including VAT per line:
// excl. VAT × (1 + VAT), rounded to the cent (a 0.01 € gap with the total is possible).
import { AMOUNT, DATE, InvoiceExtractor, rx, type Category } from 'extractor'

const LINE = rx`^(.+?)\s+du (${DATE}) au (${DATE})\s.*?(${AMOUNT}) €\s+(${AMOUNT}) %$`

export default class EdfExtractor extends InvoiceExtractor {
  readonly energy = 'electricite'

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

  /** Category and normalised label, from the start of the printed label. */
  private categorize(label: string): { category: Category, label: string } {
    if (label.startsWith('Electricit')) return { category: 'consommation', label: 'Consommation électricité' }
    if (label.startsWith('Abonnement')) return { category: 'abonnement', label: 'Abonnement électricité' }
    if (label.startsWith('Contribution au Service') || label.startsWith('Accise')) {
      return { category: 'taxe', label: 'Accise sur l\'électricité (ex-CSPE)' }
    }
    if (label.startsWith('Contribution Tarifaire')) {
      return { category: 'taxe', label: 'CTA (Contribution Tarifaire d\'Acheminement)' }
    }
    return { category: 'autre', label }
  }
}

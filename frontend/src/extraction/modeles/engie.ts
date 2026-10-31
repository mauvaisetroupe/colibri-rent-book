// ENGIE Gaz Passerelle, mises en page 2023-2026. Header and total (« MONTANT TTC PRELEVE ») on page 1, detail from
// page 2 up to « TOTAL DE VOTRE FACTURE ». An invoice line ends with « excl. VAT   VAT   incl. VAT ». When the amounts
// are alone on their text line, the label is printed above and below:
//   Taxe Intérieure de Consommation sur le Gaz Naturel du
//   16935 0,00837   141,75   20,0   170,10
//   05/05 au 31/12/23
// Start year sometimes left out (« du 05/05 au 30/06/23 »); CTA and TICGN sometimes without period (consumption
// period, given by the application); late payment penalties (borne by the owner, dated on the invoice).
// Masked on the copy joined to the supporting documents: the customer's references, the direct debit (account holder,
// bank account, mandate) and the code « ZISUBILL » (invoice number then customer reference); labels stay readable.
import { AMOUNT, DATE, InvoiceExtractor, rx, type Category, type LineContext, type Redaction } from 'extractor'

const AMOUNTS = rx`(?:^|\s)(${AMOUNT})\s+(\d+,\d)\s+(${AMOUNT})$`
const PERIOD = /du (\d\d\/\d\d(?:\/\d\d)?) au (\d\d\/\d\d\/\d\d)/

export default class EngieExtractor extends InvoiceExtractor {
  readonly energy = 'gas'

  private get firstPage() {
    return this.doc.pages[0]?.join('\n') ?? ''
  }

  recognizes() {
    return this.doc.text.includes('ENGIE') && this.doc.text.includes('GAZ NATUREL')
  }

  invoiceNumber() {
    return this.capture(this.firstPage, /N°\s*(\d{3} \d{3} \d{3} \d{3})/)
  }

  invoiceDate() {
    return this.frenchDate(this.capture(this.firstPage, rx`FACTURE DU (${DATE})`))
  }

  total() {
    return this.amount(this.capture(this.firstPage, rx`MONTANT\s*TTC.*?(${AMOUNT}) €`))
  }

  linesZone() {
    const lines = this.doc.pages.slice(1).flat()
    const end = lines.findIndex((l) => l.startsWith('TOTAL DE VOTRE FACTURE'))
    return end < 0 ? lines : lines.slice(0, end)
  }

  findLine(line: string) {
    return /^Total/i.test(line) ? null : line.match(AMOUNTS)
  }

  readLine(match: RegExpMatchArray, { line, previous, next }: LineContext) {
    let label = line.slice(0, match.index).split('   ')[0]!.trim()
    if (!label || /^[\d ,]+$/.test(label)) {
      label = [previous, next].filter((l) => l && !AMOUNTS.test(l) && !/^\(\d\)$/.test(l)).join(' ')
    }
    const period = label.match(PERIOD)
    const end = period ? this.frenchDate(period[2]) : null
    return {
      ...this.categorize(label),
      start: period && end ? this.startFromEnd(period[1]!, end) : null,
      end,
      amount: this.amount(match[3]),
    }
  }

  redactions(): Redaction[] {
    return [
      { pattern: /ZISUBILL\d+/ },
      { pattern: /(?<=Référence client :)\s*[\d ]*\d/ },
      { pattern: /(?<=Compte de contrats :)\s*\d+/ },
      { pattern: /(?<=Nom du titulaire du compte :).*?(?=\s{3}|$)/ },
      { pattern: /(?<=Référence Unique du Mandat :)\s*\S+/ },
      // The bank account, its last digits replaced by X
      { pattern: /\b\d{10,}X+\b/ },
    ]
  }

  /** Category and normalised label, from the start of the printed label (rentals are printed in capitals). */
  private categorize(label: string): { category: Category, label: string } {
    const upper = label.toUpperCase()
    if (label.startsWith('Abonnement')) return { category: 'subscription', label: 'Abonnement gaz' }
    if (label.startsWith('Régul')) return { category: 'subscription', label: 'Régularisation abonnement' }
    if (label.startsWith('au prorata') || label.startsWith('Consommation')) {
      return { category: 'consumption', label: 'Consommation gaz' }
    }
    if (label.startsWith('Contribution')) return { category: 'tax', label: 'CTA (Contribution Tarifaire d\'Acheminement)' }
    if (label.startsWith('Taxe')) return { category: 'tax', label: 'TICGN (Taxe Intérieure Conso Gaz Naturel)' }
    if (label.startsWith('PENAL')) return { category: 'penalty', label }
    if (upper.startsWith('LOCATION DE COMPTEUR')) return { category: 'service', label: 'Location compteur' }
    if (upper.startsWith('LOCATION')) return { category: 'service', label: 'Location bloc détente S300' }
    return { category: 'service', label }
  }
}

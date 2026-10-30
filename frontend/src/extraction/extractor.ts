import Big from 'big.js'

// Module 'extractor' (ADR 0013): what the code of an invoice extractor sees. An extractor is a class that extends
// InvoiceExtractor, written in the « Extracteurs » screen, stored by version and run in the browser only. The engine
// (moteur.ts) creates one instance per PDF and calls its methods one by one; an error is shown next to its field. For
// the invoice lines: linesZone() gives the text lines to look at, findLine() says which ones are invoice lines,
// readLine() reads each of them on its own (an error marks that line only, the others go on).
// Only import: big.js (decimal amounts, never JavaScript numbers). The editor gives this file to Monaco.

// Values stored in the database (SQL enums, French domain vocabulary)
export type Category = 'consommation' | 'abonnement' | 'taxe' | 'prestation' | 'penalite' | 'autre'
export type Energy = 'gaz' | 'electricite' | 'eau' | 'ordures_menageres' | 'autre'
/** recuperable: shared by the tenants; proprietaire: borne by the owner (penalties…); hors_immeuble: another property */
export type Allocation = 'recuperable' | 'proprietaire' | 'hors_immeuble'

/** The text of the PDF, grouped into lines with the grouping settings of the extractor. */
export type ExtractionDocument = {
  /** Lines of each page */
  pages: string[][]
  /** All the lines, page after page */
  lines: string[]
  /** All the lines joined with « \n » */
  text: string
}

/** An invoice line read by an extractor. Amount: decimal string (« 1234.56 »); dates ISO, both bounds included. */
export type ExtractedLine = {
  category: Category
  label: string
  /** Null when not printed: the engine gives the consumption period of the invoice (SPEC R6) */
  start: string | null
  end: string | null
  amount: string
  /** recuperable by default; a penalty is borne by the owner */
  allocation?: Allocation
  note?: string | null
}

/** Where a line of the zone is: its neighbours, for labels printed above or below. */
export type LineContext = {
  /** The text line */
  line: string
  /** Its position in the zone */
  index: number
  /** All the lines of the zone */
  lines: string[]
  previous: string | undefined
  next: string | undefined
}

export type InvoiceHeader = { number: string | null, date: string | null, total: string | null }

/**
 * What to mask on the copy of the invoice joined to a supporting document (ADR 0024): every occurrence of a text
 * (spaces ignored), every match of a regular expression on a line, or a fixed area of a page in fractions of its width
 * and height from the top-left corner (a scan without text, a payment slip). Page: 1 for the first one; omitted, every
 * page.
 */
export type Redaction =
  | { text: string }
  | { pattern: RegExp }
  | { page?: number, x0: number, y0: number, x1: number, y1: number }

/** A French amount: « 1 234,56 », « - 65,87 », « 0,07790 ». For rx`…`. */
export const AMOUNT = String.raw`(?:- ?)?\d{1,3}(?: \d{3})*,\d+`

/** A French date: « 17/10/2023 », « 04/03/24 ». For rx`…`. */
export const DATE = String.raw`\d\d\/\d\d\/\d{2,4}`

/**
 * A regular expression written without doubling the backslashes, where ${AMOUNT} and ${DATE} can be used:
 * rx`Total TTC pour ce site\s+(${AMOUNT}) €`
 */
export function rx(strings: TemplateStringsArray, ...patterns: string[]): RegExp {
  return new RegExp(String.raw({ raw: strings.raw }, ...patterns))
}

export abstract class InvoiceExtractor {
  /** Energy of the invoices of this supplier */
  abstract readonly energy: Energy
  protected readonly doc: ExtractionDocument

  constructor(doc: ExtractionDocument) {
    this.doc = doc
  }

  /** Does this extractor read this PDF? */
  abstract recognizes(): boolean
  /** Invoice number; null: not on this PDF, typed by hand in the draft */
  abstract invoiceNumber(): string | null
  /** Invoice date, ISO */
  abstract invoiceDate(): string | null
  /** Total including VAT, decimal string; null: not on this PDF (typed by hand) */
  abstract total(): string | null

  /** The text lines where the invoice lines are (default: the whole text). */
  linesZone(): string[] {
    return this.doc.lines
  }

  /** Is this line of the zone an invoice line? Its match (given to readLine), true, or null/false. */
  abstract findLine(line: string, context: LineContext): RegExpMatchArray | boolean | null | undefined

  /** Reads an invoice line found by findLine (or several, or none with null). */
  abstract readLine(match: RegExpMatchArray, context: LineContext): ExtractedLine | ExtractedLine[] | null

  /** Optional: last changes on the lines, once the header is read. */
  after(lines: ExtractedLine[], _header: InvoiceHeader): ExtractedLine[] {
    return lines
  }

  /**
   * Optional: what to mask on the copy joined to a supporting document (ADR 0024), on top of the terms masked on every
   * invoice (customer and contract references, delivery point…). Default: nothing more.
   */
  redactions(): Redaction[] {
    return []
  }

  // ---------------------------------------------------------------- helpers

  /** First group (or the whole match) of `regex` in `text`; an error « introuvable » when it does not match. */
  protected capture(text: string, regex: RegExp): string {
    const m = text.match(regex)
    if (!m) {
      throw new Error(`capture : introuvable : ${regex.source}`)
    }
    return (m[1] ?? m[0]).trim()
  }

  /** « 1 234,56 » → « 1234.56 » (spaces and narrow spaces dropped, decimal comma). */
  protected amount(text: string | undefined): string {
    const cleaned = (text ?? '').replace(/[\s  ]/g, '').replace(',', '.')
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
      throw new Error(`amount : « ${text ?? ''} » n'est pas un montant`)
    }
    return new Big(cleaned).toString()
  }

  /** Amount including VAT from the amount excluding VAT and the rate in % (« 5,50 »), rounded half up to the cent. */
  protected withVat(excludingVat: string | undefined, vatPercent: string | undefined): string {
    if (!excludingVat) {
      throw new Error('withVat : montant HT vide')
    }
    if (!vatPercent) {
      throw new Error('withVat : taux de TVA vide')
    }
    return new Big(this.amount(excludingVat)).times(new Big(1).plus(new Big(this.amount(vatPercent)).div(100)))
      .round(2, Big.roundHalfUp).toString()
  }

  /** Sum of decimal strings. */
  protected sum(amounts: string[]): string {
    return amounts.reduce((s, m) => s.plus(m), new Big(0)).toString()
  }

  /** « 17/10/2023 » or « 17/10/23 » → « 2023-10-17 ». */
  protected frenchDate(text: string | undefined): string {
    const m = (text ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/)
    if (!m) {
      throw new Error(`frenchDate : « ${text ?? ''} » n'est pas une date jj/mm/aaaa`)
    }
    const [, day, month, year] = m as unknown as [string, string, string, string]
    return `${year.length === 2 ? `20${year}` : year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  }

  /** Start of a period printed without its year (« du 05/05 au 30/06/23 »): the year comes from the ISO end date. */
  protected startFromEnd(start: string, endIso: string): string {
    if (start.split('/').length === 3) {
      return this.frenchDate(start)
    }
    const [day, month] = start.split('/')
    const [year, endMonth] = endIso.split('-')
    const y = Number(month) <= Number(endMonth) ? Number(year) : Number(year) - 1
    return this.frenchDate(`${day}/${month}/${y}`)
  }

  /** Lines after the first one matching `from`, up to the next one matching `to` (both left out). */
  protected between(lines: string[], from: RegExp, to: RegExp): string[] {
    const i = lines.findIndex((l) => from.test(l))
    if (i < 0) {
      return []
    }
    const j = lines.findIndex((l, k) => k > i && to.test(l))
    return lines.slice(i + 1, j < 0 ? undefined : j)
  }
}

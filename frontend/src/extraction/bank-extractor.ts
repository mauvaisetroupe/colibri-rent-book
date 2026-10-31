import Big from 'big.js'

// Module 'bank-extractor' (ADR 0018): what the code of a bank statement extractor sees. An extractor is a class that
// extends BankStatementExtractor, written in the editor, stored by version and run in the browser only, as the invoice
// extractors (ADR 0013). The engine (moteurReleve.ts) calls its methods one by one; an error is shown next to its
// field. Movements: movementsZone() gives the rows to look at, findMovement() says which ones start a movement,
// readMovement() reads each of them; the rows that follow a movement, up to the next one, are its detail (but those
// ignoreRow() leaves out). Unlike an invoice, a row comes with its pieces and their abscissa: a debit and a credit
// differ only by their column.
// Only import: big.js (decimal amounts, never JavaScript numbers). The editor gives this file to Monaco.

/** A piece of text of a row: its text and its horizontal extent, in points from the left of the page. */
export type Piece = { text: string, x: number, right: number }

/** A line of text of the PDF with its pieces. */
export type Row = {
  /** The line, as in doc.lines */
  text: string
  pieces: Piece[]
  /** Page number, from 1 */
  page: number
  /** Position in doc.rows */
  index: number
}

/** The text of the PDF: lines as for invoices, and rows (the same lines, with their pieces). */
export type StatementDocument = {
  pages: string[][]
  lines: string[]
  text: string
  rows: Row[]
}

export type Side = 'debit' | 'credit'

/** A movement as read by readMovement: amount positive, decimal string; its side says debit or credit. */
export type ReadMovement = {
  /** Date of the operation, ISO */
  date: string
  /** Value date, ISO (optional) */
  valueDate?: string | null
  label: string
  amount: string
  side: Side
}

/** Where a row of the zone is. */
export type MovementContext = {
  row: Row
  /** Its position in the zone */
  index: number
  /** All the rows of the zone */
  rows: Row[]
}

/** Totals printed on the statement (for the check), decimal strings; null: not printed. */
export type Totals = { debit: string | null, credit: string | null }

/** A French amount, with a dot or a space between thousands: « 1.697,54 », « 41 345,26 ». For rx`…`. */
export const AMOUNT = String.raw`(?:- ?)?\d{1,3}(?:[. ]\d{3})*,\d\d`

/** A French date: « 05/10/2026 ». For rx`…`. */
export const DATE = String.raw`\d\d\/\d\d\/\d{4}`

/** A regular expression written without doubling the backslashes, where ${AMOUNT} and ${DATE} can be used. */
export function rx(strings: TemplateStringsArray, ...patterns: string[]): RegExp {
  return new RegExp(String.raw({ raw: strings.raw }, ...patterns))
}

const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre',
  'décembre']

export abstract class BankStatementExtractor {
  protected readonly doc: StatementDocument

  constructor(doc: StatementDocument) {
    this.doc = doc
  }

  /** Does this extractor read this PDF? */
  abstract recognizes(): boolean
  /** Account number */
  abstract account(): string
  /** Date of the statement, ISO */
  abstract statementDate(): string
  /** Balance before the movements, decimal string (negative: overdrawn) */
  abstract openingBalance(): string
  /** Balance after the movements */
  abstract closingBalance(): string

  /** The rows where the movements are (default: every row). */
  movementsZone(): Row[] {
    return this.doc.rows
  }

  /** Does this row of the zone start a movement? Its match (given to readMovement), true, or null/false. */
  abstract findMovement(row: Row, context: MovementContext): RegExpMatchArray | boolean | null | undefined

  /** Reads a movement found by findMovement. */
  abstract readMovement(match: RegExpMatchArray, context: MovementContext): ReadMovement

  /** A row of the zone that is neither a movement nor part of the detail of one (page header or footer…). */
  ignoreRow(_row: Row): boolean {
    return false
  }

  /** Optional: totals of the debits and credits printed on the statement, checked against the movements read. */
  printedTotals(): Totals | null {
    return null
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

  /** « 1.697,54 », « 41 345,26 », « -12,00 » → « 1697.54 »… (dots and spaces between thousands, decimal comma). */
  protected amount(text: string | undefined): string {
    const cleaned = (text ?? '').replace(/[\s  .]/g, '').replace(',', '.')
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
      throw new Error(`amount : « ${text ?? ''} » n'est pas un montant`)
    }
    return new Big(cleaned).toString()
  }

  /** « 05/10/2026 » or « 05/10/26 » → « 2026-10-05 ». */
  protected frenchDate(text: string | undefined): string {
    const m = (text ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/)
    if (!m) {
      throw new Error(`frenchDate : « ${text ?? ''} » n'est pas une date jj/mm/aaaa`)
    }
    const [, day, month, year] = m as unknown as [string, string, string, string]
    return `${year.length === 2 ? `20${year}` : year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  }

  /** « 16 octobre 2026 », « 1er mars 2026 » → « 2026-10-16 », « 2026-03-01 ». */
  protected longFrenchDate(text: string | undefined): string {
    const m = (text ?? '').trim().toLowerCase().match(/^(\d{1,2})(?:er)? (\p{L}+) (\d{4})$/u)
    const month = m ? MOIS.indexOf(m[2]!) + 1 : 0
    if (!m || !month) {
      throw new Error(`longFrenchDate : « ${text ?? ''} » n'est pas une date « 16 octobre 2026 »`)
    }
    return `${m[3]}-${String(month).padStart(2, '0')}-${m[1]!.padStart(2, '0')}`
  }

  /** The rows whose text matches `regex`. */
  protected rowsMatching(regex: RegExp): Row[] {
    return this.doc.rows.filter((r) => regex.test(r.text))
  }

  /** Rows after the first one matching `from`, up to the next one matching `to` (both left out). */
  protected betweenRows(from: RegExp, to: RegExp): Row[] {
    const rows = this.doc.rows
    const i = rows.findIndex((r) => from.test(r.text))
    if (i < 0) {
      return []
    }
    const j = rows.findIndex((r, k) => k > i && to.test(r.text))
    return rows.slice(i + 1, j < 0 ? undefined : j)
  }

  /**
   * Under which column title is a piece (an amount): the title whose right edge is the closest to the right edge of
   * the piece (amounts are aligned on the right). The titles are looked for in the first row that has them all.
   * column(piece, { debit: /Débit/, credit: /Crédit/ }) → 'debit' or 'credit'.
   */
  protected column<K extends string>(piece: Piece, headers: Record<K, RegExp>): K {
    const noms = Object.keys(headers) as K[]
    const titres = this.doc.rows
      .map((r) => noms.map((n) => r.pieces.find((p) => headers[n].test(p.text))))
      .find((trouves) => trouves.every(Boolean))
    if (!titres) {
      throw new Error(`column : titres de colonnes introuvables (${noms.join(', ')})`)
    }
    let meilleur = noms[0]!
    let ecart = Infinity
    noms.forEach((n, i) => {
      const e = Math.abs(titres[i]!.right - piece.right)
      if (e < ecart) {
        ecart = e
        meilleur = n
      }
    })
    return meilleur
  }

  /** The amounts of a row by column: { debit: '4961.84', credit: '590' } (null where the row has none). */
  protected amountsByColumn<K extends string>(row: Row, headers: Record<K, RegExp>): Record<K, string | null> {
    const resultat = Object.fromEntries(Object.keys(headers).map((k) => [k, null])) as Record<K, string | null>
    for (const p of row.pieces.filter((x) => new RegExp(`^${AMOUNT}$`).test(x.text))) {
      resultat[this.column(p, headers)] = this.amount(p.text)
    }
    return resultat
  }
}

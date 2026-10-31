import Big from 'big.js'

import { AFFECTATIONS, CATEGORIES, NOTE_PERIODE_PAR_DEFAUT, type InvoiceLine } from './types.js'

// Invoice checks of SPEC § 6 (ADR 0004, 0013). Pure functions: the editing grid gets them live through POST /api/controle,
// the server runs them again before saving and validating. Lines may come straight from the grid, with any text in
// the fields: an input error (« input_error ») prevents saving the draft, any « erreur » blocks the validation, an
// « warning » is shown (the line is highlighted) but does not block anything.

export type Severity = 'error' | 'warning'

export type Finding = {
  severity: Severity
  code: string
  message: string
  // Index of the line in `lines`, null for the whole invoice
  line: number | null
  // Input error: the line cannot be stored as it is (invalid date, number or category)
  input_error: boolean
}

export type Checks = {
  lines_total: string
  gap: string
  // Sum of the lines = printed total, within the tolerance
  ok: boolean
  findings: Finding[]
  // No input error: the draft can be saved
  can_save: boolean
  // No « error »: the invoice can be validated
  can_validate: boolean
}

// Supplier VAT rounding (SPEC R10)
export const TOLERANCE_TOTAL = '0.05'

// How far a line may lie outside the consumption period of the invoice, in days, before a warning. Measured on the
// 22 fixtures: ENGIE rentals are billed one month late, an EDF CTA adjustment goes back 61 days, the EDF CTA ends one
// day after the consumption, the subscription is billed up to 6 months in advance (ENGIE).
export const TOLERANCE_PLAGE = { avant: 62, apres: 31, apresAbonnement: 200 }

const ISO_DATE = /^\d{4}-\d\d-\d\d$/
const DECIMAL = /^-?\d+(\.\d+)?$/

export const isDecimal = (text: string | null | undefined): text is string => !!text && DECIMAL.test(text)

type Add = (severity: Severity, code: string, message: string, line?: number | null, input_error?: boolean) => void

export function checkInvoice(invoice: { total_incl_tax: string | null, lines: InvoiceLine[] }): Checks {
  const findings: Finding[] = []
  const add: Add = (severity, code, message, line = null, input_error = false) =>
    findings.push({ severity, code, message, line, input_error })

  const total = invoice.lines
    .filter((l) => isDecimal(l.amount_incl_tax))
    .reduce((sum, l) => sum.plus(l.amount_incl_tax), new Big(0))
    .round(2, Big.roundHalfUp)
  let gap = new Big(0)
  let ok = false
  if (!invoice.total_incl_tax) {
    // Not on the PDF (ADR 0013): the draft is saved, the total is typed before the validation
    add('error', 'missing_total', 'Total imprimé à saisir')
  } else if (!isDecimal(invoice.total_incl_tax)) {
    add('error', 'invalid_total', 'Total imprimé invalide', null, true)
  } else {
    gap = new Big(invoice.total_incl_tax).minus(total)
    ok = gap.abs().lte(TOLERANCE_TOTAL)
    if (!ok) {
      add('error', 'total', `La somme des lignes (${euros(total)}) ne retombe pas sur le total imprimé `
        + `(${euros(invoice.total_incl_tax)}) : écart de ${euros(gap)}`)
    }
  }

  invoice.lines.forEach((line, i) => {
    if (!CATEGORIES.includes(line.category)) {
      add('error', 'invalid_category', `Catégorie inconnue : choisir parmi ${CATEGORIES.join(', ')}`, i, true)
    }
    if (!AFFECTATIONS.includes(line.allocation)) {
      add('error', 'invalid_allocation', 'Affectation inconnue : récupérable, propriétaire ou hors immeuble', i, true)
    }
    if (!line.label?.trim()) {
      add('error', 'empty_label', 'Libellé manquant', i, true)
    }
    if (!isValidDate(line.start) || !isValidDate(line.end)) {
      add('error', 'invalid_period', 'Période incomplète ou date invalide', i, true)
    } else if (line.start > line.end) {
      add('error', 'invalid_period', 'La date de début est après la date de fin', i, true)
    }
    if (!isDecimal(line.amount_incl_tax)) {
      add('error', 'invalid_amount', 'Montant TTC manquant ou invalide', i, true)
    }
    for (const [field, name] of [['kwh', 'kWh'], ['amount_excl_tax', 'montant HT'], ['vat_rate', 'taux de TVA']] as const) {
      const value = line[field]
      if (value !== null && value !== '' && !isDecimal(value)) {
        add('error', 'invalid_number', `Valeur invalide pour ${name} : ${value}`, i, true)
      }
    }
    if (line.category === 'penalty' && line.allocation !== 'owner') {
      add('error', 'penalty_to_owner', 'Une pénalité est forcément à la charge du propriétaire', i)
    }
    if (line.note === NOTE_PERIODE_PAR_DEFAUT) {
      add('warning', 'period_to_confirm', 'Période à confirmer : non imprimée sur la facture', i)
    }
  })

  checkConsumption(invoice.lines, add)
  checkRange(invoice.lines, add)

  return {
    lines_total: total.toString(),
    gap: gap.eq(0) ? '0' : gap.toString(),
    ok,
    findings,
    can_save: !findings.some((c) => c.input_error),
    can_validate: !findings.some((c) => c.severity === 'error'),
  }
}

/** Consumption sub-periods must follow each other without gap or overlap. */
function checkConsumption(lines: InvoiceLine[], add: Add) {
  const conso = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => line.category === 'consumption' && isValidDate(line.start) && isValidDate(line.end))
    .sort((a, b) => a.line.start.localeCompare(b.line.start))

  for (let k = 1; k < conso.length; k++) {
    const previous = conso[k - 1]
    const current = conso[k]
    if (!previous || !current) {
      continue
    }
    const expected = nextDay(previous.line.end)
    if (current.line.start > expected) {
      add('warning', 'consumption_gap',
        `Trou dans la consommation : rien du ${frenchDate(expected)} au ${frenchDate(previousDay(current.line.start))}`,
        current.i)
    } else if (current.line.start < expected) {
      add('warning', 'overlapping_consumption',
        `Consommation comptée deux fois : chevauche la line précédente jusqu'au ${frenchDate(previous.line.end)}`,
        current.i)
    }
  }
}

/**
 * Every period must lie within the consumption period of the invoice, with the tolerances above
 * (no check when the invoice has no consumption line, a penalty is dated on the invoice day).
 */
function checkRange(lines: InvoiceLine[], add: Add) {
  const conso = lines.filter((l) => l.category === 'consumption' && isValidDate(l.start) && isValidDate(l.end))
  const start = conso.map((l) => l.start).sort()[0]
  const end = conso.map((l) => l.end).sort().at(-1)
  if (!start || !end) {
    return
  }
  lines.forEach((line, i) => {
    if (line.category === 'consumption' || line.category === 'penalty'
      || !isValidDate(line.start) || !isValidDate(line.end)) {
      return
    }
    const after = line.category === 'subscription' ? TOLERANCE_PLAGE.apresAbonnement : TOLERANCE_PLAGE.apres
    if (line.start < shiftDays(start, -TOLERANCE_PLAGE.avant) || line.end > shiftDays(end, after)) {
      add('warning', 'period_out_of_range',
        `Période éloignée de la consommation facturée (du ${frenchDate(start)} au ${frenchDate(end)}) : à vérifier`, i)
    }
  })
}

export function isValidDate(text: string) {
  if (!ISO_DATE.test(text)) {
    return false
  }
  const date = new Date(`${text}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text)
}

function shiftDays(iso: string, days: number) {
  const date = new Date(`${iso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

const nextDay = (iso: string) => shiftDays(iso, 1)
const previousDay = (iso: string) => shiftDays(iso, -1)

const frenchDate = (iso: string) => iso.split('-').reverse().join('/')

const euros = (amount: Big | string) => `${new Big(amount).toFixed(2).replace('.', ',')} €`

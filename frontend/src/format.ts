import Big from 'big.js'

import { AFFECTATIONS, type Affectation, type Ligne } from './api'

// The one place where API values (ISO dates, decimal strings with a dot, VAT as a fraction) are turned into what
// the user reads and types (dd/mm/yyyy, French decimal comma, VAT in %), and back. No float on the way: what cannot
// be read is sent as typed, and the server checks report it.

const ISO = /^\d{4}-\d\d-\d\d$/
const FRENCH_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/

export const dateFr = (iso: string | null) => (iso && ISO.test(iso) ? iso.split('-').reverse().join('/') : iso ?? '')

export function dateIso(text: string): string {
  const value = text.trim()
  const match = value.match(FRENCH_DATE)
  if (!match) {
    return value
  }
  const [, day, month, year] = match
  const fullYear = year!.length === 2 ? `20${year}` : year
  return `${fullYear}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`
}

export const nombreFr = (value: string | null) => (value === null ? '' : value.replace('.', ','))

/** '1 234,5 €' → '1234.5'; empty → null; anything else is sent as typed. */
export function nombreApi(text: string): string | null {
  const value = text.replace(/[\s\u202f\u00a0€]/g, '').replace(',', '.')
  if (value === '') {
    return null
  }
  try {
    return new Big(value).toString()
  } catch {
    return text.trim()
  }
}

/** VAT rate: '0.055' → '5,5' (%) and back. */
export function tauxFr(rate: string | null) {
  if (rate === null) {
    return ''
  }
  try {
    return nombreFr(new Big(rate).times(100).toString())
  } catch {
    return rate
  }
}

export function tauxApi(text: string): string | null {
  const percent = nombreApi(text.replace('%', ''))
  if (percent === null) {
    return null
  }
  try {
    return new Big(percent).div(100).toString()
  } catch {
    return percent
  }
}

/** Amount for reading: '1234.5' → '1 234,50 €'. */
export function euros(value: string | null | undefined) {
  if (value === null || value === undefined || value === '') {
    return ''
  }
  try {
    const [units, cents] = new Big(value).toFixed(2).split('.')
    return `${units!.replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f')},${cents} €`
  } catch {
    return value
  }
}

/** Exercise of a regularisation, short: '2025', or '2024-2025' over two years (inclusive ISO dates). */
export const exerciceCourt = (start: string, end: string) =>
  start.slice(0, 4) === end.slice(0, 4) ? start.slice(0, 4) : `${start.slice(0, 4)}-${end.slice(0, 4)}`

// « Affectation » column (ADR 0013): the label, its first letter, or oui/non as in the former « Récup. » column; empty is
// recoverable. Anything else is sent as typed and reported by the server checks.
const ALIAS: Record<string, Affectation> = {
  '': 'recoverable', oui: 'recoverable', o: 'recoverable', r: 'recoverable', recoverable: 'recoverable',
  non: 'owner', n: 'owner', p: 'owner', owner: 'owner',
  h: 'outside_building', horsimmeuble: 'outside_building',
}

export function affectationApi(text: string): Affectation {
  const key = text.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f\s_-]/g, '')
  return ALIAS[key] ?? (text.trim() as Affectation)
}

// A row of the editing grid: every cell holds the text the user sees and types
export type LigneGrille = Record<keyof Ligne, string> & { _classe: string }

export const versGrille = (l: Ligne): LigneGrille => ({
  category: l.category,
  label: l.label,
  start: dateFr(l.start),
  end: dateFr(l.end),
  kwh: nombreFr(l.kwh),
  amount_excl_tax: nombreFr(l.amount_excl_tax),
  vat_rate: tauxFr(l.vat_rate),
  amount_incl_tax: nombreFr(l.amount_incl_tax),
  allocation: AFFECTATIONS[l.allocation] ?? l.allocation,
  note: l.note ?? '',
  _classe: '',
})

export function depuisGrille(row: LigneGrille): Ligne {
  return {
    category: String(row.category ?? '').trim().toLowerCase() as Ligne['category'],
    label: String(row.label ?? '').trim(),
    start: dateIso(String(row.start ?? '')),
    end: dateIso(String(row.end ?? '')),
    kwh: nombreApi(String(row.kwh ?? '')),
    amount_excl_tax: nombreApi(String(row.amount_excl_tax ?? '')),
    vat_rate: tauxApi(String(row.vat_rate ?? '')),
    amount_incl_tax: nombreApi(String(row.amount_incl_tax ?? '')) ?? '',
    allocation: affectationApi(String(row.allocation ?? '')),
    note: String(row.note ?? '').trim() || null,
  }
}

export const ligneVide = (): LigneGrille => ({
  category: '', label: '', start: '', end: '', kwh: '', amount_excl_tax: '', vat_rate: '', amount_incl_tax: '',
  allocation: AFFECTATIONS.recoverable, note: '', _classe: '',
})

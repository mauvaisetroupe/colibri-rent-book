import Big from 'big.js'

// Display formats of documents produced by the server (PDF, mails, Excel titles): French, rounded to the cent here
// only (SPEC R10).

export const frenchDate = (iso: string) => iso.split('-').reverse().join('/')

/** '1733.9512' → '1 733,95 €'. No-break space between thousands: the narrow one is missing from some PDF fonts. */
export function euros(value: string | Big) {
  const rounded = new Big(value).round(2, Big.roundHalfUp)
  const [units, cents] = rounded.toFixed(2).split('.')
  // -0.001 rounds to zero: no « -0,00 »
  const sign = rounded.lt(0) ? '-' : ''
  const digits = units!.replace('-', '').replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')
  return `${sign}${digits},${cents}\u00a0€`
}

const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre',
  'novembre', 'décembre']

/** '2026-11-01' → 'novembre 2026'. */
export const monthYear = (iso: string) => `${MOIS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`

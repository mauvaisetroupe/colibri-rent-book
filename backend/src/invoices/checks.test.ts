import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { checkInvoice } from './checks.js'
import { NOTE_PERIODE_PAR_DEFAUT, type InvoiceLine } from './types.js'

const line = (overrides: Partial<InvoiceLine>): InvoiceLine => ({
  category: 'consumption',
  label: 'Consommation gaz',
  start: '2024-01-01',
  end: '2024-01-31',
  kwh: '1000',
  amount_excl_tax: '100',
  vat_rate: '0.2',
  amount_incl_tax: '120',
  allocation: 'recoverable',
  note: null,
  ...overrides,
})

const january = line({})
const february = line({ start: '2024-02-01', end: '2024-02-29', amount_incl_tax: '80.004' })

const codes = (lines: InvoiceLine[], amount = '200') =>
  checkInvoice({ total_incl_tax: amount, lines }).findings.map((c) => `${c.severity}:${c.code}:${c.line}`)

describe('invoice checks (SPEC § 6)', () => {
  test('a clean invoice passes', () => {
    const checks = checkInvoice({ total_incl_tax: '200', lines: [january, february] })
    assert.deepEqual(checks, {
      lines_total: '200', gap: '0', ok: true, findings: [], can_save: true, can_validate: true,
    })
  })

  test('total within 0.05 € is accepted, beyond it blocks the validation', () => {
    assert.equal(checkInvoice({ total_incl_tax: '200.05', lines: [january, february] }).can_validate, true)
    const checks = checkInvoice({ total_incl_tax: '200.06', lines: [january, february] })
    assert.equal(checks.ok, false)
    assert.equal(checks.gap, '0.06')
    assert.deepEqual(codes([january, february], '200.06'), ['error:total:null'])
  })

  test('the sum is rounded to the cent only once, after adding 3-decimal lines', () => {
    const lines = [line({ amount_incl_tax: '0.004' }), line({ start: '2024-02-01', end: '2024-02-29', amount_incl_tax: '0.004' })]
    assert.equal(checkInvoice({ total_incl_tax: '0.01', lines }).lines_total, '0.01')
  })

  test('a truncated label with a right amount but a wrong period is caught (gap)', () => {
    // February read as starting on the 2nd: the total is right, the consumption has a hole
    const wrong = { ...february, start: '2024-02-02' }
    assert.deepEqual(codes([january, wrong]), ['warning:consumption_gap:1'])
  })

  test('overlapping consumption periods are flagged', () => {
    const wrong = { ...february, start: '2024-01-31' }
    assert.deepEqual(codes([january, wrong]), ['warning:overlapping_consumption:1'])
  })

  test('consumption lines are checked in date order, whatever their order on the invoice', () => {
    assert.deepEqual(codes([february, january]), [])
  })

  test('a penalty must not be recoverable', () => {
    const penalty = line({ category: 'penalty', label: 'PENALITES', start: '2024-03-04', end: '2024-03-04',
      kwh: null, amount_incl_tax: '0' })
    assert.deepEqual(codes([january, february, penalty]), ['error:penalty_to_owner:2'])
    assert.deepEqual(codes([january, february, { ...penalty, allocation: 'owner' as const }]), [])
  })

  test('invalid or reversed periods block the validation', () => {
    assert.deepEqual(codes([{ ...january, end: '2024-02-30' }, february]), ['error:invalid_period:0'])
    assert.deepEqual(codes([{ ...january, start: '' }, february]), ['error:invalid_period:0'])
    // Reversed January now starts after February: it is the one overlapping
    assert.deepEqual(codes([{ ...january, start: '2024-02-15' }, february]), [
      'error:invalid_period:0',
      'warning:overlapping_consumption:0',
    ])
  })

  test('an empty label blocks the validation', () => {
    assert.deepEqual(codes([{ ...january, label: ' ' }, february]), ['error:empty_label:0'])
  })

  test('text typed in the grid that cannot be stored prevents saving the draft', () => {
    const typed = { ...january, category: 'conso' as never, kwh: '1 000', amount_incl_tax: '120,00' }
    const checks = checkInvoice({ total_incl_tax: '200', lines: [typed, february] })
    assert.deepEqual(checks.findings.map((c) => c.code), [
      'total', 'invalid_category', 'invalid_amount', 'invalid_number',
    ])
    assert.equal(checks.can_save, false)
    // The invalid amount is left out of the sum
    assert.equal(checks.lines_total, '80')
  })

  test('a total mismatch still allows saving the draft, not validating it', () => {
    const checks = checkInvoice({ total_incl_tax: '999', lines: [january, february] })
    assert.equal(checks.can_save, true)
    assert.equal(checks.can_validate, false)
  })

  test('a period set by default is flagged « à confirmer » (SPEC R6)', () => {
    const cta = line({ category: 'tax', label: 'CTA', start: '2024-01-01', end: '2024-02-29', kwh: null,
      amount_incl_tax: '0', note: NOTE_PERIODE_PAR_DEFAUT })
    assert.deepEqual(codes([january, february, cta]), ['warning:period_to_confirm:2'])
  })

  test('a period far from the consumption is flagged, the subscription may be billed in advance', () => {
    const subscription = line({ category: 'subscription', label: 'Abonnement gaz', start: '2024-03-01',
      end: '2024-08-31', kwh: null, amount_incl_tax: '0' })
    const oldRental = line({ category: 'service', label: 'Location compteur', start: '2022-10-27',
      end: '2023-05-04', kwh: null, amount_incl_tax: '0' })
    assert.deepEqual(codes([january, february, subscription]), [])
    assert.deepEqual(codes([january, february, oldRental]), ['warning:period_out_of_range:2'])
    assert.deepEqual(codes([january, february, { ...subscription, category: 'service' }]), [
      'warning:period_out_of_range:2',
    ])
  })
})

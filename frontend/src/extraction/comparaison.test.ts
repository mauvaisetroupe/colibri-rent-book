import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { Ligne } from '../api'
import { ecarts } from './comparaison'

// « Tester sur les factures »: an invoice completed by hand (total, management fees) is no failure; a line read badly is.

const ligne = (label: string, amount: string, autre: Partial<Ligne> = {}): Ligne => ({
  category: 'tax', label, start: '2026-01-01', end: '2026-12-31', kwh: null, amount_excl_tax: null, vat_rate: null,
  amount_incl_tax: amount, allocation: 'recoverable', note: null, ...autre,
})

const LUES = [ligne('TEOM', '437'), ligne('Taxe foncière (hors TEOM)', '1522', { allocation: 'owner' })]

describe('comparison of a reading with a stored invoice', () => {
  test('total typed by hand and a line added by hand: remarks, no difference', () => {
    const { differences, remarques } = ecarts(
      { number: 'A1', date: '2026-08-10', total: null, lines: LUES },
      {
        number: 'A1', invoice_date: '2026-08-10', total_incl_tax: '2050',
        // Stored in another order, with the fees added by hand
        lines: [LUES[1]!, ligne('Frais de gestion', '91', { allocation: 'owner' }), LUES[0]!],
      },
    )
    assert.deepEqual(differences, [])
    assert.deepEqual(remarques, [
      'total saisi à la main',
      'ligne ajoutée à la main : « Frais de gestion » du 2026-01-01 au 2026-12-31, 91',
    ])
  })

  test('an amount or an allocation that differs, a line read but not stored: differences', () => {
    const { differences } = ecarts(
      { number: 'A1', date: '2026-08-10', total: '2000', lines: [...LUES, ligne('Nouvelle ligne', '41')] },
      {
        number: 'A1', invoice_date: '2026-08-10', total_incl_tax: '2000',
        lines: [ligne('TEOM', '436'), ligne('Taxe foncière (hors TEOM)', '1522')],
      },
    )
    assert.deepEqual(differences, [
      '« TEOM » du 2026-01-01 au 2026-12-31 : montant 437 au lieu de 436',
      '« Taxe foncière (hors TEOM) » du 2026-01-01 au 2026-12-31 : affectation « owner » au lieu de « recoverable »',
      'ligne lue absente de la base : « Nouvelle ligne » du 2026-01-01 au 2026-12-31, 41',
    ])
  })

  test('lines that do not add up to the total read', () => {
    const { differences } = ecarts(
      { number: 'A1', date: '2026-08-10', total: '2000', lines: LUES },
      { number: 'A1', invoice_date: '2026-08-10', total_incl_tax: '2000', lines: LUES },
    )
    assert.deepEqual(differences, ['somme des lignes lues 1959.00 ≠ total lu 2000'])
  })
})

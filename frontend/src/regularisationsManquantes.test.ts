import assert from 'node:assert/strict'
import { test } from 'node:test'

import Big from 'big.js'

import type { Decompte, LigneDecompte, Regularisation } from './api'
import { anneesARegulariser, regularisationsManquantes } from './regularisationsManquantes'

const tenancy = (tenancy_id: number, present_from: string, present_to: string, total: string, advances: string) => ({
  tenancy_id, tenant: `L${tenancy_id}`, unit: 'Lot', present_from, present_to, days: 1, total, advances,
  balance: new Big(total).minus(advances).toString(),
}) as LigneDecompte
const charge_statement = (tenancies: LigneDecompte[]) => ({ start: '2024-01-01', end: '2024-12-31', tenancies }) as Decompte
const charge_adjustment = (tenancy_id: number, start: string, end: string, replaced_by: number | null = null) =>
  ({ tenancy_id, start, end, replaced_by }) as Regularisation

test('a stay of a finished exercise without a regularisation is missing, whichever way the balance goes', () => {
  const d = charge_statement([
    tenancy(1, '2024-01-01', '2024-12-31', '1200', '1000'), // owes
    tenancy(2, '2024-01-01', '2024-06-30', '400', '600'), // is owed
    tenancy(3, '2024-01-01', '2024-12-31', '900', '900'), // zero balance, still to send
    tenancy(4, '2024-01-01', '2024-12-31', '1000', '800'), // regularised
  ])
  const m = regularisationsManquantes(d, [charge_adjustment(4, '2024-01-01', '2024-12-31')], '2025-03-01')
  assert.deepEqual(m.map((x) => x.tenancy.tenancy_id), [1, 2, 3])
  assert.equal(m[0]!.start, '2024-01-01')
})

test('a regularisation over a longer period covers the stay; a replaced one does not', () => {
  const d = charge_statement([tenancy(1, '2024-01-01', '2024-12-31', '10', '0'), tenancy(2, '2024-03-01', '2024-12-31', '10', '0')])
  const r = [charge_adjustment(1, '2024-01-01', '2025-12-31'), charge_adjustment(2, '2024-01-01', '2024-12-31', 9)]
  assert.deepEqual(regularisationsManquantes(d, r, '2025-03-01').map((x) => x.tenancy.tenancy_id), [2])
})

test('nothing for an exercise not finished, nor for a stay without charges or provisions', () => {
  const d = charge_statement([tenancy(1, '2024-01-01', '2024-12-31', '0', '0')])
  assert.deepEqual(regularisationsManquantes(d, [], '2025-03-01'), [])
  assert.deepEqual(regularisationsManquantes(charge_statement([tenancy(2, '2024-01-01', '2024-12-31', '5', '0')]), [], '2024-12-31'), [])
})

test('the years to look at start with the first regularisation and end with the last finished year', () => {
  assert.deepEqual(anneesARegulariser([charge_adjustment(1, '2023-01-01', '2023-12-31'), charge_adjustment(1, '2025-01-01', '2025-12-31')], '2026-10-19'),
    [2023, 2024, 2025])
  assert.deepEqual(anneesARegulariser([], '2026-10-19'), [])
})

test('nothing is missing before the start of the management of the building (ADR 0023)', () => {
  const d = charge_statement([tenancy(1, '2024-01-01', '2024-12-31', '1200', '1000')])
  assert.deepEqual(regularisationsManquantes(d, [], '2025-03-01', '2025-01-01'), [])
  assert.equal(regularisationsManquantes(d, [], '2025-03-01', '2024-01-01').length, 1)
  assert.deepEqual(anneesARegulariser([], '2026-10-24', '2023-01-01'), [2023, 2024, 2025])
})

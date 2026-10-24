import assert from 'node:assert/strict'
import { test } from 'node:test'

import Big from 'big.js'

import type { Decompte, LigneDecompte, Regularisation } from './api'
import { anneesARegulariser, regularisationsManquantes } from './regularisationsManquantes'

const sejour = (sejour_id: number, present_du: string, present_au: string, total: string, provisions: string) => ({
  sejour_id, locataire: `L${sejour_id}`, lot: 'Lot', present_du, present_au, jours: 1, total, provisions,
  solde: new Big(total).minus(provisions).toString(),
}) as LigneDecompte
const decompte = (sejours: LigneDecompte[]) => ({ debut: '2024-01-01', fin: '2024-12-31', sejours }) as Decompte
const regularisation = (sejour_id: number, debut: string, fin: string, remplacee_par: number | null = null) =>
  ({ sejour_id, debut, fin, remplacee_par }) as Regularisation

test('a stay of a finished exercise without a regularisation is missing, whichever way the balance goes', () => {
  const d = decompte([
    sejour(1, '2024-01-01', '2024-12-31', '1200', '1000'), // owes
    sejour(2, '2024-01-01', '2024-06-30', '400', '600'), // is owed
    sejour(3, '2024-01-01', '2024-12-31', '900', '900'), // zero balance, still to send
    sejour(4, '2024-01-01', '2024-12-31', '1000', '800'), // regularised
  ])
  const m = regularisationsManquantes(d, [regularisation(4, '2024-01-01', '2024-12-31')], '2025-03-01')
  assert.deepEqual(m.map((x) => x.sejour.sejour_id), [1, 2, 3])
  assert.equal(m[0]!.debut, '2024-01-01')
})

test('a regularisation over a longer period covers the stay; a replaced one does not', () => {
  const d = decompte([sejour(1, '2024-01-01', '2024-12-31', '10', '0'), sejour(2, '2024-03-01', '2024-12-31', '10', '0')])
  const r = [regularisation(1, '2024-01-01', '2025-12-31'), regularisation(2, '2024-01-01', '2024-12-31', 9)]
  assert.deepEqual(regularisationsManquantes(d, r, '2025-03-01').map((x) => x.sejour.sejour_id), [2])
})

test('nothing for an exercise not finished, nor for a stay without charges or provisions', () => {
  const d = decompte([sejour(1, '2024-01-01', '2024-12-31', '0', '0')])
  assert.deepEqual(regularisationsManquantes(d, [], '2025-03-01'), [])
  assert.deepEqual(regularisationsManquantes(decompte([sejour(2, '2024-01-01', '2024-12-31', '5', '0')]), [], '2024-12-31'), [])
})

test('the years to look at start with the first regularisation and end with the last finished year', () => {
  assert.deepEqual(anneesARegulariser([regularisation(1, '2023-01-01', '2023-12-31'), regularisation(1, '2025-01-01', '2025-12-31')], '2026-10-19'),
    [2023, 2024, 2025])
  assert.deepEqual(anneesARegulariser([], '2026-10-19'), [])
})

test('nothing is missing before the start of the management of the building (ADR 0023)', () => {
  const d = decompte([sejour(1, '2024-01-01', '2024-12-31', '1200', '1000')])
  assert.deepEqual(regularisationsManquantes(d, [], '2025-03-01', '2025-01-01'), [])
  assert.equal(regularisationsManquantes(d, [], '2025-03-01', '2024-01-01').length, 1)
  assert.deepEqual(anneesARegulariser([], '2026-10-24', '2023-01-01'), [2023, 2024, 2025])
})

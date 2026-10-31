import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Echeance, Paiement, Regularisation, Sejour } from './api'
import { dusDuSejour, partageMois } from './depot'

const tenancy = { id: 1, move_in: '2024-01-01', move_out: '2024-04-30' } as Sejour
const rent_schedules = [{ id: 1, tenancy_id: 1, from_month: '2024-01-01', rent: '500', charge_advance: '100', note: null }] as Echeance[]
const payment = (month: string | null, rent: string, extra: Partial<Paiement> = {}) =>
  ({ id: 1, tenancy_id: 1, month: month && `${month}-01`, rent, charge_advance: month ? '100' : '0', charge_adjustment_id: null, charge_adjustment: '0', method: 'transfer', ...extra }) as Paiement
const charge_adjustment = (id: number, end: string, balance: string, recu: string, extra: Partial<Regularisation> = {}) =>
  ({ id, tenancy_id: 1, start: `${end.slice(0, 4)}-01-01`, end, balance, amount_received: recu, state: 'pending', replaced_by: null, decision: null, ...extra }) as Regularisation

test('unpaid months and open regularisations, the oldest first, up to the deposit', () => {
  const payments = [payment('2024-01', '500'), payment('2024-02', '500'), payment('2024-03', '300')]
  const regs = [charge_adjustment(7, '2023-12-31', '250', '50'), charge_adjustment(8, '2025-12-31', '100', '0', { decision: 'written_off' })]
  const d = dusDuSejour(tenancy, rent_schedules, payments, regs, '600', '2026-10-19')
  assert.deepEqual(d.map((x) => [x.label, x.du, x.propose]), [
    ['Régularisation 2023', '200', '200'], ['Loyer 03/2024', '200', '200'], ['Loyer 04/2024', '600', '200'],
  ])
  assert.deepEqual(partageMois(d[2]!, '550'), { rent: '500', charge_advance: '50' })
})

test('the current retention is left out of what was paid', () => {
  const payments = [payment('2024-01', '500'), payment('2024-02', '500'), payment('2024-03', '500'), payment('2024-04', '500'),
    payment(null, '0', { method: 'deposit', charge_adjustment_id: 7, charge_adjustment: '200' })]
  const d = dusDuSejour(tenancy, rent_schedules, payments, [charge_adjustment(7, '2023-12-31', '250', '250', { state: 'settled' })], '410', '2026-10-19')
  assert.deepEqual(d.map((x) => [x.label, x.du, x.propose]), [['Régularisation 2023', '200', '200']])
})

test('no provision proposed for a month a regularisation covers: its balance already holds it', () => {
  const payments = [payment('2024-01', '500'), payment('2024-02', '500', { charge_advance: '60' }), payment('2024-03', '450', { charge_advance: '60' }),
    payment('2024-04', '500')]
  const d = dusDuSejour(tenancy, rent_schedules, payments, [charge_adjustment(9, '2024-12-31', '300', '0')], '410', '2026-10-19')
  assert.deepEqual(d.map((x) => [x.label, x.rent, x.charge_advance, x.propose]), [
    ['Loyer 03/2024', '50', '0', '50'], ['Régularisation 2024', '0', '0', '300'],
  ])
})

test('a replaced regularisation no longer covers its months', () => {
  const payments = [payment('2024-01', '500', { charge_advance: '60' }), payment('2024-02', '500'), payment('2024-03', '500'), payment('2024-04', '500')]
  const regs = [charge_adjustment(9, '2024-12-31', '300', '0', { replaced_by: 10, state: 'draft' })]
  const d = dusDuSejour(tenancy, rent_schedules, payments, regs, '410', '2026-10-19')
  assert.deepEqual(d.map((x) => [x.label, x.charge_advance, x.propose]), [['Loyer 01/2024', '40', '40']])
})

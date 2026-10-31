import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Regularisation } from './api'
import { regularisationCourante } from './rectification'

const charge_adjustment = (id: number, replaced_by: number | null) => ({ id, replaced_by }) as Regularisation

test('a payment toward a corrected regularisation goes to its last corrective one', () => {
  const regs = [charge_adjustment(7, 19), charge_adjustment(19, 25), charge_adjustment(25, null), charge_adjustment(8, null)]
  assert.equal(regularisationCourante(7, regs), 25)
  assert.equal(regularisationCourante(19, regs), 25)
  assert.equal(regularisationCourante(8, regs), 8)
  assert.equal(regularisationCourante(99, regs), 99)
})

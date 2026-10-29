import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Regularisation } from './api'
import { regularisationCourante } from './rectification'

const regularisation = (id: number, remplacee_par: number | null) => ({ id, remplacee_par }) as Regularisation

test('a payment toward a corrected regularisation goes to its last corrective one', () => {
  const regs = [regularisation(7, 19), regularisation(19, 25), regularisation(25, null), regularisation(8, null)]
  assert.equal(regularisationCourante(7, regs), 25)
  assert.equal(regularisationCourante(19, regs), 25)
  assert.equal(regularisationCourante(8, regs), 8)
  assert.equal(regularisationCourante(99, regs), 99)
})

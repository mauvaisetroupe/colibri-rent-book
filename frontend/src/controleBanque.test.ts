import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Mouvement, Paiement, ReleveResume } from './api'
import { etatBanque, nbProblemesBanque } from './controleBanque'

const releve = (statement_date: string, suite: boolean | null): ReleveResume => ({
  id: 0, bank: 'Banque', account: '100', statement_date, previous_balance: '0', new_balance: '0', pdf: true,
  extractor_id: 1, imported_at: statement_date, transaction_count: 1, suite,
})
const bank_transaction = (transaction_date: string, status: Mouvement['status']) => ({ id: 1, transaction_date, status }) as Mouvement
const payment = (payment_date: string, bank_transaction_id: number | null) => ({ id: 1, payment_date, bank_transaction_id }) as Paiement

test('payments outside the dates the statements cover are not reported', () => {
  const statements = [releve('2025-02-28', null), releve('2025-03-31', true), releve('2025-05-31', false)]
  const payments = [payment('2025-01-15', null), payment('2025-03-05', null), payment('2025-03-06', 7), payment('2025-07-01', null)]
  const e = etatBanque(statements, [], payments, '2025-01-01', '2025-12-31', '2026-03-01')
  assert.deepEqual(e.sansMouvement.map((p) => p.payment_date), ['2025-03-05'])
  assert.deepEqual(e.comptes[0]!.manquants, ['2025-05-31'])
  assert.equal(e.finManquante, '2025-05-31')
})

test('the movements of the exercise only, by status', () => {
  const transactions = [bank_transaction('2024-12-31', 'to_categorise'), bank_transaction('2025-02-01', 'to_categorise'),
    bank_transaction('2025-02-02', 'incomplet'), bank_transaction('2025-02-03', 'categorise')]
  const e = etatBanque([releve('2025-12-31', null)], transactions, [], '2025-01-01', '2025-12-31', '2026-01-10')
  assert.equal(e.aCategoriser.length, 1)
  assert.equal(e.incomplets.length, 1)
  assert.equal(e.finManquante, null)
  assert.equal(nbProblemesBanque(e), 2)
})

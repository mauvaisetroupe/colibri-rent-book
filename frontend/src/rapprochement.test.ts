import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Echeance, Mouvement, Paiement, Regularisation, Sejour } from './api'
import { categoriePropose, moisDuMouvement, motsDuNom, proposer, sejourDuMouvement } from './rapprochement'

// Proposals of the « Banque » screen (ADR 0018), on made-up tenants.

const tenancy = (id: number, tenant: string, move_in: string, move_out: string | null = null) =>
  ({ id, unit_id: id, unit: `Lot ${id}`, tenant_id: id, tenant, move_in, move_out, note: null, security_deposit: null, deposit_retained: null, deposit_held: null }) as Sejour
const tenancies = [tenancy(1, 'Alice MARTIN (ex DURAND)', '2024-01-01'), tenancy(2, 'Bruno Étienne', '2025-08-17'), tenancy(3, 'Carla MARTIN', '2020-01-01', '2022-06-30')]
const bank_transaction = (label: string, amount: string, date = '2026-02-03', detail: string | null = null) =>
  ({ id: 1, label, detail, amount, transaction_date: date, covered: '0' }) as Mouvement

test('the words of a name, without titles and short words', () => {
  assert.deepEqual(motsDuNom('Hélène DUPONT (ex MARTIN)'), ['HELENE', 'DUPONT', 'MARTIN'])
})

test('the tenant named in the label or the detail, present around the date', () => {
  assert.equal(sejourDuMouvement(bank_transaction('VIR DE MME ALICE MARTIN', '600'), tenancies)?.id, 1)
  assert.equal(sejourDuMouvement(bank_transaction('VIR INST', '600', '2026-02-03', 'MR ETIENNE BRUNO\nLOYER'), tenancies)?.id, 2)
  // Carla Martin left in 2022: Alice (two words) wins; nobody named: null
  assert.equal(sejourDuMouvement(bank_transaction('LOYER DURAND.A', '600'), tenancies)?.id, 1)
  assert.equal(sejourDuMouvement(bank_transaction('VIR CAF', '600'), tenancies), null)
  // A name cut by the bank, from four letters on
  assert.equal(sejourDuMouvement(bank_transaction('LOYER ET RAPPEL DE CHARGES ETIE', '600'), tenancies)?.id, 2)
  assert.equal(sejourDuMouvement(bank_transaction('LOYER ET RAPPEL DE CHARGES ETI', '600'), tenancies), null)
})

test('the month written in the movement, else that of the operation', () => {
  assert.equal(moisDuMouvement(bank_transaction('VIR', '1', '2025-02-07', 'LOYER 02/25')), '2025-02')
  assert.equal(moisDuMouvement(bank_transaction('LOYER 12/2024 MARTIN', '1', '2025-01-03')), '2024-12')
  assert.equal(moisDuMouvement(bank_transaction('VIR DE MARTIN', '1', '2025-03-05')), '2025-03')
})

test('a credit is split as called, or shows the difference', () => {
  const rent_schedules: Echeance[] = [{ id: 1, tenancy_id: 1, from_month: '2024-01-01', rent: '500', charge_advance: '100', note: null }]
  const juste = proposer(bank_transaction('VIR DE ALICE MARTIN', '600'), tenancies, rent_schedules, [])
  assert.deepEqual([juste.tenancy?.id, juste.month, juste.rent, juste.charge_advance, juste.ecart], [1, '2026-02', '500', '100', null])
  // Less: the rent first, then the provision; never more rent than the stay's
  const ecart = proposer(bank_transaction('VIR DE ALICE MARTIN', '580'), tenancies, rent_schedules, [])
  assert.deepEqual([ecart.rent, ecart.charge_advance], ['500', '80'])
  assert.match(ecart.ecart!, /appelé 600\.00 €, reçu 580\.00 €/)
  // More, no regularisation to pay: the amounts called, the difference shown
  const plus = proposer(bank_transaction('LOYER ET RAPPEL DE CHARGES MARTIN', '910.25'), tenancies, rent_schedules, [])
  assert.deepEqual([plus.rent, plus.charge_advance, plus.charge_adjustment_id], ['500', '100', null])
  assert.match(plus.ecart!, /reçu 910\.25 €/)
  // More, a regularisation still to pay: the excess goes to it
  const regul = { id: 4, tenancy_id: 1, state: 'pending', start: '2025-01-01', balance: '640.50', amount_received: '0' } as Regularisation
  const avecRegul = proposer(bank_transaction('LOYER ET RAPPEL DE CHARGES MARTIN', '910.25'), tenancies, rent_schedules, [regul])
  assert.deepEqual([avecRegul.rent, avecRegul.charge_advance, avecRegul.charge_adjustment_id, avecRegul.charge_adjustment], ['500', '100', 4, '310.25'])
  // Two to pay: the one already paid in instalments of that amount
  const autre = { id: 5, tenancy_id: 1, state: 'pending', start: '2024-01-01', balance: '755', amount_received: '310.25' } as Regularisation
  const versement = [{ id: 8, tenancy_id: 1, month: null, charge_adjustment_id: 5, charge_adjustment: '310.25' }] as unknown as Paiement[]
  const deux = proposer(bank_transaction('LOYER ET RAPPEL DE CHARGES MARTIN', '910.25'), tenancies, rent_schedules,
    [{ ...regul, start: '2025-01-01' }, autre], versement)
  assert.equal(deux.charge_adjustment_id, 5)
})

test('the category: words of the label, else the tenant named in it', () => {
  assert.equal(categoriePropose(bank_transaction('ECH PRET CAP+IN 01234 567890 07', '-1697.54')), 'loan')
  assert.equal(categoriePropose(bank_transaction('PRLV SEPA ENGIE', '-455.53')), 'energy')
  assert.equal(categoriePropose(bank_transaction('AURORE 2000 BS4076264', '-84.99', '2026-01-01', 'ACM IARD SA')), 'insurance')
  assert.equal(categoriePropose(bank_transaction('FACT SGT26010000000001', '-13.78')), 'bank_fees')
  assert.equal(categoriePropose(bank_transaction('FACTURE SGT22010000000002', '-33.47')), 'bank_fees')
  assert.equal(categoriePropose(bank_transaction('VIR INST FACTURE N 2026 10 002', '-2710')), null)
  assert.equal(categoriePropose(bank_transaction('VIR DE ALICE MARTIN', '600'), tenancies), 'tenant')
  assert.equal(categoriePropose(bank_transaction('VIR DEPOT GARANTIE ALICE MARTIN', '-600'), tenancies), 'security_deposit')
  assert.equal(categoriePropose(bank_transaction('VIR APPORT CAPITAL', '-10000')), 'partners')
})

test('a month already partly paid: only what is still due is proposed', () => {
  const rent_schedules: Echeance[] = [{ id: 1, tenancy_id: 1, from_month: '2024-01-01', rent: '430', charge_advance: '160', note: null }]
  const deja = [{ id: 9, tenancy_id: 1, month: '2026-02-01', rent: '430', charge_advance: '100' }] as Paiement[]
  const p = proposer({ ...bank_transaction('VIR DE ALICE MARTIN', '590'), covered: '530' } as Mouvement, tenancies, rent_schedules, [], deja)
  assert.deepEqual([p.rent, p.charge_advance, p.ecart], ['0', '60', null])
})

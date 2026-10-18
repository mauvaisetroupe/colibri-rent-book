import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Mouvement, Paiement, ReleveResume } from './api'
import { etatBanque, nbProblemesBanque } from './controleBanque'

const releve = (date_releve: string, suite: boolean | null): ReleveResume => ({
  id: 0, banque: 'Banque', compte: '100', date_releve, solde_precedent: '0', nouveau_solde: '0', pdf: true,
  extracteur_id: 1, importe_le: date_releve, nb_mouvements: 1, suite,
})
const mouvement = (date_operation: string, statut: Mouvement['statut']) => ({ id: 1, date_operation, statut }) as Mouvement
const paiement = (date_paiement: string, mouvement_id: number | null) => ({ id: 1, date_paiement, mouvement_id }) as Paiement

test('payments outside the dates the statements cover are not reported', () => {
  const releves = [releve('2025-02-28', null), releve('2025-03-31', true), releve('2025-05-31', false)]
  const paiements = [paiement('2025-01-15', null), paiement('2025-03-05', null), paiement('2025-03-06', 7), paiement('2025-07-01', null)]
  const e = etatBanque(releves, [], paiements, '2025-01-01', '2025-12-31', '2026-03-01')
  assert.deepEqual(e.sansMouvement.map((p) => p.date_paiement), ['2025-03-05'])
  assert.deepEqual(e.comptes[0]!.manquants, ['2025-05-31'])
  assert.equal(e.finManquante, '2025-05-31')
})

test('the movements of the exercise only, by status', () => {
  const mouvements = [mouvement('2024-12-31', 'a_categoriser'), mouvement('2025-02-01', 'a_categoriser'),
    mouvement('2025-02-02', 'incomplet'), mouvement('2025-02-03', 'categorise')]
  const e = etatBanque([releve('2025-12-31', null)], mouvements, [], '2025-01-01', '2025-12-31', '2026-01-10')
  assert.equal(e.aCategoriser.length, 1)
  assert.equal(e.incomplets.length, 1)
  assert.equal(e.finManquante, null)
  assert.equal(nbProblemesBanque(e), 2)
})

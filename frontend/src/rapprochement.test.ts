import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Echeance, Mouvement, Sejour } from './api'
import { moisDuMouvement, motifPropose, motsDuNom, proposer, sejourDuMouvement } from './rapprochement'

// Proposals of the « Banque » screen (ADR 0018), on made-up tenants.

const sejour = (id: number, locataire: string, entree: string, sortie: string | null = null) =>
  ({ id, lot_id: id, lot: `Lot ${id}`, locataire_id: id, locataire, entree, sortie, note: null, depot_garantie: null, depot_retenu_charges: null }) as Sejour
const sejours = [sejour(1, 'Alice MARTIN (ex DURAND)', '2024-01-01'), sejour(2, 'Bruno Étienne', '2025-08-17'), sejour(3, 'Carla MARTIN', '2020-01-01', '2022-06-30')]
const mouvement = (libelle: string, montant: string, date = '2026-02-03', detail: string | null = null) =>
  ({ id: 1, libelle, detail, montant, date_operation: date, couvert: '0' }) as Mouvement

test('the words of a name, without titles and short words', () => {
  assert.deepEqual(motsDuNom('Hélène DUPONT (ex MARTIN)'), ['HELENE', 'DUPONT', 'MARTIN'])
})

test('the tenant named in the label or the detail, present around the date', () => {
  assert.equal(sejourDuMouvement(mouvement('VIR DE MME ALICE MARTIN', '600'), sejours)?.id, 1)
  assert.equal(sejourDuMouvement(mouvement('VIR INST', '600', '2026-02-03', 'MR ETIENNE BRUNO\nLOYER'), sejours)?.id, 2)
  // Carla Martin left in 2022: Alice (two words) wins; nobody named: null
  assert.equal(sejourDuMouvement(mouvement('LOYER DURAND.A', '600'), sejours)?.id, 1)
  assert.equal(sejourDuMouvement(mouvement('VIR CAF', '600'), sejours), null)
})

test('the month written in the movement, else that of the operation', () => {
  assert.equal(moisDuMouvement(mouvement('VIR', '1', '2025-02-07', 'LOYER 02/25')), '2025-02')
  assert.equal(moisDuMouvement(mouvement('LOYER 12/2024 MARTIN', '1', '2025-01-03')), '2024-12')
  assert.equal(moisDuMouvement(mouvement('VIR DE MARTIN', '1', '2025-03-05')), '2025-03')
})

test('a credit is split as called, or shows the difference', () => {
  const echeances: Echeance[] = [{ id: 1, sejour_id: 1, a_partir_du: '2024-01-01', loyer: '500', provision: '100', note: null }]
  const juste = proposer(mouvement('VIR DE ALICE MARTIN', '600'), sejours, echeances, [])
  assert.deepEqual([juste.sejour?.id, juste.mois, juste.loyer, juste.provision, juste.ecart], [1, '2026-02', '500', '100', null])
  const ecart = proposer(mouvement('VIR DE ALICE MARTIN', '580'), sejours, echeances, [])
  assert.deepEqual([ecart.loyer, ecart.provision], ['480', '100'])
  assert.match(ecart.ecart!, /appelé 600\.00 €, reçu 580\.00 €/)
})

test('a debit gets a reason from its label', () => {
  assert.equal(motifPropose(mouvement('ECH PRET CAP+IN 01234 567890 07', '-1697.54')), 'Emprunt')
  assert.equal(motifPropose(mouvement('PRLV SEPA ENGIE', '-455.53')), 'Facture d\'énergie (prélèvement)')
  assert.equal(motifPropose(mouvement('AURORE 2000 BS4076264', '-84.99', '2026-01-01', 'ACM IARD SA')), 'Assurance')
  assert.equal(motifPropose(mouvement('FACT SGT26010000000001', '-13.78')), 'Frais bancaires')
  assert.equal(motifPropose(mouvement('FACTURE SGT22010000000002', '-33.47')), 'Frais bancaires')
  assert.equal(motifPropose(mouvement('VIR INST FACTURE N 2026 10 002', '-2710')), null)
  assert.equal(motifPropose(mouvement('VIR DE ALICE', '600')), null)
})

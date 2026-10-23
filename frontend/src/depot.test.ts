import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Echeance, Paiement, Regularisation, Sejour } from './api'
import { dusDuSejour, partageMois } from './depot'

const sejour = { id: 1, entree: '2024-01-01', sortie: '2024-04-30' } as Sejour
const echeances = [{ id: 1, sejour_id: 1, a_partir_du: '2024-01-01', loyer: '500', provision: '100', note: null }] as Echeance[]
const paiement = (mois: string | null, loyer: string, extra: Partial<Paiement> = {}) =>
  ({ id: 1, sejour_id: 1, mois: mois && `${mois}-01`, loyer, provision: mois ? '100' : '0', regularisation_id: null, regularisation: '0', mode: 'virement', ...extra }) as Paiement
const regularisation = (id: number, fin: string, solde: string, recu: string, extra: Partial<Regularisation> = {}) =>
  ({ id, sejour_id: 1, debut: `${fin.slice(0, 4)}-01-01`, fin, solde, montant_recu: recu, etat: 'en_attente', remplacee_par: null, decision: null, ...extra }) as Regularisation

test('unpaid months and open regularisations, the oldest first, up to the deposit', () => {
  const paiements = [paiement('2024-01', '500'), paiement('2024-02', '500'), paiement('2024-03', '300')]
  const regs = [regularisation(7, '2023-12-31', '250', '50'), regularisation(8, '2025-12-31', '100', '0', { decision: 'abandonnee' })]
  const d = dusDuSejour(sejour, echeances, paiements, regs, '600', '2026-10-19')
  assert.deepEqual(d.map((x) => [x.libelle, x.du, x.propose]), [
    ['Régularisation 2023', '200', '200'], ['Loyer 03/2024', '200', '200'], ['Loyer 04/2024', '600', '200'],
  ])
  assert.deepEqual(partageMois(d[2]!, '550'), { loyer: '500', provision: '50' })
})

test('the current retention is left out of what was paid', () => {
  const paiements = [paiement('2024-01', '500'), paiement('2024-02', '500'), paiement('2024-03', '500'), paiement('2024-04', '500'),
    paiement(null, '0', { mode: 'depot', regularisation_id: 7, regularisation: '200' })]
  const d = dusDuSejour(sejour, echeances, paiements, [regularisation(7, '2023-12-31', '250', '250', { etat: 'soldee' })], '410', '2026-10-19')
  assert.deepEqual(d.map((x) => [x.libelle, x.du, x.propose]), [['Régularisation 2023', '200', '200']])
})

test('no provision proposed for a month a regularisation covers: its balance already holds it', () => {
  const paiements = [paiement('2024-01', '500'), paiement('2024-02', '500', { provision: '60' }), paiement('2024-03', '450', { provision: '60' }),
    paiement('2024-04', '500')]
  const d = dusDuSejour(sejour, echeances, paiements, [regularisation(9, '2024-12-31', '300', '0')], '410', '2026-10-19')
  assert.deepEqual(d.map((x) => [x.libelle, x.loyer, x.provision, x.propose]), [
    ['Loyer 03/2024', '50', '0', '50'], ['Régularisation 2024', '0', '0', '300'],
  ])
})

test('a replaced regularisation no longer covers its months', () => {
  const paiements = [paiement('2024-01', '500', { provision: '60' }), paiement('2024-02', '500'), paiement('2024-03', '500'), paiement('2024-04', '500')]
  const regs = [regularisation(9, '2024-12-31', '300', '0', { remplacee_par: 10, etat: 'brouillon' })]
  const d = dusDuSejour(sejour, echeances, paiements, regs, '410', '2026-10-19')
  assert.deepEqual(d.map((x) => [x.libelle, x.provision, x.propose]), [['Loyer 01/2024', '40', '40']])
})

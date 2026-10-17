import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { Ligne } from '../api'
import { ecarts } from './comparaison'

// « Tester sur les factures »: an invoice completed by hand (total, management fees) is no failure; a line read badly is.

const ligne = (libelle: string, montant: string, autre: Partial<Ligne> = {}): Ligne => ({
  categorie: 'taxe', libelle, debut: '2026-01-01', fin: '2026-12-31', kwh: null, montant_ht: null, taux_tva: null,
  montant_ttc: montant, affectation: 'recuperable', note: null, ...autre,
})

const LUES = [ligne('TEOM', '437'), ligne('Taxe foncière (hors TEOM)', '1522', { affectation: 'proprietaire' })]

describe('comparison of a reading with a stored invoice', () => {
  test('total typed by hand and a line added by hand: remarks, no difference', () => {
    const { differences, remarques } = ecarts(
      { numero: 'A1', date: '2026-08-10', total: null, lignes: LUES },
      {
        numero: 'A1', date_facture: '2026-08-10', montant_ttc: '2050',
        // Stored in another order, with the fees added by hand
        lignes: [LUES[1]!, ligne('Frais de gestion', '91', { affectation: 'proprietaire' }), LUES[0]!],
      },
    )
    assert.deepEqual(differences, [])
    assert.deepEqual(remarques, [
      'total saisi à la main',
      'ligne ajoutée à la main : « Frais de gestion » du 2026-01-01 au 2026-12-31, 91',
    ])
  })

  test('an amount or an allocation that differs, a line read but not stored: differences', () => {
    const { differences } = ecarts(
      { numero: 'A1', date: '2026-08-10', total: '2000', lignes: [...LUES, ligne('Nouvelle ligne', '41')] },
      {
        numero: 'A1', date_facture: '2026-08-10', montant_ttc: '2000',
        lignes: [ligne('TEOM', '436'), ligne('Taxe foncière (hors TEOM)', '1522')],
      },
    )
    assert.deepEqual(differences, [
      '« TEOM » du 2026-01-01 au 2026-12-31 : montant 437 au lieu de 436',
      '« Taxe foncière (hors TEOM) » du 2026-01-01 au 2026-12-31 : affectation « proprietaire » au lieu de « recuperable »',
      'ligne lue absente de la base : « Nouvelle ligne » du 2026-01-01 au 2026-12-31, 41',
    ])
  })

  test('lines that do not add up to the total read', () => {
    const { differences } = ecarts(
      { numero: 'A1', date: '2026-08-10', total: '2000', lignes: LUES },
      { numero: 'A1', date_facture: '2026-08-10', montant_ttc: '2000', lignes: LUES },
    )
    assert.deepEqual(differences, ['somme des lignes lues 1959.00 ≠ total lu 2000'])
  })
})

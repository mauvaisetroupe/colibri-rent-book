import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { checkInvoice } from './checks.js'
import { NOTE_PERIODE_PAR_DEFAUT, type InvoiceLine } from './types.js'

const line = (overrides: Partial<InvoiceLine>): InvoiceLine => ({
  categorie: 'consommation',
  libelle: 'Consommation gaz',
  debut: '2024-01-01',
  fin: '2024-01-31',
  kwh: '1000',
  montant_ht: '100',
  taux_tva: '0.2',
  montant_ttc: '120',
  affectation: 'recuperable',
  note: null,
  ...overrides,
})

const january = line({})
const february = line({ debut: '2024-02-01', fin: '2024-02-29', montant_ttc: '80.004' })

const codes = (lignes: InvoiceLine[], montant = '200') =>
  checkInvoice({ montant_ttc: montant, lignes }).constats.map((c) => `${c.severite}:${c.code}:${c.ligne}`)

describe('invoice checks (SPEC § 6)', () => {
  test('a clean invoice passes', () => {
    const controle = checkInvoice({ montant_ttc: '200', lignes: [january, february] })
    assert.deepEqual(controle, {
      total_lignes: '200', ecart: '0', ok: true, constats: [], enregistrable: true, validable: true,
    })
  })

  test('total within 0.05 € is accepted, beyond it blocks the validation', () => {
    assert.equal(checkInvoice({ montant_ttc: '200.05', lignes: [january, february] }).validable, true)
    const controle = checkInvoice({ montant_ttc: '200.06', lignes: [january, february] })
    assert.equal(controle.ok, false)
    assert.equal(controle.ecart, '0.06')
    assert.deepEqual(codes([january, february], '200.06'), ['erreur:total:null'])
  })

  test('the sum is rounded to the cent only once, after adding 3-decimal lines', () => {
    const lignes = [line({ montant_ttc: '0.004' }), line({ debut: '2024-02-01', fin: '2024-02-29', montant_ttc: '0.004' })]
    assert.equal(checkInvoice({ montant_ttc: '0.01', lignes }).total_lignes, '0.01')
  })

  test('a truncated label with a right amount but a wrong period is caught (gap)', () => {
    // February read as starting on the 2nd: the total is right, the consumption has a hole
    const wrong = { ...february, debut: '2024-02-02' }
    assert.deepEqual(codes([january, wrong]), ['avertissement:consommation_trou:1'])
  })

  test('overlapping consumption periods are flagged', () => {
    const wrong = { ...february, debut: '2024-01-31' }
    assert.deepEqual(codes([january, wrong]), ['avertissement:consommation_chevauchement:1'])
  })

  test('consumption lines are checked in date order, whatever their order on the invoice', () => {
    assert.deepEqual(codes([february, january]), [])
  })

  test('a penalty must not be recoverable', () => {
    const penalty = line({ categorie: 'penalite', libelle: 'PENALITES', debut: '2024-03-04', fin: '2024-03-04',
      kwh: null, montant_ttc: '0' })
    assert.deepEqual(codes([january, february, penalty]), ['erreur:penalite_proprietaire:2'])
    assert.deepEqual(codes([january, february, { ...penalty, affectation: 'proprietaire' as const }]), [])
  })

  test('invalid or reversed periods block the validation', () => {
    assert.deepEqual(codes([{ ...january, fin: '2024-02-30' }, february]), ['erreur:periode_invalide:0'])
    assert.deepEqual(codes([{ ...january, debut: '' }, february]), ['erreur:periode_invalide:0'])
    // Reversed January now starts after February: it is the one overlapping
    assert.deepEqual(codes([{ ...january, debut: '2024-02-15' }, february]), [
      'erreur:periode_invalide:0',
      'avertissement:consommation_chevauchement:0',
    ])
  })

  test('an empty label blocks the validation', () => {
    assert.deepEqual(codes([{ ...january, libelle: ' ' }, february]), ['erreur:libelle_vide:0'])
  })

  test('text typed in the grid that cannot be stored prevents saving the draft', () => {
    const typed = { ...january, categorie: 'conso' as never, kwh: '1 000', montant_ttc: '120,00' }
    const controle = checkInvoice({ montant_ttc: '200', lignes: [typed, february] })
    assert.deepEqual(controle.constats.map((c) => c.code), [
      'total', 'categorie_invalide', 'montant_invalide', 'nombre_invalide',
    ])
    assert.equal(controle.enregistrable, false)
    // The invalid amount is left out of the sum
    assert.equal(controle.total_lignes, '80')
  })

  test('a total mismatch still allows saving the draft, not validating it', () => {
    const controle = checkInvoice({ montant_ttc: '999', lignes: [january, february] })
    assert.equal(controle.enregistrable, true)
    assert.equal(controle.validable, false)
  })

  test('a period set by default is flagged « à confirmer » (SPEC R6)', () => {
    const cta = line({ categorie: 'taxe', libelle: 'CTA', debut: '2024-01-01', fin: '2024-02-29', kwh: null,
      montant_ttc: '0', note: NOTE_PERIODE_PAR_DEFAUT })
    assert.deepEqual(codes([january, february, cta]), ['avertissement:periode_a_confirmer:2'])
  })

  test('a period far from the consumption is flagged, the subscription may be billed in advance', () => {
    const subscription = line({ categorie: 'abonnement', libelle: 'Abonnement gaz', debut: '2024-03-01',
      fin: '2024-08-31', kwh: null, montant_ttc: '0' })
    const oldRental = line({ categorie: 'prestation', libelle: 'Location compteur', debut: '2022-10-27',
      fin: '2023-05-04', kwh: null, montant_ttc: '0' })
    assert.deepEqual(codes([january, february, subscription]), [])
    assert.deepEqual(codes([january, february, oldRental]), ['avertissement:periode_hors_plage:2'])
    assert.deepEqual(codes([january, february, { ...subscription, categorie: 'prestation' }]), [
      'avertissement:periode_hors_plage:2',
    ])
  })
})

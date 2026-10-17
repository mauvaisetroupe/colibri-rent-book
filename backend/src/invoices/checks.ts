import Big from 'big.js'

import { AFFECTATIONS, CATEGORIES, NOTE_PERIODE_PAR_DEFAUT, type InvoiceLine } from './types.js'

// Invoice checks of SPEC § 6 (ADR 0004, 0013). Pure functions: the editing grid gets them live through POST /api/controle,
// the server runs them again before saving and validating. Lines may come straight from the grid, with any text in
// the fields: an input error (« saisie ») prevents saving the draft, any « erreur » blocks the validation, an
// « avertissement » is shown (the line is highlighted) but does not block anything.

export type Severite = 'erreur' | 'avertissement'

export type Constat = {
  severite: Severite
  code: string
  message: string
  // Index of the line in `lignes`, null for the whole invoice
  ligne: number | null
  // Input error: the line cannot be stored as it is (invalid date, number or category)
  saisie: boolean
}

export type Controle = {
  total_lignes: string
  ecart: string
  // Sum of the lines = printed total, within the tolerance
  ok: boolean
  constats: Constat[]
  // No input error: the draft can be saved
  enregistrable: boolean
  // No « erreur »: the invoice can be validated
  validable: boolean
}

// Supplier VAT rounding (SPEC R10)
export const TOLERANCE_TOTAL = '0.05'

// How far a line may lie outside the consumption period of the invoice, in days, before a warning. Measured on the
// 22 fixtures: ENGIE rentals are billed one month late, an EDF CTA adjustment goes back 61 days, the EDF CTA ends one
// day after the consumption, the subscription is billed up to 6 months in advance (ENGIE).
export const TOLERANCE_PLAGE = { avant: 62, apres: 31, apresAbonnement: 200 }

const ISO_DATE = /^\d{4}-\d\d-\d\d$/
const DECIMAL = /^-?\d+(\.\d+)?$/

export const isDecimal = (text: string | null | undefined): text is string => !!text && DECIMAL.test(text)

type Add = (severite: Severite, code: string, message: string, ligne?: number | null, saisie?: boolean) => void

export function checkInvoice(invoice: { montant_ttc: string | null, lignes: InvoiceLine[] }): Controle {
  const constats: Constat[] = []
  const add: Add = (severite, code, message, ligne = null, saisie = false) =>
    constats.push({ severite, code, message, ligne, saisie })

  const total = invoice.lignes
    .filter((l) => isDecimal(l.montant_ttc))
    .reduce((sum, l) => sum.plus(l.montant_ttc), new Big(0))
    .round(2, Big.roundHalfUp)
  let ecart = new Big(0)
  let ok = false
  if (!invoice.montant_ttc) {
    // Not on the PDF (ADR 0013): the draft is saved, the total is typed before the validation
    add('erreur', 'total_manquant', 'Total imprimé à saisir')
  } else if (!isDecimal(invoice.montant_ttc)) {
    add('erreur', 'total_invalide', 'Total imprimé invalide', null, true)
  } else {
    ecart = new Big(invoice.montant_ttc).minus(total)
    ok = ecart.abs().lte(TOLERANCE_TOTAL)
    if (!ok) {
      add('erreur', 'total', `La somme des lignes (${euros(total)}) ne retombe pas sur le total imprimé `
        + `(${euros(invoice.montant_ttc)}) : écart de ${euros(ecart)}`)
    }
  }

  invoice.lignes.forEach((line, i) => {
    if (!CATEGORIES.includes(line.categorie)) {
      add('erreur', 'categorie_invalide', `Catégorie inconnue : choisir parmi ${CATEGORIES.join(', ')}`, i, true)
    }
    if (!AFFECTATIONS.includes(line.affectation)) {
      add('erreur', 'affectation_invalide', 'Affectation inconnue : récupérable, propriétaire ou hors immeuble', i, true)
    }
    if (!line.libelle?.trim()) {
      add('erreur', 'libelle_vide', 'Libellé manquant', i, true)
    }
    if (!isValidDate(line.debut) || !isValidDate(line.fin)) {
      add('erreur', 'periode_invalide', 'Période incomplète ou date invalide', i, true)
    } else if (line.debut > line.fin) {
      add('erreur', 'periode_invalide', 'La date de début est après la date de fin', i, true)
    }
    if (!isDecimal(line.montant_ttc)) {
      add('erreur', 'montant_invalide', 'Montant TTC manquant ou invalide', i, true)
    }
    for (const [field, name] of [['kwh', 'kWh'], ['montant_ht', 'montant HT'], ['taux_tva', 'taux de TVA']] as const) {
      const value = line[field]
      if (value !== null && value !== '' && !isDecimal(value)) {
        add('erreur', 'nombre_invalide', `Valeur invalide pour ${name} : ${value}`, i, true)
      }
    }
    if (line.categorie === 'penalite' && line.affectation !== 'proprietaire') {
      add('erreur', 'penalite_proprietaire', 'Une pénalité est forcément à la charge du propriétaire', i)
    }
    if (line.note === NOTE_PERIODE_PAR_DEFAUT) {
      add('avertissement', 'periode_a_confirmer', 'Période à confirmer : non imprimée sur la facture', i)
    }
  })

  checkConsumption(invoice.lignes, add)
  checkRange(invoice.lignes, add)

  return {
    total_lignes: total.toString(),
    ecart: ecart.eq(0) ? '0' : ecart.toString(),
    ok,
    constats,
    enregistrable: !constats.some((c) => c.saisie),
    validable: !constats.some((c) => c.severite === 'erreur'),
  }
}

/** Consumption sub-periods must follow each other without gap or overlap. */
function checkConsumption(lignes: InvoiceLine[], add: Add) {
  const conso = lignes
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => line.categorie === 'consommation' && isValidDate(line.debut) && isValidDate(line.fin))
    .sort((a, b) => a.line.debut.localeCompare(b.line.debut))

  for (let k = 1; k < conso.length; k++) {
    const previous = conso[k - 1]
    const current = conso[k]
    if (!previous || !current) {
      continue
    }
    const expected = nextDay(previous.line.fin)
    if (current.line.debut > expected) {
      add('avertissement', 'consommation_trou',
        `Trou dans la consommation : rien du ${frenchDate(expected)} au ${frenchDate(previousDay(current.line.debut))}`,
        current.i)
    } else if (current.line.debut < expected) {
      add('avertissement', 'consommation_chevauchement',
        `Consommation comptée deux fois : chevauche la ligne précédente jusqu'au ${frenchDate(previous.line.fin)}`,
        current.i)
    }
  }
}

/**
 * Every period must lie within the consumption period of the invoice, with the tolerances above
 * (no check when the invoice has no consumption line, a penalty is dated on the invoice day).
 */
function checkRange(lignes: InvoiceLine[], add: Add) {
  const conso = lignes.filter((l) => l.categorie === 'consommation' && isValidDate(l.debut) && isValidDate(l.fin))
  const start = conso.map((l) => l.debut).sort()[0]
  const end = conso.map((l) => l.fin).sort().at(-1)
  if (!start || !end) {
    return
  }
  lignes.forEach((line, i) => {
    if (line.categorie === 'consommation' || line.categorie === 'penalite'
      || !isValidDate(line.debut) || !isValidDate(line.fin)) {
      return
    }
    const after = line.categorie === 'abonnement' ? TOLERANCE_PLAGE.apresAbonnement : TOLERANCE_PLAGE.apres
    if (line.debut < shiftDays(start, -TOLERANCE_PLAGE.avant) || line.fin > shiftDays(end, after)) {
      add('avertissement', 'periode_hors_plage',
        `Période éloignée de la consommation facturée (du ${frenchDate(start)} au ${frenchDate(end)}) : à vérifier`, i)
    }
  })
}

export function isValidDate(text: string) {
  if (!ISO_DATE.test(text)) {
    return false
  }
  const date = new Date(`${text}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text)
}

function shiftDays(iso: string, days: number) {
  const date = new Date(`${iso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

const nextDay = (iso: string) => shiftDays(iso, 1)
const previousDay = (iso: string) => shiftDays(iso, -1)

const frenchDate = (iso: string) => iso.split('-').reverse().join('/')

const euros = (amount: Big | string) => `${new Big(amount).toFixed(2).replace('.', ',')} €`

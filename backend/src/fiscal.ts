import Big from 'big.js'
import type { Pool } from 'pg'

import { frenchDate } from './format.js'
import { inclusiveBounds } from './periods.js'
import { loadCouverture, loadDecompte } from './statements.js'

// Tax summary of a calendar year (SPEC § 9, to be checked by the accountant): charges borne during vacancy,
// recoverable charges not repaid by the 31/12 of the year a tenant left (whole stay), deposits kept for charges.
// Amounts are unrounded numeric text, rounded for display only.

export type Depart = {
  sejour_id: number
  locataire: string
  lot: string
  entree: string
  sortie: string
  charges: string
  provisions: string
  versements: string
  // charges − provisions − regularisation payments received by the 31/12 of the year of departure
  non_rembourse: string
  // Deductible part (positive amount not repaid)
  deductible: string
  depot_retenu: string
  // Periods of the stay not covered by validated invoices: the charges are then understated
  incomplet: string[]
}

export type SyntheseFiscale = {
  immeuble: number
  annee: number
  vacance: { energie: string, montant: string }[]
  total_vacance: string
  departs: Depart[]
  total_non_rembourse: string
  total_depots_retenus: string
  // Line 225 of the 2044 (charges récupérables non récupérées)
  total_deductible: string
  non_recuperables: { facture_id: number, fournisseur: string, numero: string, date_facture: string, libelle: string, montant: string }[]
  abandons_en_cours: { regularisation_id: number, locataire: string, lot: string, debut: string, fin: string, reste: string }[]
  // Works paid during the year (ADR 0015): the deductible ones for the 2044, line 224
  travaux: Travaux[]
  total_travaux_deductibles: string
  // Works invoiced but not paid yet: not in the year until paid
  travaux_non_payes: Travaux[]
}

export type Travaux = {
  id: number, fournisseur: string, description: string, nature: string, lot: string | null, date_facture: string,
  date_paiement: string | null, montant_ttc: string, deductible: boolean
}

const sum = (values: string[]) => values.reduce((s, v) => s.plus(v), new Big(0))

export async function syntheseFiscale(db: Pool, immeuble: number, annee: number): Promise<SyntheseFiscale> {
  const debut = `${annee}-01-01`
  const fin = `${annee}-12-31`

  // Vacancy: owner share of the recoverable charges of the year (SPEC R4)
  const { synthese } = await loadDecompte(db, { immeuble, debut, fin })
  const vacance = synthese.map((s) => ({ energie: s.energie, montant: s.proprietaire }))

  // Tenants who left during the year: their whole stay
  const { rows: sorties } = await db.query<{
    sejour_id: number, locataire: string, lot: string, entree: string, sortie: string, depot_retenu: string | null,
  }>(
    `SELECT s.id AS sejour_id, lo.nom AS locataire, lt.code AS lot, ${inclusiveBounds('s.periode', 'entree', 'sortie')},
            s.depot_retenu_charges::text AS depot_retenu
     FROM sejour s JOIN lot lt ON lt.id = s.lot_id JOIN locataire lo ON lo.id = s.locataire_id
     WHERE lt.immeuble_id = $1 AND NOT upper_inf(s.periode)
       AND (upper(s.periode) - 1) BETWEEN $2::date AND $3::date
     ORDER BY upper(s.periode)`,
    [immeuble, debut, fin],
  )

  const departs: Depart[] = []
  for (const s of sorties) {
    const sejour = { immeuble, debut: s.entree, fin: s.sortie }
    const [{ sejours }, couverture] = await Promise.all([loadDecompte(db, sejour), loadCouverture(db, sejour)])
    const row = sejours.find((r) => r.sejour_id === s.sejour_id)
    const { rows: [paye] } = await db.query<{ montant: string }>(
      `SELECT coalesce(sum(regularisation), 0)::text AS montant FROM paiement
       WHERE sejour_id = $1 AND date_paiement <= $2::date`,
      [s.sejour_id, fin],
    )
    const charges = row?.total ?? '0'
    const provisions = row?.provisions ?? '0'
    const versements = paye?.montant ?? '0'
    const nonRembourse = new Big(charges).minus(provisions).minus(versements)
    departs.push({
      ...s,
      charges,
      provisions,
      versements,
      non_rembourse: nonRembourse.toString(),
      deductible: (nonRembourse.gt(0) ? nonRembourse : new Big(0)).toString(),
      depot_retenu: s.depot_retenu ?? '0',
      incomplet: couverture.energies.flatMap((e) =>
        e.trous.map((t) => `${e.energie} du ${frenchDate(t.debut)} au ${frenchDate(t.fin)}`)),
    })
  }

  // For information: lines borne by the owner (late payment penalties…), by invoice date; not the lines about
  // another property (ADR 0013)
  const { rows: nonRecuperables } = await db.query(
    `SELECT f.id AS facture_id, fo.nom AS fournisseur, f.numero, f.date_facture::text, l.libelle, l.montant_ttc::text AS montant
     FROM ligne_facture l JOIN facture f ON f.id = l.facture_id JOIN fournisseur fo ON fo.id = f.fournisseur_id
     WHERE f.immeuble_id = $1 AND f.statut = 'validee' AND l.affectation = 'proprietaire'
       AND f.date_facture BETWEEN $2::date AND $3::date
     ORDER BY f.date_facture`,
    [immeuble, debut, fin],
  )

  // Charges given up to a tenant who is still there: not deductible before the departure (SPEC § 9)
  const { rows: abandons } = await db.query(
    `SELECT r.id AS regularisation_id, lo.nom AS locataire, lt.code AS lot, ${inclusiveBounds('r.exercice')},
            (r.solde - regularisation_verse(r.id))::text AS reste
     FROM regularisation r JOIN sejour s ON s.id = r.sejour_id JOIN lot lt ON lt.id = s.lot_id
     JOIN locataire lo ON lo.id = s.locataire_id
     WHERE lt.immeuble_id = $1 AND r.decision = 'abandonnee'
       AND (upper_inf(s.periode) OR upper(s.periode) - 1 > $2::date)`,
    [immeuble, fin],
  )

  const { rows: travaux } = await db.query<Travaux>(
    `SELECT t.id, t.fournisseur, t.description, t.nature, lt.code AS lot, t.date_facture::text, t.date_paiement::text,
            t.montant_ttc::text, t.nature <> 'construction' AS deductible
     FROM travaux t LEFT JOIN lot lt ON lt.id = t.lot_id
     WHERE t.immeuble_id = $1 AND (t.date_paiement BETWEEN $2::date AND $3::date
       OR (t.date_paiement IS NULL AND t.date_facture <= $3::date))
     ORDER BY coalesce(t.date_paiement, t.date_facture), t.id`,
    [immeuble, debut, fin],
  )

  const totalVacance = sum(vacance.map((v) => v.montant))
  const totalDeductibleDeparts = sum(departs.map((d) => d.deductible))
  return {
    immeuble,
    annee,
    vacance,
    total_vacance: totalVacance.toString(),
    departs,
    total_non_rembourse: totalDeductibleDeparts.toString(),
    total_depots_retenus: sum(departs.map((d) => d.depot_retenu)).toString(),
    total_deductible: totalVacance.plus(totalDeductibleDeparts).toString(),
    non_recuperables: nonRecuperables,
    abandons_en_cours: abandons,
    travaux: travaux.filter((t) => t.date_paiement),
    total_travaux_deductibles: sum(travaux.filter((t) => t.date_paiement && t.deductible).map((t) => t.montant_ttc)).toString(),
    travaux_non_payes: travaux.filter((t) => !t.date_paiement),
  }
}

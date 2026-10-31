import Big from 'big.js'
import type { Pool } from 'pg'

import { frenchDate } from './format.js'
import { inclusiveBounds } from './periods.js'
import { debutGestion, loadCouverture, loadDecompte } from './statements.js'

// Tax summary of a calendar year (SPEC § 9, to be checked by the accountant): charges borne during vacancy,
// recoverable charges not repaid by the 31/12 of the year a tenant left (whole stay), deposits kept for charges.
// Amounts are unrounded numeric text, rounded for display only.

export type Depart = {
  tenancy_id: number
  tenant: string
  unit: string
  move_in: string
  move_out: string
  // Start of the computation: the entry, or the start of the management of the building when later (ADR 0023: the
  // years before, managed by an agency, are not counted)
  calculation_start: string
  charges: string
  advances: string
  versements: string
  // charges − provisions − regularisation payments received by the 31/12 of the year of departure; the deposit kept
  // (retention, depot_retenu) is not one of them: it is a receipt of its own (SPEC § 9)
  not_refunded: string
  // Deductible part (positive amount not repaid)
  deductible: string
  deposit_retained: string
  // Periods of the stay not covered by validated invoices: the charges are then understated
  incomplet: string[]
}

export type SyntheseFiscale = {
  building: number
  year: number
  vacance: { energy: string, amount: string }[]
  total_vacancy: string
  departs: Depart[]
  total_not_refunded: string
  total_deposits_retained: string
  // Line 225 of the 2044 (charges récupérables non récupérées)
  total_deductible: string
  non_recoverable: { invoice_id: number, supplier: string, number: string, invoice_date: string, label: string, amount: string }[]
  pending_write_offs: { charge_adjustment_id: number, tenant: string, unit: string, start: string, end: string, remaining: string }[]
  // Payments of works made during the year (ADR 0015, 0019): the bank movements that paid them, the deductible ones for
  // the 2044, line 224; an invoice paid in several times appears once per payment, in the year of each
  works_invoice: Travaux[]
  total_deductible_works: string
  // Works invoiced by the end of the year and not paid in full: the rest is not in the year until paid
  unpaid_works: Travaux[]
}

export type Travaux = {
  id: number, supplier: string, description: string, nature: string, unit: string | null, invoice_date: string,
  // The payment (null for an invoice not paid in full: montant is then what remains), and the invoice's amount
  payment_date: string | null, amount: string, total_incl_tax: string, deductible: boolean
}

const sum = (values: string[]) => values.reduce((s, v) => s.plus(v), new Big(0))

export async function syntheseFiscale(db: Pool, building: number, year: number): Promise<SyntheseFiscale> {
  const start = `${year}-01-01`
  const end = `${year}-12-31`

  // Vacancy: owner share of the recoverable charges of the year (SPEC R4)
  const { summary } = await loadDecompte(db, { building, start, end })
  const vacance = summary.map((s) => ({ energy: s.energy, amount: s.owner }))

  // Tenants who left during the year: their whole stay
  const { rows: sorties } = await db.query<{
    tenancy_id: number, tenant: string, unit: string, move_in: string, move_out: string, deposit_retained: string | null,
  }>(
    `SELECT s.id AS tenancy_id, lo.name AS tenant, lt.code AS unit, ${inclusiveBounds('s.period', 'move_in', 'move_out')},
            -- Deposit kept for charges (ADR 0021): the retention toward regularisations
            (SELECT sum(p.charge_adjustment)::text FROM payment p WHERE p.tenancy_id = s.id AND p.method = 'deposit') AS deposit_retained
     FROM tenancy s JOIN unit lt ON lt.id = s.unit_id JOIN tenant lo ON lo.id = s.tenant_id
     WHERE lt.building_id = $1 AND NOT upper_inf(s.period)
       AND (upper(s.period) - 1) BETWEEN $2::date AND $3::date
     ORDER BY upper(s.period)`,
    [building, start, end],
  )

  const gestion = await debutGestion(db, building)
  const departs: Depart[] = []
  for (const s of sorties) {
    const debutCalcul = gestion && gestion > s.move_in ? gestion : s.move_in
    const tenancy = { building, start: debutCalcul, end: s.move_out }
    const [{ tenancies }, couverture] = await Promise.all([loadDecompte(db, tenancy), loadCouverture(db, tenancy)])
    const row = tenancies.find((r) => r.tenancy_id === s.tenancy_id)
    const { rows: [paid] } = await db.query<{ amount: string }>(
      `SELECT coalesce(sum(p.charge_adjustment), 0)::text AS amount FROM payment p
       JOIN charge_adjustment r ON r.id = p.charge_adjustment_id
       WHERE p.tenancy_id = $1 AND p.payment_date <= $2::date AND p.method IS DISTINCT FROM 'deposit'
         AND upper(r.period) > $3::date`,
      [s.tenancy_id, end, debutCalcul],
    )
    const charges = row?.total ?? '0'
    const advances = row?.advances ?? '0'
    const versements = paid?.amount ?? '0'
    const nonRembourse = new Big(charges).minus(advances).minus(versements)
    departs.push({
      ...s,
      calculation_start: debutCalcul,
      charges,
      advances,
      versements,
      not_refunded: nonRembourse.toString(),
      deductible: (nonRembourse.gt(0) ? nonRembourse : new Big(0)).toString(),
      deposit_retained: s.deposit_retained ?? '0',
      incomplet: couverture.energies.flatMap((e) =>
        e.trous.map((t) => `${e.energy} du ${frenchDate(t.start)} au ${frenchDate(t.end)}`)),
    })
  }

  // For information: lines borne by the owner (late payment penalties…), by invoice date; not the lines about
  // another property (ADR 0013)
  const { rows: nonRecuperables } = await db.query(
    `SELECT f.id AS invoice_id, fo.name AS supplier, f.number, f.invoice_date::text, l.label, l.amount_incl_tax::text AS amount
     FROM invoice_line l JOIN invoice f ON f.id = l.invoice_id JOIN supplier fo ON fo.id = f.supplier_id
     WHERE f.building_id = $1 AND f.status = 'validated' AND l.allocation = 'owner'
       AND f.invoice_date BETWEEN $2::date AND $3::date
     ORDER BY f.invoice_date`,
    [building, start, end],
  )

  // Charges given up to a tenant who is still there: not deductible before the departure (SPEC § 9)
  const { rows: abandons } = await db.query(
    `SELECT r.id AS charge_adjustment_id, lo.name AS tenant, lt.code AS unit, ${inclusiveBounds('r.period')},
            (r.balance - charge_adjustment_paid(r.id))::text AS remaining
     FROM charge_adjustment r JOIN tenancy s ON s.id = r.tenancy_id JOIN unit lt ON lt.id = s.unit_id
     JOIN tenant lo ON lo.id = s.tenant_id
     WHERE lt.building_id = $1 AND r.decision = 'written_off'
       AND (upper_inf(s.period) OR upper(s.period) - 1 > $2::date)`,
    [building, end],
  )

  const { rows: works_invoice } = await db.query<Travaux>(
    `SELECT t.id, t.supplier, t.description, t.nature, lt.code AS unit, t.invoice_date::text,
            m.transaction_date::text AS payment_date, rt.amount::text, t.total_incl_tax::text,
            t.nature <> 'construction' AS deductible
     FROM works_invoice_payment rt JOIN works_invoice t ON t.id = rt.works_invoice_id JOIN bank_transaction m ON m.id = rt.bank_transaction_id
     LEFT JOIN unit lt ON lt.id = t.unit_id
     WHERE t.building_id = $1 AND m.transaction_date BETWEEN $2::date AND $3::date
     ORDER BY m.transaction_date, t.id, rt.id`,
    [building, start, end],
  )
  // Not paid in full at the end of the year: what remains then
  const { rows: nonPayes } = await db.query<Travaux>(
    `SELECT * FROM (
       SELECT t.id, t.supplier, t.description, t.nature, lt.code AS unit, t.invoice_date::text, NULL AS payment_date,
              (t.total_incl_tax - (SELECT coalesce(sum(rt.amount), 0) FROM works_invoice_payment rt
                                JOIN bank_transaction m ON m.id = rt.bank_transaction_id
                                WHERE rt.works_invoice_id = t.id AND m.transaction_date <= $2::date))::text AS amount,
              t.total_incl_tax::text, t.nature <> 'construction' AS deductible
       FROM works_invoice t LEFT JOIN unit lt ON lt.id = t.unit_id
       WHERE t.building_id = $1 AND t.invoice_date <= $2::date) x
     WHERE amount::numeric > 0 ORDER BY invoice_date, id`,
    [building, end],
  )

  const totalVacance = sum(vacance.map((v) => v.amount))
  const totalDeductibleDeparts = sum(departs.map((d) => d.deductible))
  return {
    building,
    year,
    vacance,
    total_vacancy: totalVacance.toString(),
    departs,
    total_not_refunded: totalDeductibleDeparts.toString(),
    total_deposits_retained: sum(departs.map((d) => d.deposit_retained)).toString(),
    total_deductible: totalVacance.plus(totalDeductibleDeparts).toString(),
    non_recoverable: nonRecuperables,
    pending_write_offs: abandons,
    works_invoice,
    total_deductible_works: sum(works_invoice.filter((t) => t.deductible).map((t) => t.amount)).toString(),
    unpaid_works: nonPayes,
  }
}

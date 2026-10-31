import Big from 'big.js'
import type { Pool } from 'pg'

import { loadDecompte, loadDetail, type Exercice } from './statements.js'

// Supporting document of a tenant's statement (SPEC § 8). The amounts are those of the statement row (decompte),
// unrounded; this object is also what a regularisation freezes (ADR 0007).

export const RUBRIQUES = [
  { column: 'gas_consumption', label: 'Gaz – consommation', energy: 'gas', consumption: true },
  { column: 'gas_other', label: 'Gaz – abonnement, taxes, locations', energy: 'gas', consumption: false },
  { column: 'electricity_consumption', label: 'Électricité des communs – consommation', energy: 'electricity', consumption: true },
  { column: 'electricity_other', label: 'Électricité des communs – abonnement, taxes', energy: 'electricity', consumption: false },
  { column: 'water', label: 'Eau', energy: 'water', consumption: null },
  { column: 'household_waste', label: 'Taxe d\'enlèvement des ordures ménagères', energy: 'household_waste', consumption: null },
] as const

export type Justificatif = {
  building: { name: string, address: string | null, total_charge_shares: number }
  period: { start: string, end: string }
  tenancy: {
    id: number
    tenant: string
    unit: string
    unit_label: string | null
    charge_shares: number
    present_from: string | null
    present_to: string | null
    days: number
    period_days: number
  }
  headings: { label: string, building_expenses: string, share: string }[]
  total: string
  advances: string
  balance: string
  invoices: {
    invoice_id: number
    supplier: string
    number: string
    invoice_date: string
    energy: string
    start: string
    end: string
    invoice_amount: string
    share: string
  }[]
  generated_at: string
}

export class SejourHorsExercice extends Error {}

export async function buildJustificatif(db: Pool, period: Exercice, sejourId: number): Promise<Justificatif> {
  const { building, start, end } = period
  const { tenancies } = await loadDecompte(db, period)
  const row = tenancies.find((s) => s.tenancy_id === sejourId)
  if (!row) {
    throw new SejourHorsExercice('Ce séjour ne figure pas dans le décompte de cet exercice')
  }

  const { rows: [info] } = await db.query<{
    name: string, address: string | null, total_charge_shares: number, label: string | null, period_days: number,
  }>(
    `SELECT i.name, i.address, (SELECT sum(charge_shares)::int FROM unit WHERE building_id = i.id) AS total_charge_shares,
            lt.label, ($3::date - $2::date + 1) AS period_days
     FROM tenancy s JOIN unit lt ON lt.id = s.unit_id JOIN building i ON i.id = lt.building_id
     WHERE s.id = $1 AND i.id = $4`,
    [sejourId, start, end, building],
  )
  if (!info) {
    throw new SejourHorsExercice('Séjour inconnu pour cet immeuble')
  }

  // Building expenses of the exercise per heading: every share, tenants and owner (vacancy) together
  const { rows: depenses } = await db.query<{ energy: string, consumption: boolean, amount: string }>(
    `SELECT energy, category = 'consumption' AS consumption, sum(amount)::text AS amount
     FROM apportionment($1, $2, $3) GROUP BY 1, 2`,
    [building, start, end],
  )
  const depense = (energy: string, consumption: boolean | null) => depenses
    .filter((d) => d.energy === energy && (consumption === null || d.consumption === consumption))
    .reduce((sum, d) => sum.plus(d.amount), new Big(0))
    .toString()

  // Invoices behind the tenant's share, with the span of the lines retained and the share of each invoice
  const detail = await loadDetail(db, period, { tenancy: sejourId })
  const parFacture = new Map<number, Justificatif['invoices'][number]>()
  for (const line of detail) {
    // Days actually retained for the tenant: the line period within the presence (itself within the exercise)
    const d = {
      ...line,
      start: row.present_from && row.present_from > line.start ? row.present_from : line.start,
      end: row.present_to && row.present_to < line.end ? row.present_to : line.end,
    }
    const f = parFacture.get(d.invoice_id)
    if (f) {
      f.start = d.start < f.start ? d.start : f.start
      f.end = d.end > f.end ? d.end : f.end
      f.share = new Big(f.share).plus(d.amount).toString()
    } else {
      parFacture.set(d.invoice_id, {
        invoice_id: d.invoice_id, supplier: d.supplier, number: d.number, invoice_date: d.invoice_date,
        energy: d.energy, start: d.start, end: d.end, invoice_amount: '', share: new Big(d.amount).toString(),
      })
    }
  }
  if (parFacture.size) {
    const { rows } = await db.query<{ id: number, total_incl_tax: string }>(
      'SELECT id, total_incl_tax::text FROM invoice WHERE id = ANY($1)',
      [[...parFacture.keys()]],
    )
    for (const r of rows) {
      parFacture.get(r.id)!.invoice_amount = r.total_incl_tax
    }
  }
  const ordreEnergie = RUBRIQUES.map((r) => r.energy as string)
  const invoices = [...parFacture.values()].sort((a, b) =>
    ordreEnergie.indexOf(a.energy) - ordreEnergie.indexOf(b.energy) || a.start.localeCompare(b.start))

  return {
    building: { name: info.name, address: info.address, total_charge_shares: info.total_charge_shares },
    period: { start, end },
    tenancy: {
      id: sejourId,
      tenant: row.tenant,
      unit: row.unit,
      unit_label: info.label,
      charge_shares: row.charge_shares,
      present_from: row.present_from,
      present_to: row.present_to,
      days: row.days,
      period_days: info.period_days,
    },
    headings: RUBRIQUES.map((r) => ({
      label: r.label,
      building_expenses: depense(r.energy, r.consumption),
      share: row[r.column],
    })),
    total: row.total,
    advances: row.advances,
    balance: row.balance,
    invoices,
    generated_at: new Date().toISOString().slice(0, 10),
  }
}


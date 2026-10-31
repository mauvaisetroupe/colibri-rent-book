import type { Pool } from 'pg'

import { inclusiveBounds } from './periods.js'
import { frenchDate } from './format.js'

// Reading the statements computed by the SQL engine (repartition, decompte, synthese: never re-implemented here)
// and the checks around them: periods not covered by validated invoices, overlaps, drafts, provisions (SPEC R1, R9).

export type Exercice = { building: number, start: string, end: string }

const AMOUNTS = [
  'gas_consumption', 'gas_other', 'electricity_consumption', 'electricity_other', 'water', 'household_waste',
  'total', 'advances', 'balance',
] as const

export type DecompteRow = {
  tenancy_id: number
  tenant: string
  unit: string
  charge_shares: number
  present_from: string | null
  present_to: string | null
  days: number
} & Record<typeof AMOUNTS[number], string>

export type SyntheseRow = { energy: string, invoices: string, tenants: string, owner: string }

/** Statement per stay and summary per energy. Amounts are unrounded numeric text: rounding is for display only. */
export async function loadDecompte(db: Pool, { building, start, end }: Exercice) {
  const { rows: tenancies } = await db.query<DecompteRow>(
    `SELECT tenancy_id, tenant, unit, charge_shares, ${inclusiveBounds('present', 'present_from', 'present_to')}, days,
            ${AMOUNTS.map((a) => `${a}::text`).join(', ')}
     FROM charge_statement($1, $2, $3)`,
    [building, start, end],
  )
  const { rows: summary } = await db.query<SyntheseRow>(
    `SELECT energy, invoices::text, tenants::text, owner::text FROM summary($1, $2, $3)`,
    [building, start, end],
  )
  return { tenancies, summary }
}

export type DetailFilter = {
  // A stay id, 'proprietaire' for the vacancy share, or undefined for everything
  tenancy?: number | 'owner'
  energy?: string
  // Gas and electricity only: consumption or the other lines, as in the statement columns
  group?: 'consumption' | 'other'
}

/** Line-by-line detail of the allocation (function repartition). */
export async function loadDetail(db: Pool, { building, start, end }: Exercice, filter: DetailFilter = {}) {
  // repartition() gives one owner row per invoice line, most of them at zero when no lot was vacant
  const conditions: string[] = ['NOT (r.tenancy_id IS NULL AND r.amount = 0)']
  const params: unknown[] = [building, start, end]
  if (filter.tenancy === 'owner') {
    conditions.push('r.tenancy_id IS NULL')
  } else if (filter.tenancy !== undefined) {
    params.push(filter.tenancy)
    conditions.push(`r.tenancy_id = $${params.length}`)
  }
  if (filter.energy) {
    params.push(filter.energy)
    conditions.push(`r.energy = $${params.length}::energy`)
  }
  if (filter.group) {
    conditions.push(filter.group === 'consumption' ? 'r.category = \'consumption\'' : 'r.category <> \'consumption\'')
  }
  const { rows } = await db.query(
    `SELECT r.invoice_line_id, r.invoice_id, fo.name AS supplier, f.number, f.invoice_date::text, r.energy, r.category,
            l.label, ${inclusiveBounds('l.period')}, day_count(l.period) AS line_days, l.amount_incl_tax::text AS line_amount,
            r.tenancy_id, lo.name AS tenant, lt.code AS unit, r.days, r.amount::text
     FROM apportionment($1, $2, $3) r
     JOIN invoice_line l ON l.id = r.invoice_line_id
     JOIN invoice f ON f.id = r.invoice_id
     JOIN supplier fo ON fo.id = f.supplier_id
     LEFT JOIN tenancy s ON s.id = r.tenancy_id
     LEFT JOIN tenant lo ON lo.id = s.tenant_id
     LEFT JOIN unit lt ON lt.id = s.unit_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY r.energy, lower(l.period), f.number, l.position, lt.code NULLS LAST`,
    params,
  )
  return rows
}

// Lines that tell whether a period is covered: consumption for gas and electricity (subscriptions are billed in
// advance, taxes overlap by design), every recoverable line for the other energies.
const COVERING_LINES = `
  SELECT l.id, f.id AS invoice_id, f.energy, f.number, fo.name AS supplier, l.label, l.category, l.period
  FROM invoice_line l
  JOIN invoice f ON f.id = l.invoice_id
  JOIN supplier fo ON fo.id = f.supplier_id
  WHERE f.building_id = $1 AND f.status = 'validated' AND l.allocation = 'recoverable'
    AND (f.energy NOT IN ('gas', 'electricity') OR l.category = 'consumption')
    AND l.period && daterange($2::date, $3::date, '[]')`

export type Plage = { start: string, end: string }

/**
 * For each energy billed to the building: the parts of the exercise covered by validated invoices and the gaps,
 * the covering lines that overlap each other (counted twice), and the drafts that touch the exercise.
 */
/** The start of the management of the building in the application (ADR 0023), when set. */
export async function debutGestion(db: Pool, building: number): Promise<string | null> {
  const { rows: [i] } = await db.query<{ managed_from: string | null }>(
    'SELECT managed_from::text FROM building WHERE id = $1', [building])
  return i?.managed_from ?? null
}

export async function loadCouverture(db: Pool, { building, start: debutExercice, end }: Exercice) {
  // Before the start of the management (ADR 0023), invoices are not followed: no gap, no overlap there
  const gestion = await debutGestion(db, building)
  if (gestion && gestion > end) {
    return { energies: [], chevauchements: [], brouillons: [] }
  }
  const start = gestion && gestion > debutExercice ? gestion : debutExercice
  const params = [building, start, end]
  const { rows: plages } = await db.query<{ energy: string, type: 'covered' | 'gap' } & Plage>(
    `WITH exo AS (SELECT daterange($2::date, $3::date, '[]') AS r),
     energies AS (SELECT DISTINCT energy FROM invoice WHERE building_id = $1),
     lig AS (${COVERING_LINES}),
     agg AS (
       SELECT e.energy, coalesce(range_agg(lig.period * exo.r), '{}'::datemultirange) AS covered
       FROM energies e CROSS JOIN exo LEFT JOIN lig ON lig.energy = e.energy
       GROUP BY e.energy
     )
     SELECT agg.energy, 'covered' AS type, ${inclusiveBounds('p')} FROM agg CROSS JOIN unnest(agg.covered) p
     UNION ALL
     SELECT agg.energy, 'gap', ${inclusiveBounds('p')}
     FROM agg CROSS JOIN exo CROSS JOIN unnest(datemultirange(exo.r) - agg.covered) p
     ORDER BY 1, 3`,
    params,
  )

  const energies = new Map<string, { energy: string, covered: Plage[], trous: Plage[] }>()
  for (const { energy, type, start: d, end: f } of plages) {
    const entry = energies.get(energy) ?? { energy, covered: [], trous: [] }
    entry[type === 'covered' ? 'covered' : 'trous'].push({ start: d, end: f })
    energies.set(energy, entry)
  }
  // An energy without any covering line in the exercise still shows a single gap
  const { rows: billed } = await db.query<{ energy: string }>(
    'SELECT DISTINCT energy FROM invoice WHERE building_id = $1 ORDER BY energy',
    [building],
  )
  for (const { energy } of billed) {
    if (!energies.has(energy)) {
      energies.set(energy, { energy, covered: [], trous: [{ start, end }] })
    }
  }

  const { rows: chevauchements } = await db.query(
    `WITH lig AS (${COVERING_LINES})
     SELECT a.energy, ${inclusiveBounds('a.period * b.period * daterange($2::date, $3::date, \'[]\')')},
            json_build_object('invoice_id', a.invoice_id, 'supplier', a.supplier, 'number', a.number,
              'label', a.label, 'start', lower(a.period), 'end', upper(a.period) - 1) AS line_a,
            json_build_object('invoice_id', b.invoice_id, 'supplier', b.supplier, 'number', b.number,
              'label', b.label, 'start', lower(b.period), 'end', upper(b.period) - 1) AS line_b
     -- Counted twice: lines of the same kind from two invoices (within one invoice, its lines are its detail: off-peak
     -- and peak over the same period, a subscription billed ahead of the consumption)
     FROM lig a JOIN lig b ON a.energy = b.energy AND a.id < b.id AND a.period && b.period
       AND a.invoice_id <> b.invoice_id AND a.category = b.category
     WHERE NOT isempty(a.period * b.period * daterange($2::date, $3::date, '[]'))
     ORDER BY a.energy, lower(a.period * b.period)`,
    params,
  )

  const { rows: brouillons } = await db.query(
    `SELECT f.id, fo.name AS supplier, f.number, f.energy, f.invoice_date::text
     FROM invoice f JOIN supplier fo ON fo.id = f.supplier_id
     WHERE f.building_id = $1 AND f.status = 'draft'
       AND EXISTS (SELECT 1 FROM invoice_line l WHERE l.invoice_id = f.id AND l.period && daterange($2::date, $3::date, '[]'))
     ORDER BY f.invoice_date`,
    params,
  )

  return { energies: [...energies.values()], chevauchements, brouillons }
}

const NOMS_ENERGIES: Record<string, string> = {
  gas: 'Gaz', electricity: 'Électricité', water: 'Eau', household_waste: 'Ordures ménagères', other: 'Autre',
}


/** Warnings shown above a statement: what could make it wrong or incomplete. */
export async function avertissements(
  db: Pool,
  period: Exercice,
  tenancies: DecompteRow[],
  couverture: Awaited<ReturnType<typeof loadCouverture>>,
): Promise<string[]> {
  const result: string[] = []
  const { start, end } = period

  if (!start.endsWith('-01-01') || !end.endsWith('-12-31')) {
    result.push('Les provisions sont saisies par année civile (R9) : un exercice qui ne va pas du 1er janvier au '
      + '31 décembre compte les provisions des années entières.')
  }
  for (const b of couverture.brouillons) {
    result.push(`Facture ${b.supplier} n° ${b.number} encore en brouillon : elle n'est pas comptée.`)
  }
  for (const e of couverture.energies) {
    for (const trou of e.trous) {
      result.push(`${NOMS_ENERGIES[e.energy] ?? e.energy} : aucune facture validée du ${frenchDate(trou.start)} `
        + `au ${frenchDate(trou.end)}.`)
    }
  }
  if (couverture.chevauchements.length) {
    result.push(`${couverture.chevauchements.length} chevauchement(s) entre factures : une période est peut-être `
      + 'comptée deux fois (voir Contrôles).')
  }

  // Provisions are entered per stay and calendar year: a present stay without any amount for a year is suspicious
  const presents = tenancies.filter((s) => s.days > 0)
  if (presents.length) {
    const { rows } = await db.query<{ tenancy_id: number, year: number }>(
      `SELECT s.id AS tenancy_id, y.year
       FROM tenancy s
       CROSS JOIN generate_series(extract(year FROM $2::date)::int, extract(year FROM $3::date)::int) AS y(year)
       WHERE s.id = ANY($1)
         AND s.period && daterange(make_date(y.year, 1, 1), make_date(y.year, 12, 31), '[]')
         AND s.period && daterange($2::date, $3::date, '[]')
         AND NOT EXISTS (SELECT 1 FROM v_charge_advance p WHERE p.tenancy_id = s.id AND p.year = y.year)
       ORDER BY y.year`,
      [presents.map((s) => s.tenancy_id), start, end],
    )
    for (const { tenancy_id, year } of rows) {
      const tenancy = presents.find((s) => s.tenancy_id === tenancy_id)
      result.push(`Aucune provision saisie pour ${tenancy?.tenant} (${tenancy?.unit}) en ${year}.`)
    }
  }
  return result
}

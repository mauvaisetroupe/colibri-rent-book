import Big from 'big.js'
import ExcelJS from 'exceljs'
import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'

import { exercise, InputError, query, sendError } from '../http.js'
import {
  avertissements, loadCouverture, loadDecompte, loadDetail, type DecompteRow, type DetailFilter, type Exercice,
} from '../statements.js'
import { frenchDate } from '../format.js'

// Statement of an exercise (both bounds included), line-by-line detail, coverage of the periods, Excel export.

async function statement(db: Pool, ex: Exercice) {
  const [{ tenancies, summary }, couverture] = await Promise.all([loadDecompte(db, ex), loadCouverture(db, ex)])
  return { ...ex, tenancies, summary, avertissements: await avertissements(db, ex, tenancies, couverture) }
}

function detailFilter(q: Record<string, string | undefined>): DetailFilter {
  const filter: DetailFilter = {}
  if (q.tenancy === 'owner') {
    filter.tenancy = 'owner'
  } else if (q.tenancy) {
    filter.tenancy = Number(q.tenancy)
    if (!Number.isInteger(filter.tenancy)) {
      throw new InputError('Séjour invalide')
    }
  }
  if (q.energy) {
    filter.energy = q.energy
  }
  if (q.group === 'consumption' || q.group === 'other') {
    filter.group = q.group
  }
  return filter
}

const decompteRoutes: FastifyPluginAsync<{ db: Pool }> = async (app, { db }) => {
  app.get('/decompte', async (request, reply) => {
    try {
      return await statement(db, exercise(request))
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.get('/decompte/detail', async (request, reply) => {
    try {
      return await loadDetail(db, exercise(request), detailFilter(query(request)))
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.get('/couverture', async (request, reply) => {
    try {
      const ex = exercise(request)
      return { ...ex, ...(await loadCouverture(db, ex)) }
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.get('/decompte/export', async (request, reply) => {
    try {
      const ex = exercise(request)
      const { rows: [building] } = await db.query<{ code: string, name: string }>(
        'SELECT code, name FROM building WHERE id = $1',
        [ex.building],
      )
      if (!building) {
        return reply.code(404).send({ message: 'Immeuble introuvable' })
      }
      const workbook = await buildWorkbook(building.name, await statement(db, ex), await loadDetail(db, ex))
      return reply
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('content-disposition', `attachment; filename="decompte-${building.code}-${ex.start}-${ex.end}.xlsx"`)
        .send(Buffer.from(await workbook.xlsx.writeBuffer()))
    } catch (error) {
      return sendError(reply, error)
    }
  })
}

// ---------------------------------------------------------------- Excel

const EUROS = '#,##0.00 €;[Red]-#,##0.00 €'
const DATE = 'dd/mm/yyyy'

const NOMS_ENERGIES: Record<string, string> = {
  gas: 'Gaz', electricity: 'Électricité', water: 'Eau', household_waste: 'Ordures ménagères', other: 'Autre',
}

// Excel cells hold numbers: amounts are rounded to the cent here, from the unrounded numeric text of the engine
const cents = (value: string) => Number(new Big(value).round(2, Big.roundHalfUp).toString())
const excelDate = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00Z`) : null)

const COLONNES: [keyof DecompteRow, string][] = [
  ['gas_consumption', 'Gaz conso'], ['gas_other', 'Gaz autres'],
  ['electricity_consumption', 'Élec. conso'], ['electricity_other', 'Élec. autres'],
  ['water', 'Eau'], ['household_waste', 'Ordures ménagères'],
  ['total', 'Total charges'], ['advances', 'Provisions'], ['balance', 'Solde'],
]

function header(sheet: ExcelJS.Worksheet, values: string[]) {
  const row = sheet.addRow(values)
  row.font = { bold: true }
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF6' } }
  return row
}

async function buildWorkbook(
  nomImmeuble: string,
  s: Awaited<ReturnType<typeof statement>>,
  detail: Awaited<ReturnType<typeof loadDetail>>,
) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Colibri'
  const title = `Exercice du ${frenchDate(s.start)} au ${frenchDate(s.end)}`

  // Statement per stay
  const charge_statement = workbook.addWorksheet('Décompte', { views: [{ state: 'frozen', ySplit: 4 }] })
  charge_statement.addRow([`Décompte des charges – ${nomImmeuble}`]).font = { bold: true, size: 14 }
  charge_statement.addRow([title])
  charge_statement.addRow([])
  header(charge_statement, ['Lot', 'Locataire', 'Tantièmes', 'Présent du', 'au', 'Jours', ...COLONNES.map(([, name]) => name)])
  for (const r of s.tenancies) {
    charge_statement.addRow([r.unit, r.tenant, r.charge_shares, excelDate(r.present_from), excelDate(r.present_to), r.days,
      ...COLONNES.map(([col]) => cents(String(r[col])))])
  }
  // Totals from the unrounded amounts, rounded once
  const totals = charge_statement.addRow(['Total', '', '', null, null, null,
    ...COLONNES.map(([col]) => cents(s.tenancies.reduce((sum, r) => sum.plus(String(r[col])), new Big(0)).toString()))])
  totals.font = { bold: true }
  charge_statement.columns.forEach((column, i) => {
    column.width = i === 1 ? 38 : i < 6 ? 12 : 14
    if (i === 3 || i === 4) column.numFmt = DATE
    if (i >= 6) column.numFmt = EUROS
  })

  // Summary per energy
  const summary = workbook.addWorksheet('Synthèse')
  summary.addRow([`Synthèse par énergie – ${title}`]).font = { bold: true }
  summary.addRow([])
  header(summary, ['Énergie', 'Factures de l\'exercice', 'Part des locataires', 'Part du propriétaire (vacance)'])
  for (const r of s.summary) {
    summary.addRow([NOMS_ENERGIES[r.energy] ?? r.energy, cents(r.invoices), cents(r.tenants), cents(r.owner)])
  }
  summary.columns.forEach((column, i) => {
    column.width = i === 0 ? 22 : 26
    if (i > 0) column.numFmt = EUROS
  })

  // Line by line (function repartition)
  const lines = workbook.addWorksheet('Détail', { views: [{ state: 'frozen', ySplit: 1 }] })
  header(lines, ['Énergie', 'Fournisseur', 'Facture', 'Date facture', 'Catégorie', 'Libellé', 'Début', 'Fin',
    'Jours ligne', 'TTC ligne', 'Lot', 'Locataire', 'Jours retenus', 'Part'])
  for (const d of detail) {
    lines.addRow([NOMS_ENERGIES[d.energy] ?? d.energy, d.supplier, d.number, excelDate(d.invoice_date),
      d.category, d.label, excelDate(d.start), excelDate(d.end), d.line_days, Number(d.line_amount),
      d.unit ?? '', d.tenant ?? 'Propriétaire (vacance)', d.days, cents(d.amount)])
  }
  const widths = [14, 12, 20, 12, 13, 40, 12, 12, 10, 12, 8, 34, 12, 12]
  lines.columns.forEach((column, i) => {
    column.width = widths[i] ?? 12
    if ([3, 6, 7].includes(i)) column.numFmt = DATE
    if ([9, 13].includes(i)) column.numFmt = EUROS
  })
  lines.autoFilter = { from: 'A1', to: 'N1' }

  if (s.avertissements.length) {
    const sheet = workbook.addWorksheet('Avertissements')
    for (const a of s.avertissements) {
      sheet.addRow([a])
    }
    sheet.getColumn(1).width = 120
  }
  return workbook
}

export default decompteRoutes

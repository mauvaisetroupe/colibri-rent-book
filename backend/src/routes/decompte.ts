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
  const [{ sejours, synthese }, couverture] = await Promise.all([loadDecompte(db, ex), loadCouverture(db, ex)])
  return { ...ex, sejours, synthese, avertissements: await avertissements(db, ex, sejours, couverture) }
}

function detailFilter(q: Record<string, string | undefined>): DetailFilter {
  const filter: DetailFilter = {}
  if (q.sejour === 'proprietaire') {
    filter.sejour = 'proprietaire'
  } else if (q.sejour) {
    filter.sejour = Number(q.sejour)
    if (!Number.isInteger(filter.sejour)) {
      throw new InputError('Séjour invalide')
    }
  }
  if (q.energie) {
    filter.energie = q.energie
  }
  if (q.groupe === 'consommation' || q.groupe === 'autres') {
    filter.groupe = q.groupe
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
      const { rows: [immeuble] } = await db.query<{ code: string, nom: string }>(
        'SELECT code, nom FROM immeuble WHERE id = $1',
        [ex.immeuble],
      )
      if (!immeuble) {
        return reply.code(404).send({ message: 'Immeuble introuvable' })
      }
      const workbook = await buildWorkbook(immeuble.nom, await statement(db, ex), await loadDetail(db, ex))
      return reply
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('content-disposition', `attachment; filename="decompte-${immeuble.code}-${ex.debut}-${ex.fin}.xlsx"`)
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
  gaz: 'Gaz', electricite: 'Électricité', eau: 'Eau', ordures_menageres: 'Ordures ménagères', autre: 'Autre',
}

// Excel cells hold numbers: amounts are rounded to the cent here, from the unrounded numeric text of the engine
const cents = (value: string) => Number(new Big(value).round(2, Big.roundHalfUp).toString())
const excelDate = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00Z`) : null)

const COLONNES: [keyof DecompteRow, string][] = [
  ['gaz_consommation', 'Gaz conso'], ['gaz_autres', 'Gaz autres'],
  ['electricite_consommation', 'Élec. conso'], ['electricite_autres', 'Élec. autres'],
  ['eau', 'Eau'], ['ordures_menageres', 'Ordures ménagères'],
  ['total', 'Total charges'], ['provisions', 'Provisions'], ['solde', 'Solde'],
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
  const titre = `Exercice du ${frenchDate(s.debut)} au ${frenchDate(s.fin)}`

  // Statement per stay
  const decompte = workbook.addWorksheet('Décompte', { views: [{ state: 'frozen', ySplit: 4 }] })
  decompte.addRow([`Décompte des charges – ${nomImmeuble}`]).font = { bold: true, size: 14 }
  decompte.addRow([titre])
  decompte.addRow([])
  header(decompte, ['Lot', 'Locataire', 'Tantièmes', 'Présent du', 'au', 'Jours', ...COLONNES.map(([, nom]) => nom)])
  for (const r of s.sejours) {
    decompte.addRow([r.lot, r.locataire, r.tantiemes, excelDate(r.present_du), excelDate(r.present_au), r.jours,
      ...COLONNES.map(([col]) => cents(String(r[col])))])
  }
  // Totals from the unrounded amounts, rounded once
  const totals = decompte.addRow(['Total', '', '', null, null, null,
    ...COLONNES.map(([col]) => cents(s.sejours.reduce((sum, r) => sum.plus(String(r[col])), new Big(0)).toString()))])
  totals.font = { bold: true }
  decompte.columns.forEach((column, i) => {
    column.width = i === 1 ? 38 : i < 6 ? 12 : 14
    if (i === 3 || i === 4) column.numFmt = DATE
    if (i >= 6) column.numFmt = EUROS
  })

  // Summary per energy
  const synthese = workbook.addWorksheet('Synthèse')
  synthese.addRow([`Synthèse par énergie – ${titre}`]).font = { bold: true }
  synthese.addRow([])
  header(synthese, ['Énergie', 'Factures de l\'exercice', 'Part des locataires', 'Part du propriétaire (vacance)'])
  for (const r of s.synthese) {
    synthese.addRow([NOMS_ENERGIES[r.energie] ?? r.energie, cents(r.factures), cents(r.locataires), cents(r.proprietaire)])
  }
  synthese.columns.forEach((column, i) => {
    column.width = i === 0 ? 22 : 26
    if (i > 0) column.numFmt = EUROS
  })

  // Line by line (function repartition)
  const lignes = workbook.addWorksheet('Détail', { views: [{ state: 'frozen', ySplit: 1 }] })
  header(lignes, ['Énergie', 'Fournisseur', 'Facture', 'Date facture', 'Catégorie', 'Libellé', 'Début', 'Fin',
    'Jours ligne', 'TTC ligne', 'Lot', 'Locataire', 'Jours retenus', 'Part'])
  for (const d of detail) {
    lignes.addRow([NOMS_ENERGIES[d.energie] ?? d.energie, d.fournisseur, d.numero, excelDate(d.date_facture),
      d.categorie, d.libelle, excelDate(d.debut), excelDate(d.fin), d.jours_ligne, Number(d.montant_ligne),
      d.lot ?? '', d.locataire ?? 'Propriétaire (vacance)', d.jours, cents(d.montant)])
  }
  const widths = [14, 12, 20, 12, 13, 40, 12, 12, 10, 12, 8, 34, 12, 12]
  lignes.columns.forEach((column, i) => {
    column.width = widths[i] ?? 12
    if ([3, 6, 7].includes(i)) column.numFmt = DATE
    if ([9, 13].includes(i)) column.numFmt = EUROS
  })
  lignes.autoFilter = { from: 'A1', to: 'N1' }

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

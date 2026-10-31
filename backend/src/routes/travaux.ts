import { createReadStream } from 'node:fs'
import { join } from 'node:path'

import multipart from '@fastify/multipart'
import Big from 'big.js'
import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'

import {
  body, idParam, InputError, optionalText, query, requiredDate, requiredDecimal, requiredId, requiredText, sendError,
} from '../http.js'
import { isPdf, removeIfUnused, storePdf } from '../pdfStorage.js'

// Invoices of works paid by the owner (ADR 0015), for the tax return only: never allocated to the tenants. Deductible
// (2044, line 224) according to their nature. Paid by bank movements only (ADR 0019: paid = seen at the bank), one or
// several (a deposit, then the balance), linked in « Catégorisation » or from the invoice; here, the invoice alone and
// its payments to read.

export const NATURES = ['maintenance', 'improvement', 'construction'] as const

const COLUMNS = `t.id, t.building_id, t.unit_id, lt.code AS unit, t.supplier, t.description, t.nature,
  t.invoice_date::text, t.total_incl_tax::text, t.pdf_file IS NOT NULL AS pdf, t.note,
  t.nature <> 'construction' AS deductible,
  coalesce(r.payments, '[]'::json) AS payments, coalesce(r.paid, 0)::text AS paid,
  (t.total_incl_tax - coalesce(r.paid, 0))::text AS remaining, r.last::text AS payment_date`

// Its payments (the movement: date, label), the amount paid, the date of the last one
const FROM = `works_invoice t LEFT JOIN unit lt ON lt.id = t.unit_id
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object('id', rt.id, 'bank_transaction_id', m.id, 'payment_date', m.transaction_date::text,
                                      'label', m.label, 'amount', rt.amount::text) ORDER BY m.transaction_date, rt.id) AS payments,
           sum(rt.amount) AS paid, max(m.transaction_date) AS last
    FROM works_invoice_payment rt JOIN bank_transaction m ON m.id = rt.bank_transaction_id WHERE rt.works_invoice_id = t.id
  ) r ON true`

async function readTravaux(db: Pool, raw: Record<string, unknown>) {
  const building = requiredId(raw.building_id, 'Immeuble')
  const unit = raw.unit_id === null || raw.unit_id === undefined || raw.unit_id === '' ? null : requiredId(raw.unit_id, 'Lot')
  if (unit !== null) {
    const { rowCount } = await db.query('SELECT 1 FROM unit WHERE id = $1 AND building_id = $2', [unit, building])
    if (!rowCount) {
      throw new InputError('Ce lot n\'est pas dans cet immeuble')
    }
  }
  const nature = String(raw.nature ?? '')
  if (!(NATURES as readonly string[]).includes(nature)) {
    throw new InputError('Nature : entretien, amélioration ou construction')
  }
  return [building, unit, requiredText(raw.supplier, 'Fournisseur'), requiredText(raw.description, 'Description'),
    nature, requiredDate(raw.invoice_date, 'Date de la facture'), requiredDecimal(raw.total_incl_tax, 'Montant TTC'),
    optionalText(raw.note)] as const
}

const travauxRoutes: FastifyPluginAsync<{ db: Pool, storageDir: string }> = async (app, { db, storageDir }) => {
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } })

  const load = async (id: number) =>
    (await db.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE t.id = $1`, [id])).rows[0] ?? null

  // Every works invoice of a building, the latest first (filtered by year on the screen)
  app.get('/travaux', async (request, reply) => {
    try {
      const building = requiredId(query(request).building, 'Immeuble')
      const { rows } = await db.query(
        `SELECT ${COLUMNS} FROM ${FROM} WHERE t.building_id = $1
         ORDER BY coalesce(r.last, t.invoice_date) DESC, t.id DESC`,
        [building],
      )
      return rows
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/travaux', async (request, reply) => {
    try {
      const { rows: [created] } = await db.query<{ id: number }>(
        `INSERT INTO works_invoice (building_id, unit_id, supplier, description, nature, invoice_date, total_incl_tax, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`, [...await readTravaux(db, body(request))])
      return reply.code(201).send(await load(created!.id))
    } catch (error) {
      return sendError(reply, error)
    }
  })

  // The invoice only: its payments are linked movements (a lower amount than what they paid is refused)
  app.put('/travaux/:id', async (request, reply) => {
    try {
      const id = idParam(request)
      const champs = await readTravaux(db, body(request))
      const { rows: [paid] } = await db.query<{ paid: string }>(
        'SELECT coalesce(sum(amount), 0)::text AS paid FROM works_invoice_payment WHERE works_invoice_id = $1', [id])
      if (new Big(paid!.paid).gt(champs[6])) {
        throw new InputError(`Les virements rattachés (${new Big(paid!.paid).toFixed(2)}) dépassent ce montant`)
      }
      const { rowCount } = await db.query(
        `UPDATE works_invoice SET building_id = $2, unit_id = $3, supplier = $4, description = $5, nature = $6,
                            invoice_date = $7, total_incl_tax = $8, note = $9
         WHERE id = $1`, [id, ...champs])
      return rowCount ? load(id) : reply.code(404).send({ message: 'Travaux introuvables' })
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.delete('/travaux/:id', async (request, reply) => {
    const { rows: [deleted] } = await db.query<{ pdf_file: string | null }>(
      'DELETE FROM works_invoice WHERE id = $1 RETURNING pdf_file',
      [idParam(request)],
    )
    if (!deleted) {
      return reply.code(404).send({ message: 'Travaux introuvables' })
    }
    if (deleted.pdf_file) {
      await removeIfUnused(db, storageDir, deleted.pdf_file)
    }
    return reply.code(204).send()
  })

  // The PDF of the invoice, attached or replaced
  app.post('/travaux/:id/pdf', async (request, reply) => {
    const id = idParam(request)
    const { rows: [works_invoice] } = await db.query<{ pdf_file: string | null }>(
      'SELECT pdf_file FROM works_invoice WHERE id = $1',
      [id],
    )
    if (!works_invoice) {
      return reply.code(404).send({ message: 'Travaux introuvables' })
    }
    const file = await request.file()
    if (!file) {
      return reply.code(400).send({ message: 'Aucun fichier reçu' })
    }
    const content = await file.toBuffer()
    if (!isPdf(content)) {
      return reply.code(415).send({ message: `${file.filename} n'est pas un PDF` })
    }
    const { fileName } = await storePdf(storageDir, content, 'travaux')
    await db.query('UPDATE works_invoice SET pdf_file = $2 WHERE id = $1', [id, fileName])
    if (works_invoice.pdf_file && works_invoice.pdf_file !== fileName) {
      await removeIfUnused(db, storageDir, works_invoice.pdf_file)
    }
    return load(id)
  })

  app.get('/travaux/:id/pdf', async (request, reply) => {
    const { rows: [works_invoice] } = await db.query<{ pdf_file: string | null }>(
      'SELECT pdf_file FROM works_invoice WHERE id = $1',
      [idParam(request)],
    )
    if (!works_invoice?.pdf_file) {
      return reply.code(404).send({ message: 'Pas de PDF pour ces travaux' })
    }
    return reply.type('application/pdf').header('content-disposition', 'inline')
      .send(createReadStream(join(storageDir, works_invoice.pdf_file)))
  })
}

export default travauxRoutes

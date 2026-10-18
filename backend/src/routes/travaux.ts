import { createReadStream } from 'node:fs'
import { join } from 'node:path'

import multipart from '@fastify/multipart'
import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'

import {
  body, idParam, InputError, optionalDate, optionalText, query, requiredDate, requiredDecimal, requiredId, requiredText,
  sendError,
} from '../http.js'
import { isPdf, removeIfUnused, storePdf } from '../pdfStorage.js'

// Invoices of works paid by the owner (ADR 0015), for the tax return only: never allocated to the tenants. Deductible
// (2044, line 224) according to their nature; tax year: that of the payment.

export const NATURES = ['entretien', 'amelioration', 'construction'] as const

const COLUMNS = `t.id, t.immeuble_id, t.lot_id, lt.code AS lot, t.fournisseur, t.description, t.nature,
  t.date_facture::text, t.date_paiement::text, t.montant_ttc::text, t.fichier_pdf IS NOT NULL AS pdf, t.note,
  t.nature <> 'construction' AS deductible, t.mouvement_id`

const FROM = 'travaux t LEFT JOIN lot lt ON lt.id = t.lot_id'

async function readTravaux(db: Pool, raw: Record<string, unknown>) {
  const immeuble = requiredId(raw.immeuble_id, 'Immeuble')
  const lot = raw.lot_id === null || raw.lot_id === undefined || raw.lot_id === '' ? null : requiredId(raw.lot_id, 'Lot')
  if (lot !== null) {
    const { rowCount } = await db.query('SELECT 1 FROM lot WHERE id = $1 AND immeuble_id = $2', [lot, immeuble])
    if (!rowCount) {
      throw new InputError('Ce lot n\'est pas dans cet immeuble')
    }
  }
  const nature = String(raw.nature ?? '')
  if (!(NATURES as readonly string[]).includes(nature)) {
    throw new InputError('Nature : entretien, amélioration ou construction')
  }
  const dateFacture = requiredDate(raw.date_facture, 'Date de la facture')
  const datePaiement = optionalDate(raw.date_paiement, 'Date du paiement')
  if (datePaiement && datePaiement < dateFacture) {
    throw new InputError('Le paiement est antérieur à la facture')
  }
  const montant = requiredDecimal(raw.montant_ttc, 'Montant TTC')
  // Paid as seen on a bank statement (ADR 0018): a debit of at least this amount
  const mouvement = raw.mouvement_id ? requiredId(raw.mouvement_id, 'Mouvement') : null
  if (mouvement !== null) {
    const { rows: [m] } = await db.query<{ montant: string, categorie: string | null }>(
      'SELECT montant::text, categorie FROM mouvement WHERE id = $1', [mouvement])
    if (!m || Number(m.montant) >= 0) {
      throw new InputError('Des travaux se rattachent à un débit du relevé')
    }
    if (m.categorie && m.categorie !== 'travaux') {
      throw new InputError('Ce mouvement a une autre catégorie : la retirer d\'abord')
    }
  }
  return [immeuble, lot, requiredText(raw.fournisseur, 'Fournisseur'), requiredText(raw.description, 'Description'),
    nature, dateFacture, datePaiement, montant, optionalText(raw.note), mouvement]
}

const travauxRoutes: FastifyPluginAsync<{ db: Pool, storageDir: string }> = async (app, { db, storageDir }) => {
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } })

  const load = async (id: number) =>
    (await db.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE t.id = $1`, [id])).rows[0] ?? null

  // Every works invoice of a building, the latest first (filtered by year on the screen)
  app.get('/travaux', async (request, reply) => {
    try {
      const immeuble = requiredId(query(request).immeuble, 'Immeuble')
      const { rows } = await db.query(
        `SELECT ${COLUMNS} FROM ${FROM} WHERE t.immeuble_id = $1
         ORDER BY coalesce(t.date_paiement, t.date_facture) DESC, t.id DESC`,
        [immeuble],
      )
      return rows
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/travaux', async (request, reply) => {
    try {
      const { rows: [created] } = await db.query<{ id: number }>(
        `INSERT INTO travaux (immeuble_id, lot_id, fournisseur, description, nature, date_facture, date_paiement,
                              montant_ttc, note, mouvement_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        await readTravaux(db, body(request)),
      )
      await db.query(
        `UPDATE mouvement SET categorie = 'travaux'
         WHERE id = (SELECT mouvement_id FROM travaux WHERE id = $1) AND categorie IS NULL`, [created!.id])
      return reply.code(201).send(await load(created!.id))
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.put('/travaux/:id', async (request, reply) => {
    try {
      const raw = body(request)
      // Without « mouvement_id », a change keeps the link to the bank movement (Travaux screen)
      const { rowCount } = await db.query(
        `UPDATE travaux SET immeuble_id = $2, lot_id = $3, fournisseur = $4, description = $5, nature = $6,
                            date_facture = $7, date_paiement = $8, montant_ttc = $9, note = $10,
                            mouvement_id = CASE WHEN $12 THEN $11 ELSE mouvement_id END
         WHERE id = $1`,
        [idParam(request), ...await readTravaux(db, raw), 'mouvement_id' in raw],
      )
      return rowCount ? load(idParam(request)) : reply.code(404).send({ message: 'Travaux introuvables' })
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.delete('/travaux/:id', async (request, reply) => {
    const { rows: [deleted] } = await db.query<{ fichier_pdf: string | null }>(
      'DELETE FROM travaux WHERE id = $1 RETURNING fichier_pdf',
      [idParam(request)],
    )
    if (!deleted) {
      return reply.code(404).send({ message: 'Travaux introuvables' })
    }
    if (deleted.fichier_pdf) {
      await removeIfUnused(db, storageDir, deleted.fichier_pdf)
    }
    return reply.code(204).send()
  })

  // The PDF of the invoice, attached or replaced
  app.post('/travaux/:id/pdf', async (request, reply) => {
    const id = idParam(request)
    const { rows: [travaux] } = await db.query<{ fichier_pdf: string | null }>(
      'SELECT fichier_pdf FROM travaux WHERE id = $1',
      [id],
    )
    if (!travaux) {
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
    await db.query('UPDATE travaux SET fichier_pdf = $2 WHERE id = $1', [id, fileName])
    if (travaux.fichier_pdf && travaux.fichier_pdf !== fileName) {
      await removeIfUnused(db, storageDir, travaux.fichier_pdf)
    }
    return load(id)
  })

  app.get('/travaux/:id/pdf', async (request, reply) => {
    const { rows: [travaux] } = await db.query<{ fichier_pdf: string | null }>(
      'SELECT fichier_pdf FROM travaux WHERE id = $1',
      [idParam(request)],
    )
    if (!travaux?.fichier_pdf) {
      return reply.code(404).send({ message: 'Pas de PDF pour ces travaux' })
    }
    return reply.type('application/pdf').header('content-disposition', 'inline')
      .send(createReadStream(join(storageDir, travaux.fichier_pdf)))
  })
}

export default travauxRoutes

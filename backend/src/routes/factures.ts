import { createReadStream } from 'node:fs'
import { join } from 'node:path'

import multipart from '@fastify/multipart'
import Big from 'big.js'
import type { FastifyPluginAsync } from 'fastify'
import type { Pool, PoolClient } from 'pg'

import { checkInvoice, isDecimal } from '../invoices/checks.js'
import { BadRequestError, readLines, readTotal } from '../invoices/requestBody.js'
import type { InvoiceLine } from '../invoices/types.js'
import { ETAT_ANNEXE_SQL, zonesSaisies } from '../annexes.js'
import { AVEC_FACTURE } from '../categories.js'
import { COUVERT_SQL } from '../couverture.js'
import { InputError, sendError } from '../http.js'
import { isPdf, removeIfUnused as removeFile, storePdf } from '../pdfStorage.js'
import { inclusiveBounds, inclusiveRange } from '../periods.js'
import { IntrouvableError, RESTE_FACTURE_SQL, reglerFacture, transfererReglements } from '../reglementsFacture.js'

// Invoices: import of a PDF read in the browser (draft), editing, validation (ADR 0003, 0005, 0013), replacement of
// a validated invoice (ADR 0017), payments by bank movements (ADR 0022), version in images joined to the supporting
// documents (ADR 0024). Periods: see periods.ts.

export type FactureOptions = {
  db: Pool
  // Folder where the uploaded PDFs are archived; facture.fichier_pdf holds the file name only
  storageDir: string
}

const ENERGIES = ['gas', 'electricity', 'water', 'household_waste', 'other']

const LINE_COLUMNS = `
  category, label, ${inclusiveBounds('period')},
  kwh::text, amount_excl_tax::text, vat_rate::text, amount_incl_tax::text, allocation, note`

const FACTURE_COLUMNS = `
  f.id, f.building_id, fo.name AS supplier, f.energy, f.number, f.invoice_date::text,
  f.total_incl_tax::text, f.status, f.note, f.pdf_file IS NOT NULL AS pdf, fo.id AS supplier_id, f.extractor_id,
  ${ETAT_ANNEXE_SQL} AS tenant_copy, f.masked_zones,
  f.replaced_by, f.replaced_at::text, f.replacement_reason, f.replaces_id,
  (SELECT coalesce(sum(rf.amount), 0) FROM invoice_payment rf WHERE rf.invoice_id = f.id)::text AS paid,
  ${RESTE_FACTURE_SQL}::text AS remaining,
  (SELECT max(m.transaction_date) FROM invoice_payment rf JOIN bank_transaction m ON m.id = rf.bank_transaction_id
   WHERE rf.invoice_id = f.id)::text AS payment_date`

// Another invoice, as shown in a link: « EDF n° 123 »
type Reference = { id: number, supplier: string, number: string, status: string }
const REFERENCE = `SELECT f.id, fo.name AS supplier, f.number, f.status
  FROM invoice f JOIN supplier fo ON fo.id = f.supplier_id`

// numeric::text keeps the scale ('148.540', '0.0550'): canonical form for the API
const canonical = (value: string | null) => (value === null ? null : new Big(value).toString())

type Header = { number: string, invoice_date: string, total_incl_tax: string | null, energy: string, note: string | null }

/** Invoice header as typed in the form, with what is wrong with it (empty when it can be stored). */
function readHeader(body: Record<string, unknown>): { header: Header, problems: string[] } {
  const note = String(body.note ?? '').trim()
  const header = {
    number: String(body.number ?? '').trim(),
    invoice_date: String(body.invoice_date ?? '').trim(),
    total_incl_tax: readTotal(body.total_incl_tax) || null,
    energy: String(body.energy ?? ''),
    note: note || null,
  }
  const problems = [
    !header.number && 'numéro manquant',
    !/^\d{4}-\d\d-\d\d$/.test(header.invoice_date) && 'date de facture invalide',
    header.total_incl_tax !== null && !isDecimal(header.total_incl_tax) && 'total imprimé invalide',
    !ENERGIES.includes(header.energy) && 'énergie inconnue',
  ].filter((p): p is string => Boolean(p))
  return { header, problems }
}

const facturesRoutes: FastifyPluginAsync<FactureOptions> = async (app, { db, storageDir }) => {
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1, fieldSize: 5 * 1024 * 1024 } })

  async function load(id: number) {
    const { rows: [invoice] } = await db.query(
      `SELECT ${FACTURE_COLUMNS} FROM invoice f JOIN supplier fo ON fo.id = f.supplier_id WHERE f.id = $1`,
      [id],
    )
    if (!invoice) {
      return null
    }
    const { rows } = await db.query<InvoiceLine>(
      `SELECT ${LINE_COLUMNS} FROM invoice_line WHERE invoice_id = $1 ORDER BY position, id`,
      [id],
    )
    const lines = rows.map((l) => ({
      ...l,
      kwh: canonical(l.kwh),
      amount_excl_tax: canonical(l.amount_excl_tax),
      vat_rate: canonical(l.vat_rate),
      amount_incl_tax: new Big(l.amount_incl_tax).toString(),
    }))
    invoice.total_incl_tax = canonical(invoice.total_incl_tax)
    // The invoices linked by a replacement (ADR 0017): the one replacing it, those it replaced, the one it corrects
    const reference = async (fid: number | null) =>
      fid === null ? null : (await db.query<Reference>(`${REFERENCE} WHERE f.id = $1`, [fid])).rows[0] ?? null
    const liens = {
      remplacante: await reference(invoice.replaced_by),
      remplacees: (await db.query<Reference>(`${REFERENCE} WHERE f.replaced_by = $1 ORDER BY f.id`, [id])).rows,
      corrige: await reference(invoice.replaces_id),
      correction: (await db.query<Reference>(
        `${REFERENCE} WHERE f.replaces_id = $1 AND f.status = 'draft'`, [id])).rows[0] ?? null,
    }
    // Its payments (ADR 0022): the movement (date, label), the amount
    const { rows: payments } = await db.query(
      `SELECT rf.id, rf.bank_transaction_id, m.transaction_date::text AS payment_date, m.label, rf.amount::text
       FROM invoice_payment rf JOIN bank_transaction m ON m.id = rf.bank_transaction_id
       WHERE rf.invoice_id = $1 ORDER BY m.transaction_date, rf.id`, [id])
    // Its current version in images (ADR 0024)
    const { rows: [tenant_copy] } = await db.query(
      `SELECT a.id, a.extractor_id, a.terms, a.settings, jsonb_array_length(a.zones) AS zones, a.created_at,
              a.checked_at, a.scanned_pages
       FROM invoice f JOIN invoice_tenant_copy a ON a.id = f.tenant_copy_id WHERE f.id = $1`, [id])
    return {
      invoice, lines, liens, payments, tenant_copy: tenant_copy ?? null,
      checks: checkInvoice({ total_incl_tax: invoice.total_incl_tax, lines }),
    }
  }

  /** Sent regularisations, not rectified yet, whose period touches recoverable lines of these invoices: to check. */
  async function regularisationsTouchees(ids: number[]) {
    const { rows } = await db.query(
      `SELECT DISTINCT r.id, lo.name AS tenant, lt.code AS unit, ${inclusiveBounds('r.period')}, r.balance::text
       FROM charge_adjustment r
       JOIN tenancy s ON s.id = r.tenancy_id
       JOIN unit lt ON lt.id = s.unit_id
       JOIN tenant lo ON lo.id = s.tenant_id
       WHERE r.sent_on IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM charge_adjustment n WHERE n.replaces_id = r.id)
         AND EXISTS (
           SELECT 1 FROM invoice_line l JOIN invoice f ON f.id = l.invoice_id
           WHERE l.invoice_id = ANY($1) AND l.allocation = 'recoverable' AND f.building_id = lt.building_id
             AND l.period && r.period)
       ORDER BY start, tenant`,
      [ids],
    )
    return rows
  }

  app.get('/factures', async (request, reply) => {
    const building = Number((request.query as { building?: string }).building)
    if (!Number.isInteger(building)) {
      return reply.code(400).send({ message: 'Paramètre « immeuble » manquant' })
    }
    const { rows } = await db.query(
      `SELECT ${FACTURE_COLUMNS}, c.ok AS total_ok, ${inclusiveBounds('e.span')}, e.line_count
       FROM invoice f
       JOIN supplier fo ON fo.id = f.supplier_id
       JOIN v_invoice_check c ON c.id = f.id
       CROSS JOIN LATERAL (
         SELECT range_merge(range_agg(l.period)) AS span, count(*)::int AS line_count
         FROM invoice_line l WHERE l.invoice_id = f.id
       ) e
       WHERE f.building_id = $1
       ORDER BY f.invoice_date DESC NULLS LAST, f.id DESC`,
      [building],
    )
    return rows.map((r) => ({ ...r, total_incl_tax: canonical(r.total_incl_tax) }))
  })

  app.get('/factures/:id', async (request, reply) => {
    const result = await load(Number((request.params as { id: string }).id))
    return result ?? reply.code(404).send({ message: 'Facture introuvable' })
  })

  app.get('/factures/:id/pdf', async (request, reply) => {
    const { rows: [invoice] } = await db.query<{ pdf_file: string | null }>(
      'SELECT pdf_file FROM invoice WHERE id = $1',
      [Number((request.params as { id: string }).id)],
    )
    if (!invoice?.pdf_file) {
      return reply.code(404).send({ message: 'Pas de PDF pour cette facture' })
    }
    return reply
      .type('application/pdf')
      .header('content-disposition', 'inline')
      .send(createReadStream(join(storageDir, invoice.pdf_file)))
  })

  // PDF and the draft read from it by an extractor, in the browser (ADR 0013): stored as a draft (statut a_verifier)
  // with the version of the extractor. Multipart: the PDF « file » and the field « brouillon », JSON
  // { extracteur_id, numero, date_facture, montant_ttc (may be null: typed later), lignes }.
  app.post('/factures/import', async (request, reply) => {
    const building = Number((request.query as { building?: string }).building)
    const { rowCount } = await db.query('SELECT 1 FROM building WHERE id = $1', [building])
    if (!Number.isInteger(building) || !rowCount) {
      return reply.code(400).send({ message: 'Immeuble inconnu' })
    }
    let content: Buffer | null = null
    let filename = ''
    let brouillon: Record<string, unknown> | null = null
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        content = await part.toBuffer()
        filename = part.filename
      } else if (part.fieldname === 'draft') {
        try {
          brouillon = JSON.parse(String(part.value))
        } catch {
          return reply.code(400).send({ message: '« brouillon » doit être du JSON' })
        }
      }
    }
    if (!content) {
      return reply.code(400).send({ message: 'Aucun fichier reçu' })
    }
    if (!isPdf(content)) {
      return reply.code(415).send({ message: `${filename} n'est pas un PDF` })
    }
    if (!brouillon) {
      return reply.code(400).send({ message: 'Brouillon manquant : la facture est lue dans le navigateur' })
    }
    const { rows: [extractor] } = await db.query<{ id: number, supplier: string, energy: string }>(
      `SELECT e.id, fo.name AS supplier, e.energy FROM extractor e JOIN supplier fo ON fo.id = e.supplier_id
       WHERE e.id = $1`,
      [Number(brouillon.extractor_id)],
    )
    if (!extractor) {
      return reply.code(400).send({ message: 'Extracteur inconnu' })
    }
    let lines: InvoiceLine[]
    try {
      lines = readLines(brouillon.lines)
    } catch (error) {
      if (error instanceof BadRequestError) {
        return reply.code(400).send({ message: error.message })
      }
      throw error
    }
    const { header, problems } = readHeader({ ...brouillon, energy: extractor.energy })
    if (problems.length) {
      return reply.code(422).send({ message: `Facture mal lue : ${problems.join(', ')}`, code: 'manual_entry' })
    }
    const checks = checkInvoice({ total_incl_tax: header.total_incl_tax, lines })
    if (!checks.can_save) {
      return reply.code(422).send({
        message: 'Lignes mal lues (corriger l\'extracteur, ou saisir la facture à la main)', code: 'manual_entry', checks,
      })
    }

    const { fileName } = await storePdf(storageDir, content, 'factures')
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const { rows: [existing] } = await client.query<{ id: number }>(
        `SELECT f.id FROM invoice f JOIN supplier fo ON fo.id = f.supplier_id
         WHERE fo.name = $1 AND f.number = $2 AND f.status <> 'replaced'
         ORDER BY f.status DESC LIMIT 1`,
        [extractor.supplier, header.number],
      )
      if (existing) {
        await client.query('ROLLBACK')
        await removeIfUnused(fileName)
        return reply.code(409).send({
          message: `Facture ${extractor.supplier} n° ${header.number} déjà importée`,
          invoice_id: existing.id,
        })
      }
      const { rows: [created] } = await client.query<{ id: number }>(
        `INSERT INTO invoice (building_id, supplier_id, energy, number, invoice_date, total_incl_tax, pdf_file,
                              extractor_id)
         VALUES ($1, (SELECT supplier_id FROM extractor WHERE id = $7), $2, $3, $4, $5, $6, $7) RETURNING id`,
        [building, header.energy, header.number, header.invoice_date, header.total_incl_tax, fileName, extractor.id],
      )
      if (!created) {
        throw new Error('Insertion de la facture sans identifiant')
      }
      await insertLines(client, created.id, lines)
      await client.query('COMMIT')
      return reply.code(201).send(await load(created.id))
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })

  // Invoice typed by hand (no PDF, or a PDF the parsers do not read): draft with its header and no lines, then
  // edited like an imported one. JSON body, or multipart with the same fields and an optional PDF « file ».
  app.post('/factures', async (request, reply) => {
    const building = Number((request.query as { building?: string }).building)
    const { rowCount } = await db.query('SELECT 1 FROM building WHERE id = $1', [building])
    if (!Number.isInteger(building) || !rowCount) {
      return reply.code(400).send({ message: 'Immeuble inconnu' })
    }
    let body: Record<string, unknown> = {}
    let content: Buffer | null = null
    if (request.isMultipart()) {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          content = await part.toBuffer()
        } else {
          body[part.fieldname] = part.value
        }
      }
    } else {
      body = (request.body ?? {}) as Record<string, unknown>
    }
    const supplier = String(body.supplier ?? '').trim()
    const { header, problems } = readHeader(body)
    if (!supplier) {
      problems.unshift('fournisseur manquant')
    }
    if (problems.length) {
      return reply.code(422).send({ message: `En-tête : ${problems.join(', ')}` })
    }

    let fileName: string | null = null
    if (content) {
      if (!isPdf(content)) {
        return reply.code(415).send({ message: 'Le fichier joint n\'est pas un PDF' })
      }
      fileName = (await storePdf(storageDir, content, 'factures')).fileName
    }

    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query('INSERT INTO supplier (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [supplier])
      const { rows: [existing] } = await client.query<{ id: number }>(
        `SELECT f.id FROM invoice f JOIN supplier fo ON fo.id = f.supplier_id
         WHERE fo.name = $1 AND f.number = $2 AND f.status <> 'replaced'
         ORDER BY f.status DESC LIMIT 1`,
        [supplier, header.number],
      )
      if (existing) {
        await client.query('ROLLBACK')
        if (fileName) {
          await removeIfUnused(fileName)
        }
        return reply.code(409).send({
          message: `Facture ${supplier} n° ${header.number} déjà enregistrée`,
          invoice_id: existing.id,
        })
      }
      const { rows: [created] } = await client.query<{ id: number }>(
        `INSERT INTO invoice (building_id, supplier_id, energy, number, invoice_date, total_incl_tax, note, pdf_file)
         VALUES ($1, (SELECT id FROM supplier WHERE name = $2), $3, $4, $5, $6, $7, $8) RETURNING id`,
        [building, supplier, header.energy, header.number, header.invoice_date, header.total_incl_tax, header.note,
          fileName],
      )
      if (!created) {
        throw new Error('Insertion de la facture sans identifiant')
      }
      await client.query('COMMIT')
      return reply.code(201).send(await load(created.id))
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })

  // Saves a draft: header and the whole list of lines. A validated invoice is not editable (ADR 0003).
  app.put('/factures/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const body = (request.body ?? {}) as Record<string, unknown>
    let lines: InvoiceLine[]
    try {
      lines = readLines(body.lines)
    } catch (error) {
      if (error instanceof BadRequestError) {
        return reply.code(400).send({ message: error.message })
      }
      throw error
    }
    const { header, problems } = readHeader(body)
    if (problems.length) {
      return reply.code(422).send({ message: `En-tête : ${problems.join(', ')}` })
    }
    const checks = checkInvoice({ total_incl_tax: header.total_incl_tax, lines })
    if (!checks.can_save) {
      return reply.code(422).send({ message: 'Corriger les erreurs de saisie avant d\'enregistrer', checks })
    }

    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const { rows: [current] } = await client.query<{ status: string }>(
        'SELECT status FROM invoice WHERE id = $1 FOR UPDATE',
        [id],
      )
      if (!current) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ message: 'Facture introuvable' })
      }
      if (current.status !== 'draft') {
        await client.query('ROLLBACK')
        return reply.code(409).send({
          message: current.status === 'replaced'
            ? 'Facture remplacée : elle n\'est plus modifiable'
            : 'Facture validée : elle n\'est plus modifiable (« Corriger » ou « Remplacer par… »)',
        })
      }
      // A draft already paid (ADR 0022): its total stays known, and no lower than what is linked to it
      const { rows: [paid] } = await client.query<{ paid: string }>(
        'SELECT coalesce(sum(amount), 0)::text AS paid FROM invoice_payment WHERE invoice_id = $1', [id])
      if (new Big(paid!.paid).gt(0) && (header.total_incl_tax === null || new Big(paid!.paid).gt(header.total_incl_tax))) {
        await client.query('ROLLBACK')
        return reply.code(422).send({
          message: `Des paiements de ${new Big(paid!.paid).toFixed(2)} € sont rattachés : le total ne peut pas être inférieur`,
        })
      }
      await client.query(
        'UPDATE invoice SET number = $2, invoice_date = $3, total_incl_tax = $4, energy = $5, note = $6 WHERE id = $1',
        [id, header.number, header.invoice_date, header.total_incl_tax, header.energy, header.note],
      )
      await client.query('DELETE FROM invoice_line WHERE invoice_id = $1', [id])
      await insertLines(client, id, lines)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      if ((error as { code?: string }).code === '23505') {
        return reply.code(409).send({ message: 'Ce numéro de facture existe déjà chez ce fournisseur' })
      }
      throw error
    } finally {
      client.release()
    }
    return load(id)
  })

  // Validation: the checks run again on the stored lines; any « error » refuses it. The draft of a correction
  // replaces, in the same transaction, the invoice it corrects (ADR 0017).
  app.post('/factures/:id/valider', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const current = await load(id)
    if (!current) {
      return reply.code(404).send({ message: 'Facture introuvable' })
    }
    if (current.invoice.status !== 'draft') {
      return reply.code(409).send({ message: 'Facture déjà validée' })
    }
    if (!current.checks.can_validate) {
      return reply.code(422).send({ message: 'Contrôles en erreur : validation impossible', checks: current.checks })
    }
    const corrige: number | null = current.invoice.replaces_id
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      if (corrige !== null) {
        // The corrected invoice first: the number is unique among validated invoices
        const { rowCount } = await client.query(
          `UPDATE invoice SET status = 'replaced', replaced_by = $2, replaced_at = now(),
                              replacement_reason = 'Corrigée' || coalesce(' : ' || $3, '')
           WHERE id = $1 AND status = 'validated'`,
          [corrige, id, current.invoice.note],
        )
        if (!rowCount) {
          await client.query('ROLLBACK')
          return reply.code(409).send({
            message: 'La facture corrigée n\'est plus validée (déjà remplacée) : supprimer ce brouillon',
          })
        }
        // Its payments go to the correction (ADR 0022)
        await transfererReglements(client, corrige, id)
      }
      await client.query('UPDATE invoice SET status = \'validated\' WHERE id = $1 AND status = \'draft\'', [id])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      if ((error as { code?: string }).code === '23505') {
        return reply.code(409).send({ message: 'Une facture validée porte déjà ce numéro chez ce fournisseur' })
      }
      throw error
    } finally {
      client.release()
    }
    return {
      ...(await load(id))!,
      charge_adjustments: corrige === null ? [] : await regularisationsTouchees([corrige, id]),
    }
  })

  // Replace a validated invoice by another validated one of the same building (rectifying invoice, the real
  // document of an invoice typed by hand), with the reason; it leaves the statements (ADR 0017)
  app.post('/factures/:id/remplacer', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const body = (request.body ?? {}) as { par?: unknown, motif?: unknown }
    const par = Number(body.par)
    const motif = String(body.motif ?? '').trim()
    if (!Number.isInteger(par) || par === id) {
      return reply.code(400).send({ message: 'Choisir la facture qui la remplace' })
    }
    if (!motif) {
      return reply.code(400).send({ message: 'Motif du remplacement manquant' })
    }
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<{ id: number, building_id: number, status: string }>(
        'SELECT id, building_id, status FROM invoice WHERE id = ANY($1) ORDER BY id FOR UPDATE',
        [[id, par]],
      )
      const ancienne = rows.find((f) => f.id === id)
      const nouvelle = rows.find((f) => f.id === par)
      const refus = !ancienne ? [404, 'Facture introuvable']
        : ancienne.status !== 'validated' ? [409, 'Seule une facture validée se remplace (un brouillon se supprime)']
          : !nouvelle ? [400, 'Facture de remplacement introuvable']
            : nouvelle.building_id !== ancienne.building_id ? [400, 'La facture de remplacement est d\'un autre immeuble']
              : nouvelle.status !== 'validated' ? [400, 'La facture de remplacement doit être validée']
                : null
      if (refus) {
        await client.query('ROLLBACK')
        return reply.code(refus[0] as number).send({ message: refus[1] })
      }
      await client.query(
        `UPDATE invoice SET status = 'replaced', replaced_by = $2, replaced_at = now(), replacement_reason = $3
         WHERE id = $1`,
        [id, par, motif],
      )
      await transfererReglements(client, id, par)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    return { ...(await load(id))!, charge_adjustments: await regularisationsTouchees([id, par]) }
  })

  // Correct a validated invoice: a draft copy (header, lines, PDF, extractor) that replaces it once validated
  app.post('/factures/:id/corriger', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const current = await load(id)
    if (!current) {
      return reply.code(404).send({ message: 'Facture introuvable' })
    }
    if (current.invoice.status !== 'validated') {
      return reply.code(409).send({ message: 'Seule une facture validée se corrige (un brouillon se modifie)' })
    }
    if (current.liens.correction) {
      return reply.code(409).send({
        message: 'Une correction de cette facture est déjà en cours', invoice_id: current.liens.correction.id,
      })
    }
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const { rows: [copie] } = await client.query<{ id: number }>(
        `INSERT INTO invoice (building_id, supplier_id, energy, number, invoice_date, total_incl_tax, pdf_file, note,
                              extractor_id, replaces_id, tenant_copy_id, masked_zones)
         SELECT building_id, supplier_id, energy, number, invoice_date, total_incl_tax, pdf_file, note,
                extractor_id, id, tenant_copy_id, masked_zones
         FROM invoice WHERE id = $1 RETURNING id`,
        [id],
      )
      await insertLines(client, copie!.id, current.lines)
      await client.query('COMMIT')
      return reply.code(201).send(await load(copie!.id))
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })

  // ---------------------------------------------------------------- payments (ADR 0022)

  // The movements that may pay this invoice: debits (or a credit refunding it) « energie », « eau », « impots » or
  // without category, not covered in full; those of the same amount as its rest first, then by closeness to its date
  app.get('/factures/:id/mouvements', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const { rows: [f] } = await db.query<{ remaining: string, invoice_date: string | null }>(
      `SELECT ${RESTE_FACTURE_SQL}::text AS remaining, f.invoice_date::text FROM invoice f WHERE f.id = $1`, [id])
    if (!f) {
      return reply.code(404).send({ message: 'Facture introuvable' })
    }
    const { rows } = await db.query(
      `SELECT * FROM (
         SELECT m.id, m.transaction_date::text, m.label, m.amount::text, m.category,
                (abs(m.amount) - ${COUVERT_SQL})::text AS remaining
         FROM bank_transaction m
         WHERE (m.category IS NULL OR m.category = ANY($1))
           AND NOT EXISTS (SELECT 1 FROM invoice_payment rf WHERE rf.invoice_id = $2 AND rf.bank_transaction_id = m.id)
       ) x
       WHERE remaining::numeric > 0
       ORDER BY (remaining::numeric = $3::numeric AND amount::numeric < 0) DESC,
                abs(transaction_date::date - coalesce($4::date, transaction_date::date)), id
       LIMIT 200`,
      [AVEC_FACTURE, id, f.remaining, f.invoice_date],
    )
    return rows.map((m) => ({ ...m, correspond: new Big(m.amount).lt(0) && new Big(m.remaining).eq(f.remaining) }))
  })

  // Linked to a debit: a payment of what remains of the movement, no more than what remains of the invoice; to a
  // credit: a refund
  app.post('/factures/:id/reglements', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    try {
      const bank_transaction = Number((request.body as { bank_transaction_id?: unknown } | undefined)?.bank_transaction_id)
      if (!Number.isInteger(bank_transaction)) {
        throw new InputError('Choisir le mouvement bancaire qui règle la facture')
      }
      await reglerFacture(db, id, bank_transaction)
      return load(id)
    } catch (error) {
      if (error instanceof IntrouvableError) {
        return reply.code(404).send({ message: error.message })
      }
      return sendError(reply, error)
    }
  })

  app.delete('/factures/:id/reglements/:reglement', async (request, reply) => {
    const { id, reglement } = request.params as { id: string, reglement: string }
    await db.query('DELETE FROM invoice_payment WHERE id = $1 AND invoice_id = $2', [Number(reglement), Number(id)])
    return (await load(Number(id))) ?? reply.code(404).send({ message: 'Facture introuvable' })
  })

  // Only a draft can be deleted (to import it again, for instance)
  app.delete('/factures/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const { rows: tenant_copies } = await db.query<{ pdf_file: string }>(
      'SELECT pdf_file FROM invoice_tenant_copy WHERE invoice_id = $1', [id])
    const { rows: [deleted] } = await db.query<{ pdf_file: string | null }>(
      'DELETE FROM invoice WHERE id = $1 AND status = \'draft\' RETURNING pdf_file',
      [id],
    )
    if (!deleted) {
      const { rowCount } = await db.query('SELECT 1 FROM invoice WHERE id = $1', [id])
      return rowCount
        ? reply.code(409).send({ message: 'Facture validée : suppression impossible (« Remplacer par… »)' })
        : reply.code(404).send({ message: 'Facture introuvable' })
    }
    for (const fichier of [deleted.pdf_file, ...tenant_copies.map((a) => a.pdf_file)]) {
      if (fichier) {
        await removeIfUnused(fichier)
      }
    }
    return reply.code(204).send()
  })

  const removeIfUnused = (fileName: string) => removeFile(db, storageDir, fileName)

  // Attaches (or replaces) the PDF of an existing invoice, validated or not: the lines are not touched. The screen
  // checks first, with the extractors, that the PDF is this invoice (ADR 0013).
  app.post('/factures/:id/pdf', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const { rows: [invoice] } = await db.query<{ supplier: string, number: string, pdf_file: string | null }>(
      `SELECT fo.name AS supplier, f.number, f.pdf_file
       FROM invoice f JOIN supplier fo ON fo.id = f.supplier_id WHERE f.id = $1`,
      [id],
    )
    if (!invoice) {
      return reply.code(404).send({ message: 'Facture introuvable' })
    }
    const file = await request.file()
    if (!file) {
      return reply.code(400).send({ message: 'Aucun fichier reçu' })
    }
    const content = await file.toBuffer()
    if (!isPdf(content)) {
      return reply.code(415).send({ message: `${file.filename} n'est pas un PDF` })
    }
    const { fileName } = await storePdf(storageDir, content, 'factures')
    // A new PDF: its version in images is to be made again (ADR 0024), its zones drawn by hand were for the other one
    await db.query(
      `UPDATE invoice SET pdf_file = $2, tenant_copy_id = CASE WHEN pdf_file = $2 THEN tenant_copy_id END,
                          masked_zones = CASE WHEN pdf_file = $2 THEN masked_zones END
       WHERE id = $1`,
      [id, fileName])
    if (invoice.pdf_file && invoice.pdf_file !== fileName) {
      await removeIfUnused(invoice.pdf_file)
    }
    return load(id)
  })

  // ---------------------------------------------------------------- version in images (ADR 0024)

  // The version in images of the invoice, made in the browser: multipart with the PDF « file » and the field
  // « annexe », JSON { zones, extracteur_id (null: masked terms only), termes, reglages, pages_scannees (ADR 0025) }.
  // A new version, to verify.
  app.post('/factures/:id/annexe', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const { rows: [invoice] } = await db.query<{ pdf_file: string | null }>(
      'SELECT pdf_file FROM invoice WHERE id = $1', [id])
    if (!invoice) {
      return reply.code(404).send({ message: 'Facture introuvable' })
    }
    if (!invoice.pdf_file) {
      return reply.code(409).send({ message: 'Facture sans PDF : rien à joindre' })
    }
    let content: Buffer | null = null
    let tenant_copy: Record<string, unknown> | null = null
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        content = await part.toBuffer()
      } else if (part.fieldname === 'tenant_copy') {
        try {
          tenant_copy = JSON.parse(String(part.value))
        } catch {
          return reply.code(400).send({ message: '« annexe » doit être du JSON' })
        }
      }
    }
    if (!content || !isPdf(content)) {
      return reply.code(400).send({ message: 'PDF de l\'annexe manquant' })
    }
    if (!tenant_copy || !Array.isArray(tenant_copy.zones) || !Array.isArray(tenant_copy.terms)
      || typeof tenant_copy.settings !== 'object' || tenant_copy.settings === null) {
      return reply.code(400).send({ message: 'Annexe incomplète : zones, termes et réglages attendus' })
    }
    const extracteurId = tenant_copy.extractor_id === null || tenant_copy.extractor_id === undefined
      ? null : Number(tenant_copy.extractor_id)
    const scannees = tenant_copy.scanned_pages ?? []
    if (!Array.isArray(scannees) || !scannees.every((p) => Number.isInteger(p) && p >= 1)) {
      return reply.code(400).send({ message: '« scanned_pages » : une liste de numéros de page attendue' })
    }
    const { fileName } = await storePdf(storageDir, content, 'annexes')
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const { rows: [created] } = await client.query<{ id: number }>(
        `INSERT INTO invoice_tenant_copy (invoice_id, pdf_file, source_pdf, zones, extractor_id, terms, settings,
                                     scanned_pages)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [id, fileName, invoice.pdf_file, JSON.stringify(tenant_copy.zones), extracteurId,
          tenant_copy.terms.map(String), JSON.stringify(tenant_copy.settings), scannees],
      )
      await client.query('UPDATE invoice SET tenant_copy_id = $2 WHERE id = $1', [id, created!.id])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      await removeIfUnused(fileName)
      throw error
    } finally {
      client.release()
    }
    return reply.code(201).send(await load(id))
  })

  app.get('/factures/:id/annexe/pdf', async (request, reply) => {
    const { rows: [tenant_copy] } = await db.query<{ pdf_file: string }>(
      'SELECT a.pdf_file FROM invoice f JOIN invoice_tenant_copy a ON a.id = f.tenant_copy_id WHERE f.id = $1',
      [Number((request.params as { id: string }).id)],
    )
    if (!tenant_copy) {
      return reply.code(404).send({ message: 'Pas de version en images pour cette facture' })
    }
    return reply
      .type('application/pdf')
      .header('content-disposition', 'inline')
      .send(createReadStream(join(storageDir, tenant_copy.pdf_file)))
  })

  // Checked by eye: nothing personal left. Only the current version, made from the current PDF.
  app.post('/factures/:id/annexe/verifiee', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const annexeId = Number((request.body as { tenant_copy_id?: unknown } | null)?.tenant_copy_id)
    const { rowCount } = await db.query(
      `UPDATE invoice_tenant_copy a SET checked_at = now() FROM invoice f
       WHERE f.id = $1 AND a.id = f.tenant_copy_id AND a.id = $2 AND a.source_pdf = f.pdf_file AND a.checked_at IS NULL`,
      [id, annexeId],
    )
    return rowCount
      ? load(id)
      : reply.code(409).send({ message: 'Cette version n\'est plus celle de la facture, ou elle est déjà vérifiée' })
  })

  // The zones of its scans adjusted by hand (ADR 0025), whatever its status: they change only its version in images,
  // to make again. null: back to those of its supplier
  app.put('/factures/:id/zones', async (request, reply) => {
    try {
      const valeur = (request.body as { zones?: unknown } | null)?.zones
      const zones = valeur === null ? null : JSON.stringify(zonesSaisies(valeur))
      const id = Number((request.params as { id: string }).id)
      const { rowCount } = await db.query('UPDATE invoice SET masked_zones = $2 WHERE id = $1', [id, zones])
      return rowCount ? load(id) : reply.code(404).send({ message: 'Facture introuvable' })
    } catch (error) {
      return sendError(reply, error)
    }
  })

  // Terms masked on every invoice (manager, address, bank account): data of the deployment, never in this repository
  app.get('/termes-masques', async () =>
    (await db.query<{ term: string }>('SELECT term FROM masked_term ORDER BY term')).rows.map((r) => r.term))

  app.put('/termes-masques', async (request, reply) => {
    const terms = (request.body as { terms?: unknown } | null)?.terms
    if (!Array.isArray(terms)) {
      return reply.code(400).send({ message: '« termes » : une liste attendue' })
    }
    const propres = [...new Set(terms.map((t) => String(t).trim()).filter(Boolean))]
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM masked_term')
      await client.query('INSERT INTO masked_term (term) SELECT unnest($1::text[])', [propres])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    return propres.sort()
  })
}

async function insertLines(client: PoolClient, factureId: number, lines: InvoiceLine[]) {
  for (const [position, l] of lines.entries()) {
    await client.query(
      `INSERT INTO invoice_line
         (invoice_id, position, category, label, period, kwh, amount_excl_tax, vat_rate, amount_incl_tax, allocation, note)
       VALUES ($1, $2, $3, $4, ${inclusiveRange('$5', '$6')}, $7, $8, $9, $10, $11, $12)`,
      [factureId, position, l.category, l.label, l.start, l.end, l.kwh, l.amount_excl_tax, l.vat_rate, l.amount_incl_tax,
        l.allocation, l.note],
    )
  }
}

export default facturesRoutes

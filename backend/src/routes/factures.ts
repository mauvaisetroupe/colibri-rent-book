import { createReadStream } from 'node:fs'
import { join } from 'node:path'

import multipart from '@fastify/multipart'
import Big from 'big.js'
import type { FastifyPluginAsync } from 'fastify'
import type { Pool, PoolClient } from 'pg'

import { checkInvoice, isDecimal } from '../invoices/checks.js'
import { BadRequestError, readLines, readTotal } from '../invoices/requestBody.js'
import type { InvoiceLine } from '../invoices/types.js'
import { AVEC_FACTURE } from '../categories.js'
import { COUVERT_SQL } from '../couverture.js'
import { InputError, sendError } from '../http.js'
import { isPdf, removeIfUnused as removeFile, storePdf } from '../pdfStorage.js'
import { inclusiveBounds, inclusiveRange } from '../periods.js'
import { IntrouvableError, RESTE_FACTURE_SQL, reglerFacture, transfererReglements } from '../reglementsFacture.js'

// Invoices: import of a PDF read in the browser (draft), editing, validation (ADR 0003, 0005, 0013), replacement of
// a validated invoice (ADR 0017), payments by bank movements (ADR 0022). Periods: see periods.ts.

export type FactureOptions = {
  db: Pool
  // Folder where the uploaded PDFs are archived; facture.fichier_pdf holds the file name only
  storageDir: string
}

const ENERGIES = ['gaz', 'electricite', 'eau', 'ordures_menageres', 'autre']

const LINE_COLUMNS = `
  categorie, libelle, ${inclusiveBounds('periode')},
  kwh::text, montant_ht::text, taux_tva::text, montant_ttc::text, affectation, note`

const FACTURE_COLUMNS = `
  f.id, f.immeuble_id, fo.nom AS fournisseur, f.energie, f.numero, f.date_facture::text,
  f.montant_ttc::text, f.statut, f.note, f.fichier_pdf IS NOT NULL AS pdf,
  f.remplacee_par, f.remplacee_le::text, f.motif_remplacement, f.remplace_id,
  (SELECT coalesce(sum(rf.montant), 0) FROM reglement_facture rf WHERE rf.facture_id = f.id)::text AS paye,
  ${RESTE_FACTURE_SQL}::text AS reste,
  (SELECT max(m.date_operation) FROM reglement_facture rf JOIN mouvement m ON m.id = rf.mouvement_id
   WHERE rf.facture_id = f.id)::text AS date_paiement`

// Another invoice, as shown in a link: « EDF n° 123 »
type Reference = { id: number, fournisseur: string, numero: string, statut: string }
const REFERENCE = `SELECT f.id, fo.nom AS fournisseur, f.numero, f.statut
  FROM facture f JOIN fournisseur fo ON fo.id = f.fournisseur_id`

// numeric::text keeps the scale ('148.540', '0.0550'): canonical form for the API
const canonical = (value: string | null) => (value === null ? null : new Big(value).toString())

type Header = { numero: string, date_facture: string, montant_ttc: string | null, energie: string, note: string | null }

/** Invoice header as typed in the form, with what is wrong with it (empty when it can be stored). */
function readHeader(body: Record<string, unknown>): { header: Header, problems: string[] } {
  const note = String(body.note ?? '').trim()
  const header = {
    numero: String(body.numero ?? '').trim(),
    date_facture: String(body.date_facture ?? '').trim(),
    montant_ttc: readTotal(body.montant_ttc) || null,
    energie: String(body.energie ?? ''),
    note: note || null,
  }
  const problems = [
    !header.numero && 'numéro manquant',
    !/^\d{4}-\d\d-\d\d$/.test(header.date_facture) && 'date de facture invalide',
    header.montant_ttc !== null && !isDecimal(header.montant_ttc) && 'total imprimé invalide',
    !ENERGIES.includes(header.energie) && 'énergie inconnue',
  ].filter((p): p is string => Boolean(p))
  return { header, problems }
}

const facturesRoutes: FastifyPluginAsync<FactureOptions> = async (app, { db, storageDir }) => {
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1, fieldSize: 5 * 1024 * 1024 } })

  async function load(id: number) {
    const { rows: [facture] } = await db.query(
      `SELECT ${FACTURE_COLUMNS} FROM facture f JOIN fournisseur fo ON fo.id = f.fournisseur_id WHERE f.id = $1`,
      [id],
    )
    if (!facture) {
      return null
    }
    const { rows } = await db.query<InvoiceLine>(
      `SELECT ${LINE_COLUMNS} FROM ligne_facture WHERE facture_id = $1 ORDER BY ordre, id`,
      [id],
    )
    const lignes = rows.map((l) => ({
      ...l,
      kwh: canonical(l.kwh),
      montant_ht: canonical(l.montant_ht),
      taux_tva: canonical(l.taux_tva),
      montant_ttc: new Big(l.montant_ttc).toString(),
    }))
    facture.montant_ttc = canonical(facture.montant_ttc)
    // The invoices linked by a replacement (ADR 0017): the one replacing it, those it replaced, the one it corrects
    const reference = async (fid: number | null) =>
      fid === null ? null : (await db.query<Reference>(`${REFERENCE} WHERE f.id = $1`, [fid])).rows[0] ?? null
    const liens = {
      remplacante: await reference(facture.remplacee_par),
      remplacees: (await db.query<Reference>(`${REFERENCE} WHERE f.remplacee_par = $1 ORDER BY f.id`, [id])).rows,
      corrige: await reference(facture.remplace_id),
      correction: (await db.query<Reference>(
        `${REFERENCE} WHERE f.remplace_id = $1 AND f.statut = 'a_verifier'`, [id])).rows[0] ?? null,
    }
    // Its payments (ADR 0022): the movement (date, label), the amount
    const { rows: reglements } = await db.query(
      `SELECT rf.id, rf.mouvement_id, m.date_operation::text AS date_paiement, m.libelle, rf.montant::text
       FROM reglement_facture rf JOIN mouvement m ON m.id = rf.mouvement_id
       WHERE rf.facture_id = $1 ORDER BY m.date_operation, rf.id`, [id])
    return { facture, lignes, liens, reglements, controle: checkInvoice({ montant_ttc: facture.montant_ttc, lignes }) }
  }

  /** Sent regularisations, not rectified yet, whose period touches recoverable lines of these invoices: to check. */
  async function regularisationsTouchees(ids: number[]) {
    const { rows } = await db.query(
      `SELECT DISTINCT r.id, lo.nom AS locataire, lt.code AS lot, ${inclusiveBounds('r.exercice')}, r.solde::text
       FROM regularisation r
       JOIN sejour s ON s.id = r.sejour_id
       JOIN lot lt ON lt.id = s.lot_id
       JOIN locataire lo ON lo.id = s.locataire_id
       WHERE r.date_envoi IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM regularisation n WHERE n.remplace_id = r.id)
         AND EXISTS (
           SELECT 1 FROM ligne_facture l JOIN facture f ON f.id = l.facture_id
           WHERE l.facture_id = ANY($1) AND l.affectation = 'recuperable' AND f.immeuble_id = lt.immeuble_id
             AND l.periode && r.exercice)
       ORDER BY debut, locataire`,
      [ids],
    )
    return rows
  }

  app.get('/factures', async (request, reply) => {
    const immeuble = Number((request.query as { immeuble?: string }).immeuble)
    if (!Number.isInteger(immeuble)) {
      return reply.code(400).send({ message: 'Paramètre « immeuble » manquant' })
    }
    const { rows } = await db.query(
      `SELECT ${FACTURE_COLUMNS}, c.ok AS total_ok, ${inclusiveBounds('e.etendue')}, e.nb_lignes
       FROM facture f
       JOIN fournisseur fo ON fo.id = f.fournisseur_id
       JOIN v_controle_facture c ON c.id = f.id
       CROSS JOIN LATERAL (
         SELECT range_merge(range_agg(l.periode)) AS etendue, count(*)::int AS nb_lignes
         FROM ligne_facture l WHERE l.facture_id = f.id
       ) e
       WHERE f.immeuble_id = $1
       ORDER BY f.date_facture DESC NULLS LAST, f.id DESC`,
      [immeuble],
    )
    return rows.map((r) => ({ ...r, montant_ttc: canonical(r.montant_ttc) }))
  })

  app.get('/factures/:id', async (request, reply) => {
    const result = await load(Number((request.params as { id: string }).id))
    return result ?? reply.code(404).send({ message: 'Facture introuvable' })
  })

  app.get('/factures/:id/pdf', async (request, reply) => {
    const { rows: [facture] } = await db.query<{ fichier_pdf: string | null }>(
      'SELECT fichier_pdf FROM facture WHERE id = $1',
      [Number((request.params as { id: string }).id)],
    )
    if (!facture?.fichier_pdf) {
      return reply.code(404).send({ message: 'Pas de PDF pour cette facture' })
    }
    return reply
      .type('application/pdf')
      .header('content-disposition', 'inline')
      .send(createReadStream(join(storageDir, facture.fichier_pdf)))
  })

  // PDF and the draft read from it by an extractor, in the browser (ADR 0013): stored as a draft (statut a_verifier)
  // with the version of the extractor. Multipart: the PDF « file » and the field « brouillon », JSON
  // { extracteur_id, numero, date_facture, montant_ttc (may be null: typed later), lignes }.
  app.post('/factures/import', async (request, reply) => {
    const immeuble = Number((request.query as { immeuble?: string }).immeuble)
    const { rowCount } = await db.query('SELECT 1 FROM immeuble WHERE id = $1', [immeuble])
    if (!Number.isInteger(immeuble) || !rowCount) {
      return reply.code(400).send({ message: 'Immeuble inconnu' })
    }
    let content: Buffer | null = null
    let filename = ''
    let brouillon: Record<string, unknown> | null = null
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        content = await part.toBuffer()
        filename = part.filename
      } else if (part.fieldname === 'brouillon') {
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
    const { rows: [extracteur] } = await db.query<{ id: number, fournisseur: string, energie: string }>(
      `SELECT e.id, fo.nom AS fournisseur, e.energie FROM extracteur e JOIN fournisseur fo ON fo.id = e.fournisseur_id
       WHERE e.id = $1`,
      [Number(brouillon.extracteur_id)],
    )
    if (!extracteur) {
      return reply.code(400).send({ message: 'Extracteur inconnu' })
    }
    let lignes: InvoiceLine[]
    try {
      lignes = readLines(brouillon.lignes)
    } catch (error) {
      if (error instanceof BadRequestError) {
        return reply.code(400).send({ message: error.message })
      }
      throw error
    }
    const { header, problems } = readHeader({ ...brouillon, energie: extracteur.energie })
    if (problems.length) {
      return reply.code(422).send({ message: `Facture mal lue : ${problems.join(', ')}`, code: 'saisie_manuelle' })
    }
    const controle = checkInvoice({ montant_ttc: header.montant_ttc, lignes })
    if (!controle.enregistrable) {
      return reply.code(422).send({
        message: 'Lignes mal lues (corriger l\'extracteur, ou saisir la facture à la main)', code: 'saisie_manuelle', controle,
      })
    }

    const { fileName } = await storePdf(storageDir, content, 'factures')
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const { rows: [existing] } = await client.query<{ id: number }>(
        `SELECT f.id FROM facture f JOIN fournisseur fo ON fo.id = f.fournisseur_id
         WHERE fo.nom = $1 AND f.numero = $2 AND f.statut <> 'remplacee'
         ORDER BY f.statut DESC LIMIT 1`,
        [extracteur.fournisseur, header.numero],
      )
      if (existing) {
        await client.query('ROLLBACK')
        await removeIfUnused(fileName)
        return reply.code(409).send({
          message: `Facture ${extracteur.fournisseur} n° ${header.numero} déjà importée`,
          facture_id: existing.id,
        })
      }
      const { rows: [created] } = await client.query<{ id: number }>(
        `INSERT INTO facture (immeuble_id, fournisseur_id, energie, numero, date_facture, montant_ttc, fichier_pdf,
                              extracteur_id)
         VALUES ($1, (SELECT fournisseur_id FROM extracteur WHERE id = $7), $2, $3, $4, $5, $6, $7) RETURNING id`,
        [immeuble, header.energie, header.numero, header.date_facture, header.montant_ttc, fileName, extracteur.id],
      )
      if (!created) {
        throw new Error('Insertion de la facture sans identifiant')
      }
      await insertLines(client, created.id, lignes)
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
    const immeuble = Number((request.query as { immeuble?: string }).immeuble)
    const { rowCount } = await db.query('SELECT 1 FROM immeuble WHERE id = $1', [immeuble])
    if (!Number.isInteger(immeuble) || !rowCount) {
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
    const fournisseur = String(body.fournisseur ?? '').trim()
    const { header, problems } = readHeader(body)
    if (!fournisseur) {
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
      await client.query('INSERT INTO fournisseur (nom) VALUES ($1) ON CONFLICT (nom) DO NOTHING', [fournisseur])
      const { rows: [existing] } = await client.query<{ id: number }>(
        `SELECT f.id FROM facture f JOIN fournisseur fo ON fo.id = f.fournisseur_id
         WHERE fo.nom = $1 AND f.numero = $2 AND f.statut <> 'remplacee'
         ORDER BY f.statut DESC LIMIT 1`,
        [fournisseur, header.numero],
      )
      if (existing) {
        await client.query('ROLLBACK')
        if (fileName) {
          await removeIfUnused(fileName)
        }
        return reply.code(409).send({
          message: `Facture ${fournisseur} n° ${header.numero} déjà enregistrée`,
          facture_id: existing.id,
        })
      }
      const { rows: [created] } = await client.query<{ id: number }>(
        `INSERT INTO facture (immeuble_id, fournisseur_id, energie, numero, date_facture, montant_ttc, note, fichier_pdf)
         VALUES ($1, (SELECT id FROM fournisseur WHERE nom = $2), $3, $4, $5, $6, $7, $8) RETURNING id`,
        [immeuble, fournisseur, header.energie, header.numero, header.date_facture, header.montant_ttc, header.note,
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
    let lignes: InvoiceLine[]
    try {
      lignes = readLines(body.lignes)
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
    const controle = checkInvoice({ montant_ttc: header.montant_ttc, lignes })
    if (!controle.enregistrable) {
      return reply.code(422).send({ message: 'Corriger les erreurs de saisie avant d\'enregistrer', controle })
    }

    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const { rows: [current] } = await client.query<{ statut: string }>(
        'SELECT statut FROM facture WHERE id = $1 FOR UPDATE',
        [id],
      )
      if (!current) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ message: 'Facture introuvable' })
      }
      if (current.statut !== 'a_verifier') {
        await client.query('ROLLBACK')
        return reply.code(409).send({
          message: current.statut === 'remplacee'
            ? 'Facture remplacée : elle n\'est plus modifiable'
            : 'Facture validée : elle n\'est plus modifiable (« Corriger » ou « Remplacer par… »)',
        })
      }
      await client.query(
        'UPDATE facture SET numero = $2, date_facture = $3, montant_ttc = $4, energie = $5, note = $6 WHERE id = $1',
        [id, header.numero, header.date_facture, header.montant_ttc, header.energie, header.note],
      )
      await client.query('DELETE FROM ligne_facture WHERE facture_id = $1', [id])
      await insertLines(client, id, lignes)
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

  // Validation: the checks run again on the stored lines; any « erreur » refuses it. The draft of a correction
  // replaces, in the same transaction, the invoice it corrects (ADR 0017).
  app.post('/factures/:id/valider', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const current = await load(id)
    if (!current) {
      return reply.code(404).send({ message: 'Facture introuvable' })
    }
    if (current.facture.statut !== 'a_verifier') {
      return reply.code(409).send({ message: 'Facture déjà validée' })
    }
    if (!current.controle.validable) {
      return reply.code(422).send({ message: 'Contrôles en erreur : validation impossible', controle: current.controle })
    }
    const corrige: number | null = current.facture.remplace_id
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      if (corrige !== null) {
        // The corrected invoice first: the number is unique among validated invoices
        const { rowCount } = await client.query(
          `UPDATE facture SET statut = 'remplacee', remplacee_par = $2, remplacee_le = now(),
                              motif_remplacement = 'Corrigée' || coalesce(' : ' || $3, '')
           WHERE id = $1 AND statut = 'validee'`,
          [corrige, id, current.facture.note],
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
      await client.query('UPDATE facture SET statut = \'validee\' WHERE id = $1 AND statut = \'a_verifier\'', [id])
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
      regularisations: corrige === null ? [] : await regularisationsTouchees([corrige, id]),
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
      const { rows } = await client.query<{ id: number, immeuble_id: number, statut: string }>(
        'SELECT id, immeuble_id, statut FROM facture WHERE id = ANY($1) ORDER BY id FOR UPDATE',
        [[id, par]],
      )
      const ancienne = rows.find((f) => f.id === id)
      const nouvelle = rows.find((f) => f.id === par)
      const refus = !ancienne ? [404, 'Facture introuvable']
        : ancienne.statut !== 'validee' ? [409, 'Seule une facture validée se remplace (un brouillon se supprime)']
          : !nouvelle ? [400, 'Facture de remplacement introuvable']
            : nouvelle.immeuble_id !== ancienne.immeuble_id ? [400, 'La facture de remplacement est d\'un autre immeuble']
              : nouvelle.statut !== 'validee' ? [400, 'La facture de remplacement doit être validée']
                : null
      if (refus) {
        await client.query('ROLLBACK')
        return reply.code(refus[0] as number).send({ message: refus[1] })
      }
      await client.query(
        `UPDATE facture SET statut = 'remplacee', remplacee_par = $2, remplacee_le = now(), motif_remplacement = $3
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
    return { ...(await load(id))!, regularisations: await regularisationsTouchees([id, par]) }
  })

  // Correct a validated invoice: a draft copy (header, lines, PDF, extractor) that replaces it once validated
  app.post('/factures/:id/corriger', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const current = await load(id)
    if (!current) {
      return reply.code(404).send({ message: 'Facture introuvable' })
    }
    if (current.facture.statut !== 'validee') {
      return reply.code(409).send({ message: 'Seule une facture validée se corrige (un brouillon se modifie)' })
    }
    if (current.liens.correction) {
      return reply.code(409).send({
        message: 'Une correction de cette facture est déjà en cours', facture_id: current.liens.correction.id,
      })
    }
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const { rows: [copie] } = await client.query<{ id: number }>(
        `INSERT INTO facture (immeuble_id, fournisseur_id, energie, numero, date_facture, montant_ttc, fichier_pdf, note,
                              extracteur_id, remplace_id)
         SELECT immeuble_id, fournisseur_id, energie, numero, date_facture, montant_ttc, fichier_pdf, note,
                extracteur_id, id
         FROM facture WHERE id = $1 RETURNING id`,
        [id],
      )
      await insertLines(client, copie!.id, current.lignes)
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

  // The debits that may pay this invoice: « energie », « eau », « impots » or without category, not covered in full;
  // those of the same amount as its rest first, then by closeness to its date
  app.get('/factures/:id/mouvements', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const { rows: [f] } = await db.query<{ reste: string, date_facture: string | null }>(
      `SELECT ${RESTE_FACTURE_SQL}::text AS reste, f.date_facture::text FROM facture f WHERE f.id = $1`, [id])
    if (!f) {
      return reply.code(404).send({ message: 'Facture introuvable' })
    }
    const { rows } = await db.query(
      `SELECT * FROM (
         SELECT m.id, m.date_operation::text, m.libelle, m.montant::text, m.categorie,
                (abs(m.montant) - ${COUVERT_SQL})::text AS reste
         FROM mouvement m
         WHERE m.montant < 0 AND (m.categorie IS NULL OR m.categorie = ANY($1))
           AND NOT EXISTS (SELECT 1 FROM reglement_facture rf WHERE rf.facture_id = $2 AND rf.mouvement_id = m.id)
       ) x
       WHERE reste::numeric > 0
       ORDER BY (reste::numeric = $3::numeric) DESC, abs(date_operation::date - coalesce($4::date, date_operation::date)), id
       LIMIT 200`,
      [AVEC_FACTURE, id, f.reste, f.date_facture],
    )
    return rows.map((m) => ({ ...m, correspond: new Big(m.reste).eq(f.reste) }))
  })

  // Linked to a debit: a payment of what remains of the movement, no more than what remains of the invoice
  app.post('/factures/:id/reglements', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    try {
      const mouvement = Number((request.body as { mouvement_id?: unknown } | undefined)?.mouvement_id)
      if (!Number.isInteger(mouvement)) {
        throw new InputError('Choisir le mouvement bancaire qui règle la facture')
      }
      await reglerFacture(db, id, mouvement)
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
    await db.query('DELETE FROM reglement_facture WHERE id = $1 AND facture_id = $2', [Number(reglement), Number(id)])
    return (await load(Number(id))) ?? reply.code(404).send({ message: 'Facture introuvable' })
  })

  // Only a draft can be deleted (to import it again, for instance)
  app.delete('/factures/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const { rows: [deleted] } = await db.query<{ fichier_pdf: string | null }>(
      'DELETE FROM facture WHERE id = $1 AND statut = \'a_verifier\' RETURNING fichier_pdf',
      [id],
    )
    if (!deleted) {
      const { rowCount } = await db.query('SELECT 1 FROM facture WHERE id = $1', [id])
      return rowCount
        ? reply.code(409).send({ message: 'Facture validée : suppression impossible (« Remplacer par… »)' })
        : reply.code(404).send({ message: 'Facture introuvable' })
    }
    if (deleted.fichier_pdf) {
      await removeIfUnused(deleted.fichier_pdf)
    }
    return reply.code(204).send()
  })

  const removeIfUnused = (fileName: string) => removeFile(db, storageDir, fileName)

  // Attaches (or replaces) the PDF of an existing invoice, validated or not: the lines are not touched. The screen
  // checks first, with the extractors, that the PDF is this invoice (ADR 0013).
  app.post('/factures/:id/pdf', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const { rows: [facture] } = await db.query<{ fournisseur: string, numero: string, fichier_pdf: string | null }>(
      `SELECT fo.nom AS fournisseur, f.numero, f.fichier_pdf
       FROM facture f JOIN fournisseur fo ON fo.id = f.fournisseur_id WHERE f.id = $1`,
      [id],
    )
    if (!facture) {
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
    await db.query('UPDATE facture SET fichier_pdf = $2 WHERE id = $1', [id, fileName])
    if (facture.fichier_pdf && facture.fichier_pdf !== fileName) {
      await removeIfUnused(facture.fichier_pdf)
    }
    return load(id)
  })
}

async function insertLines(client: PoolClient, factureId: number, lignes: InvoiceLine[]) {
  for (const [ordre, l] of lignes.entries()) {
    await client.query(
      `INSERT INTO ligne_facture
         (facture_id, ordre, categorie, libelle, periode, kwh, montant_ht, taux_tva, montant_ttc, affectation, note)
       VALUES ($1, $2, $3, $4, ${inclusiveRange('$5', '$6')}, $7, $8, $9, $10, $11, $12)`,
      [factureId, ordre, l.categorie, l.libelle, l.debut, l.fin, l.kwh, l.montant_ht, l.taux_tva, l.montant_ttc,
        l.affectation, l.note],
    )
  }
}

export default facturesRoutes

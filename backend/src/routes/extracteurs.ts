import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'

import { ETAT_ANNEXE_SQL } from '../annexes.js'
import { body, idParam, InputError, optionalText, requiredText, sendError } from '../http.js'

// Invoice extractors (ADR 0013): TypeScript code written in the « Extracteurs » screen and run in the browser only;
// the server stores them and never runs them. Versions are never changed nor deleted (trigger extracteur_fige):
// correcting an extractor creates the next version of its supplier.

const ENERGIES = ['gas', 'electricity', 'water', 'household_waste', 'other']

const COLUMNS = `e.id, fo.name AS supplier, e.version, e.type, e.energy, e.settings, e.source, e.code, e.engine, e.note,
  e.created_at, e.version = max(e.version) OVER (PARTITION BY e.supplier_id) AS latest,
  (SELECT count(*)::int FROM invoice f WHERE f.extractor_id = e.id) AS invoice_count,
  (SELECT count(*)::int FROM bank_statement r WHERE r.extractor_id = e.id) AS statement_count`

function readReglages(value: unknown) {
  const r = (value ?? {}) as Record<string, unknown>
  const settings: Record<string, number> = {
    lineTolerance: Number(r.lineTolerance), joinGap: Number(r.joinGap), columnGap: Number(r.columnGap),
  }
  // Bank statements (ADR 0018): pieces left of this abscissa are ignored (code printed in the margin)
  if (r.margin !== undefined) {
    settings.margin = Number(r.margin)
  }
  if (!Object.values(settings).every((v) => Number.isFinite(v) && v >= 0)) {
    throw new InputError('Réglages du regroupement : lineTolerance, joinGap, columnGap (et margin), nombres positifs')
  }
  return settings
}

const extracteurRoutes: FastifyPluginAsync<{ db: Pool }> = async (app, { db }) => {
  // Every version, the last one of each supplier first
  app.get('/extracteurs', async () => {
    const { rows } = await db.query(
      `SELECT ${COLUMNS} FROM extractor e JOIN supplier fo ON fo.id = e.supplier_id
       ORDER BY fo.name, e.version DESC`,
    )
    return rows
  })

  // Statements of a bank that have a PDF: the editor of a statement extractor reads them again (ADR 0018)
  app.get('/extracteurs/releves', async (request, reply) => {
    const supplier = String((request.query as { supplier?: string }).supplier ?? '')
    if (!supplier) {
      return reply.code(400).send({ message: 'Paramètre « fournisseur » manquant' })
    }
    const { rows } = await db.query(
      `SELECT r.id, r.account, r.statement_date::text, r.previous_balance::text, r.new_balance::text, r.extractor_id
       FROM bank_statement r JOIN supplier fo ON fo.id = r.supplier_id
       WHERE fo.name = $1 AND r.pdf_file IS NOT NULL ORDER BY r.statement_date DESC, r.account`,
      [supplier],
    )
    return rows
  })

  // Invoices of a supplier that have a PDF, every building: the editor reads them again with a new version before it
  // is saved, and shows what changes (non-regression)
  app.get('/extracteurs/factures', async (request, reply) => {
    const supplier = String((request.query as { supplier?: string }).supplier ?? '')
    if (!supplier) {
      return reply.code(400).send({ message: 'Paramètre « fournisseur » manquant' })
    }
    const { rows } = await db.query(
      `SELECT f.id, f.number, f.invoice_date::text, f.total_incl_tax::text, f.status, f.extractor_id, i.name AS building,
              ${ETAT_ANNEXE_SQL} AS tenant_copy, fo.id AS supplier_id, f.masked_zones
       FROM invoice f JOIN supplier fo ON fo.id = f.supplier_id JOIN building i ON i.id = f.building_id
       WHERE fo.name = $1 AND f.pdf_file IS NOT NULL
       ORDER BY f.invoice_date DESC NULLS LAST, f.id DESC`,
      [supplier],
    )
    return rows
  })

  app.get('/extracteurs/:id', async (request, reply) => {
    const { rows: [extractor] } = await db.query(
      `SELECT * FROM (SELECT ${COLUMNS} FROM extractor e JOIN supplier fo ON fo.id = e.supplier_id) x WHERE id = $1`,
      [idParam(request)],
    )
    return extractor ?? reply.code(404).send({ message: 'Extracteur introuvable' })
  })

  // A new version of the extractor of a supplier (the first one creates the supplier)
  app.post('/extracteurs', async (request, reply) => {
    const raw = body(request)
    try {
      const supplier = requiredText(raw.supplier, 'Fournisseur')
      const type = String(raw.type ?? 'invoice')
      if (type !== 'invoice' && type !== 'bank_statement') {
        throw new InputError('Type d\'extracteur : facture ou releve')
      }
      // A statement extractor has no energy
      const energy = type === 'bank_statement' ? null : String(raw.energy ?? '')
      if (energy !== null && !ENERGIES.includes(energy)) {
        throw new InputError('Énergie inconnue')
      }
      const engine = Number(raw.engine)
      if (!Number.isInteger(engine) || engine <= 0) {
        throw new InputError('Version du moteur manquante')
      }
      const values = [
        supplier, energy, JSON.stringify(readReglages(raw.settings)), requiredText(raw.source, 'Source'),
        requiredText(raw.code, 'Code'), engine, optionalText(raw.note), type,
      ]
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        await client.query('INSERT INTO supplier (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [supplier])
        // One new version at a time per supplier, of one type: a supplier has invoices or statements
        await client.query('SELECT id FROM supplier WHERE name = $1 FOR UPDATE', [supplier])
        const { rows: [autre] } = await client.query(
          `SELECT 1 FROM extractor e JOIN supplier fo ON fo.id = e.supplier_id WHERE fo.name = $1 AND e.type <> $2`,
          [supplier, type])
        if (autre) {
          throw new InputError(`${supplier} a déjà des extracteurs d'un autre type`)
        }
        const { rows: [created] } = await client.query<{ id: number }>(
          `INSERT INTO extractor (supplier_id, version, energy, settings, source, code, engine, note, type)
           SELECT fo.id, coalesce(max(e.version), 0) + 1, $2, $3, $4, $5, $6, $7, $8
           FROM supplier fo LEFT JOIN extractor e ON e.supplier_id = fo.id
           WHERE fo.name = $1 GROUP BY fo.id RETURNING id`,
          values,
        )
        await client.query('COMMIT')
        const { rows: [extractor] } = await db.query(
          `SELECT * FROM (SELECT ${COLUMNS} FROM extractor e JOIN supplier fo ON fo.id = e.supplier_id) x
           WHERE id = $1`,
          [created!.id],
        )
        return reply.code(201).send(extractor)
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    } catch (error) {
      return sendError(reply, error)
    }
  })
}

export default extracteurRoutes

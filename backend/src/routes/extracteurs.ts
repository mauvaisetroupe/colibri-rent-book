import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'

import { body, idParam, InputError, optionalText, requiredText, sendError } from '../http.js'

// Invoice extractors (ADR 0013): TypeScript code written in the « Extracteurs » screen and run in the browser only;
// the server stores them and never runs them. Versions are never changed nor deleted (trigger extracteur_fige):
// correcting an extractor creates the next version of its supplier.

const ENERGIES = ['gaz', 'electricite', 'eau', 'ordures_menageres', 'autre']

const COLUMNS = `e.id, fo.nom AS fournisseur, e.version, e.energie, e.reglages, e.source, e.code, e.moteur, e.note,
  e.cree_le, e.version = max(e.version) OVER (PARTITION BY e.fournisseur_id) AS derniere,
  (SELECT count(*)::int FROM facture f WHERE f.extracteur_id = e.id) AS nb_factures`

function readReglages(value: unknown) {
  const r = (value ?? {}) as Record<string, unknown>
  const reglages = { toleranceHauteur: Number(r.toleranceHauteur), collage: Number(r.collage), colonne: Number(r.colonne) }
  if (!Object.values(reglages).every((v) => Number.isFinite(v) && v >= 0)) {
    throw new InputError('Réglages du regroupement : toleranceHauteur, collage et colonne, nombres positifs')
  }
  return reglages
}

const extracteurRoutes: FastifyPluginAsync<{ db: Pool }> = async (app, { db }) => {
  // Every version, the last one of each supplier first
  app.get('/extracteurs', async () => {
    const { rows } = await db.query(
      `SELECT ${COLUMNS} FROM extracteur e JOIN fournisseur fo ON fo.id = e.fournisseur_id
       ORDER BY fo.nom, e.version DESC`,
    )
    return rows
  })

  // Invoices of a supplier that have a PDF, every building: the editor reads them again with a new version before it
  // is saved, and shows what changes (non-regression)
  app.get('/extracteurs/factures', async (request, reply) => {
    const fournisseur = String((request.query as { fournisseur?: string }).fournisseur ?? '')
    if (!fournisseur) {
      return reply.code(400).send({ message: 'Paramètre « fournisseur » manquant' })
    }
    const { rows } = await db.query(
      `SELECT f.id, f.numero, f.date_facture::text, f.montant_ttc::text, f.statut, f.extracteur_id, i.nom AS immeuble
       FROM facture f JOIN fournisseur fo ON fo.id = f.fournisseur_id JOIN immeuble i ON i.id = f.immeuble_id
       WHERE fo.nom = $1 AND f.fichier_pdf IS NOT NULL
       ORDER BY f.date_facture DESC NULLS LAST, f.id DESC`,
      [fournisseur],
    )
    return rows
  })

  app.get('/extracteurs/:id', async (request, reply) => {
    const { rows: [extracteur] } = await db.query(
      `SELECT * FROM (SELECT ${COLUMNS} FROM extracteur e JOIN fournisseur fo ON fo.id = e.fournisseur_id) x WHERE id = $1`,
      [idParam(request)],
    )
    return extracteur ?? reply.code(404).send({ message: 'Extracteur introuvable' })
  })

  // A new version of the extractor of a supplier (the first one creates the supplier)
  app.post('/extracteurs', async (request, reply) => {
    const raw = body(request)
    try {
      const fournisseur = requiredText(raw.fournisseur, 'Fournisseur')
      const energie = String(raw.energie ?? '')
      if (!ENERGIES.includes(energie)) {
        throw new InputError('Énergie inconnue')
      }
      const moteur = Number(raw.moteur)
      if (!Number.isInteger(moteur) || moteur <= 0) {
        throw new InputError('Version du moteur manquante')
      }
      const values = [
        fournisseur, energie, JSON.stringify(readReglages(raw.reglages)), requiredText(raw.source, 'Source'),
        requiredText(raw.code, 'Code'), moteur, optionalText(raw.note),
      ]
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        await client.query('INSERT INTO fournisseur (nom) VALUES ($1) ON CONFLICT (nom) DO NOTHING', [fournisseur])
        // One new version at a time per supplier
        await client.query('SELECT id FROM fournisseur WHERE nom = $1 FOR UPDATE', [fournisseur])
        const { rows: [created] } = await client.query<{ id: number }>(
          `INSERT INTO extracteur (fournisseur_id, version, energie, reglages, source, code, moteur, note)
           SELECT fo.id, coalesce(max(e.version), 0) + 1, $2, $3, $4, $5, $6, $7
           FROM fournisseur fo LEFT JOIN extracteur e ON e.fournisseur_id = fo.id
           WHERE fo.nom = $1 GROUP BY fo.id RETURNING id`,
          values,
        )
        await client.query('COMMIT')
        const { rows: [extracteur] } = await db.query(
          `SELECT * FROM (SELECT ${COLUMNS} FROM extracteur e JOIN fournisseur fo ON fo.id = e.fournisseur_id) x
           WHERE id = $1`,
          [created!.id],
        )
        return reply.code(201).send(extracteur)
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

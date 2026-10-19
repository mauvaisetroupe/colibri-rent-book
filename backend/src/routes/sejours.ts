import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'

import {
  body, idParam, InputError, optionalDate, optionalDecimal, optionalText, query, requiredDate, requiredDecimal, requiredId,
  requiredText, sendError,
} from '../http.js'
import { inclusiveBounds, inclusiveRange } from '../periods.js'

// Tenants, stays (a tenant in a lot over a period, entry and exit dates included, exit null while the stay goes on),
// rent and provision called each month (ADR 0009) and yearly provisions per stay (SPEC R9).

const SEJOUR_COLUMNS = `
  s.id, s.lot_id, lt.code AS lot, s.locataire_id, lo.nom AS locataire, ${inclusiveBounds('s.periode', 'entree', 'sortie')},
  s.note, s.depot_garantie::text,
  -- Deposit kept (ADR 0021): the retention, payments « depot » toward months or regularisations; null without any
  (SELECT sum(p.loyer + p.provision + p.regularisation)::text FROM paiement p
   WHERE p.sejour_id = s.id AND p.mode = 'depot') AS depot_retenu,
  -- Deposit held (ADR 0019, 0021): paid minus refunded minus kept; null without any deposit or retention recorded
  (SELECT sum(x)::text FROM (
     SELECT vd.montant AS x FROM versement_depot vd WHERE vd.sejour_id = s.id
     UNION ALL
     SELECT -(p.loyer + p.provision + p.regularisation) FROM paiement p WHERE p.sejour_id = s.id AND p.mode = 'depot') d
  ) AS depot_detenu`

const SEJOUR_FROM = 'sejour s JOIN lot lt ON lt.id = s.lot_id JOIN locataire lo ON lo.id = s.locataire_id'

function readSejour(raw: Record<string, unknown>) {
  const entree = requiredDate(raw.entree, 'Entrée')
  const sortie = optionalDate(raw.sortie, 'Sortie')
  if (sortie && sortie < entree) {
    throw new InputError('La sortie est avant l\'entrée')
  }
  return {
    lot_id: requiredId(raw.lot_id, 'Lot'),
    locataire_id: requiredId(raw.locataire_id, 'Locataire'),
    entree,
    sortie,
    note: optionalText(raw.note),
    depot_garantie: optionalDecimal(raw.depot_garantie, 'Dépôt de garantie'),
  }
}

const SEJOUR_ERRORS = {
  '23P01': 'Ce séjour chevauche un autre séjour du même lot',
  '23503': 'Ce séjour a des provisions, des paiements, des régularisations ou des versements de dépôt : suppression impossible',
}

function readEcheance(raw: Record<string, unknown>) {
  const e = {
    sejour_id: requiredId(raw.sejour_id, 'Séjour'),
    // A month ('AAAA-MM') or any day of it: the 1st of the month is stored
    a_partir_du: requiredDate(`${String(raw.a_partir_du ?? '').slice(0, 7)}-01`, 'À partir du'),
    loyer: requiredDecimal(raw.loyer, 'Loyer'),
    provision: requiredDecimal(raw.provision, 'Provision'),
    note: optionalText(raw.note),
  }
  if (e.loyer.startsWith('-') || e.provision.startsWith('-')) {
    throw new InputError('Le loyer et la provision ne peuvent pas être négatifs')
  }
  return e
}

const ECHEANCE_ERRORS = {
  23505: 'Ce séjour a déjà un loyer appelé à partir de ce mois',
  23503: 'Séjour inconnu',
}

function readProvision(raw: Record<string, unknown>) {
  const annee = Number(raw.annee)
  if (!Number.isInteger(annee) || annee < 2000 || annee > 2100) {
    throw new InputError('Année invalide')
  }
  return {
    sejour_id: requiredId(raw.sejour_id, 'Séjour'),
    annee,
    montant: requiredDecimal(raw.montant, 'Montant'),
    note: optionalText(raw.note),
  }
}

const sejourRoutes: FastifyPluginAsync<{ db: Pool }> = async (app, { db }) => {
  // ---------------------------------------------------------------- tenants

  app.get('/locataires', async () => {
    const { rows } = await db.query(
      `SELECT lo.id, lo.nom, lo.email, lo.telephone, lo.note, count(s.id)::int AS nb_sejours
       FROM locataire lo LEFT JOIN sejour s ON s.locataire_id = lo.id
       GROUP BY lo.id ORDER BY lo.nom`,
    )
    return rows
  })

  const saveLocataire = (id: number | null, raw: Record<string, unknown>) => {
    const values = [
      requiredText(raw.nom, 'Nom'), optionalText(raw.email), optionalText(raw.telephone), optionalText(raw.note),
    ]
    return id === null
      ? db.query(
        'INSERT INTO locataire (nom, email, telephone, note) VALUES ($1, $2, $3, $4) RETURNING *',
        values,
      )
      : db.query(
        'UPDATE locataire SET nom = $2, email = $3, telephone = $4, note = $5 WHERE id = $1 RETURNING *',
        [id, ...values],
      )
  }

  app.post('/locataires', async (request, reply) => {
    try {
      const { rows: [created] } = await saveLocataire(null, body(request))
      return reply.code(201).send(created)
    } catch (error) {
      return sendError(reply, error, { 23505: 'Un locataire porte déjà ce nom' })
    }
  })

  app.put('/locataires/:id', async (request, reply) => {
    try {
      const { rows: [updated] } = await saveLocataire(idParam(request), body(request))
      return updated ?? reply.code(404).send({ message: 'Locataire introuvable' })
    } catch (error) {
      return sendError(reply, error, { 23505: 'Un locataire porte déjà ce nom' })
    }
  })

  app.delete('/locataires/:id', async (request, reply) => {
    try {
      const { rowCount } = await db.query('DELETE FROM locataire WHERE id = $1', [idParam(request)])
      return rowCount ? reply.code(204).send() : reply.code(404).send({ message: 'Locataire introuvable' })
    } catch (error) {
      return sendError(reply, error, { 23503: 'Ce locataire a des séjours : suppression impossible' })
    }
  })

  // ---------------------------------------------------------------- stays

  app.get('/sejours', async (request, reply) => {
    try {
      const immeuble = requiredId(query(request).immeuble, 'Immeuble')
      const { rows } = await db.query(
        `SELECT ${SEJOUR_COLUMNS} FROM ${SEJOUR_FROM} WHERE lt.immeuble_id = $1 ORDER BY lt.code, lower(s.periode)`,
        [immeuble],
      )
      return rows
    } catch (error) {
      return sendError(reply, error)
    }
  })

  const loadSejour = async (id: number) =>
    (await db.query(`SELECT ${SEJOUR_COLUMNS} FROM ${SEJOUR_FROM} WHERE s.id = $1`, [id])).rows[0]

  app.post('/sejours', async (request, reply) => {
    try {
      const s = readSejour(body(request))
      const { rows: [created] } = await db.query<{ id: number }>(
        `INSERT INTO sejour (lot_id, locataire_id, periode, note, depot_garantie)
         VALUES ($1, $2, ${inclusiveRange('$3', '$4')}, $5, $6) RETURNING id`,
        [s.lot_id, s.locataire_id, s.entree, s.sortie, s.note, s.depot_garantie],
      )
      return reply.code(201).send(await loadSejour(created!.id))
    } catch (error) {
      return sendError(reply, error, SEJOUR_ERRORS)
    }
  })

  app.put('/sejours/:id', async (request, reply) => {
    try {
      const s = readSejour(body(request))
      const { rowCount } = await db.query(
        `UPDATE sejour SET lot_id = $2, locataire_id = $3, periode = ${inclusiveRange('$4', '$5')}, note = $6,
           depot_garantie = $7
         WHERE id = $1`,
        [idParam(request), s.lot_id, s.locataire_id, s.entree, s.sortie, s.note, s.depot_garantie],
      )
      return rowCount ? loadSejour(idParam(request)) : reply.code(404).send({ message: 'Séjour introuvable' })
    } catch (error) {
      return sendError(reply, error, SEJOUR_ERRORS)
    }
  })

  app.delete('/sejours/:id', async (request, reply) => {
    try {
      const { rowCount } = await db.query('DELETE FROM sejour WHERE id = $1', [idParam(request)])
      return rowCount ? reply.code(204).send() : reply.code(404).send({ message: 'Séjour introuvable' })
    } catch (error) {
      return sendError(reply, error, SEJOUR_ERRORS)
    }
  })

  // ---------------------------------------------------------------- rent and provision called (ADR 0009)

  // History of the amounts called each month, per stay: a row applies from its month until the next row of the stay
  app.get('/echeances', async (request, reply) => {
    try {
      const immeuble = requiredId(query(request).immeuble, 'Immeuble')
      const { rows } = await db.query(
        `SELECT e.id, e.sejour_id, e.a_partir_du::text, e.loyer::text, e.provision::text, e.note
         FROM echeance e JOIN sejour s ON s.id = e.sejour_id JOIN lot lt ON lt.id = s.lot_id
         WHERE lt.immeuble_id = $1 ORDER BY e.sejour_id, e.a_partir_du`,
        [immeuble],
      )
      return rows
    } catch (error) {
      return sendError(reply, error)
    }
  })

  const ECHEANCE_COLUMNS = 'id, sejour_id, a_partir_du::text, loyer::text, provision::text, note'

  app.post('/echeances', async (request, reply) => {
    try {
      const e = readEcheance(body(request))
      const { rows: [created] } = await db.query(
        `INSERT INTO echeance (sejour_id, a_partir_du, loyer, provision, note) VALUES ($1, $2, $3, $4, $5)
         RETURNING ${ECHEANCE_COLUMNS}`,
        [e.sejour_id, e.a_partir_du, e.loyer, e.provision, e.note],
      )
      return reply.code(201).send(created)
    } catch (error) {
      return sendError(reply, error, ECHEANCE_ERRORS)
    }
  })

  app.put('/echeances/:id', async (request, reply) => {
    try {
      const e = readEcheance(body(request))
      const { rows: [updated] } = await db.query(
        `UPDATE echeance SET sejour_id = $2, a_partir_du = $3, loyer = $4, provision = $5, note = $6 WHERE id = $1
         RETURNING ${ECHEANCE_COLUMNS}`,
        [idParam(request), e.sejour_id, e.a_partir_du, e.loyer, e.provision, e.note],
      )
      return updated ?? reply.code(404).send({ message: 'Loyer appelé introuvable' })
    } catch (error) {
      return sendError(reply, error, ECHEANCE_ERRORS)
    }
  })

  app.delete('/echeances/:id', async (request, reply) => {
    const { rowCount } = await db.query('DELETE FROM echeance WHERE id = $1', [idParam(request)])
    return rowCount ? reply.code(204).send() : reply.code(404).send({ message: 'Loyer appelé introuvable' })
  })

  // ---------------------------------------------------------------- provisions (per stay and calendar year)

  // Provisions per stay and year as used by the statement (view v_provision): from the monthly payments when the year
  // has any (source « paiements »), otherwise the yearly total entered by hand (source « saisie », id to edit it)
  app.get('/provisions', async (request, reply) => {
    try {
      const immeuble = requiredId(query(request).immeuble, 'Immeuble')
      const { rows } = await db.query(
        `SELECT pa.id, v.sejour_id, v.annee, v.montant::text, v.source, pa.note, lo.nom AS locataire, lt.code AS lot
         FROM v_provision v
         LEFT JOIN provision_annuelle pa ON pa.sejour_id = v.sejour_id AND pa.annee = v.annee AND v.source = 'saisie'
         JOIN sejour s ON s.id = v.sejour_id
         JOIN lot lt ON lt.id = s.lot_id
         JOIN locataire lo ON lo.id = s.locataire_id
         WHERE lt.immeuble_id = $1 ORDER BY v.annee DESC, lt.code, lower(s.periode)`,
        [immeuble],
      )
      return rows
    } catch (error) {
      return sendError(reply, error)
    }
  })

  // One amount per stay and year: saving again replaces it
  app.put('/provisions', async (request, reply) => {
    try {
      const p = readProvision(body(request))
      const { rowCount: payes } = await db.query(
        'SELECT 1 FROM paiement WHERE sejour_id = $1 AND extract(year FROM mois) = $2',
        [p.sejour_id, p.annee],
      )
      if (payes) {
        return reply.code(409).send({ message: `Les provisions ${p.annee} viennent des paiements mensuels saisis` })
      }
      const { rows: [saved] } = await db.query(
        `INSERT INTO provision_annuelle (sejour_id, annee, montant, note) VALUES ($1, $2, $3, $4)
         ON CONFLICT (sejour_id, annee) DO UPDATE SET montant = excluded.montant, note = excluded.note
         RETURNING id, sejour_id, annee, montant::text, note`,
        [p.sejour_id, p.annee, p.montant, p.note],
      )
      return saved
    } catch (error) {
      return sendError(reply, error, { 23503: 'Séjour inconnu' })
    }
  })

  app.delete('/provisions/:id', async (request, reply) => {
    const { rowCount } = await db.query('DELETE FROM provision_annuelle WHERE id = $1', [idParam(request)])
    return rowCount ? reply.code(204).send() : reply.code(404).send({ message: 'Provision introuvable' })
  })
}

export default sejourRoutes

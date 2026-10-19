import Big from 'big.js'
import type { FastifyPluginAsync } from 'fastify'
import type { Pool, PoolClient } from 'pg'

import { categoriserSiVide, verifierMouvement } from '../couverture.js'
import {
  body, idParam, InputError, optionalDecimal, optionalText, query, requiredDate, requiredId, sendError,
} from '../http.js'

// Payments received from tenants (ADR 0008): rent and provision of a month, and/or an amount toward a
// regularisation (negative: refund). The provisions of a year come from these payments (view v_provision) as soon as
// the year has one; a regularisation is settled when its payments (corrective chain included) reach its balance
// (computed, ADR 0010). A retention on the deposit (mode « depot », ADR 0021) is a payment too, but made and changed only
// from the deposit of the stay (PUT /sejours/:id/retenue): refused here.

const MODES = ['virement', 'prelevement', 'cheque', 'especes', 'autre']
export const RETENUE = 'Retenue sur le dépôt de garantie : à modifier depuis le dépôt du séjour (écran Locataires)'

/** A retention on the deposit is changed from the deposit of the stay only. */
async function refuserRetenue(db: Pool, id: number) {
  const { rows: [p] } = await db.query<{ mode: string | null }>('SELECT mode FROM paiement WHERE id = $1', [id])
  if (p?.mode === 'depot') {
    throw new InputError(RETENUE)
  }
}

const COLUMNS = `
  p.id, p.sejour_id, lo.nom AS locataire, lt.code AS lot, p.date_paiement::text, p.mois::text,
  p.loyer::text, p.provision::text, p.regularisation_id, p.regularisation::text, p.mode, p.note, p.mouvement_id`

const FROM = `paiement p
  JOIN sejour s ON s.id = p.sejour_id
  JOIN lot lt ON lt.id = s.lot_id
  JOIN locataire lo ON lo.id = s.locataire_id`

type Saisie = {
  sejour_id: number
  date_paiement: string
  mois: string | null
  loyer: string
  provision: string
  regularisation_id: number | null
  regularisation: string
  mode: string | null
  note: string | null
  mouvement_id: number | null
}

function readPaiement(raw: Record<string, unknown>): Saisie {
  const mois = raw.mois ? requiredDate(`${String(raw.mois).slice(0, 7)}-01`, 'Mois') : null
  const mode = optionalText(raw.mode)
  if (mode === 'depot') {
    throw new InputError(RETENUE)
  }
  if (mode && !MODES.includes(mode)) {
    throw new InputError(`Mode de paiement inconnu : ${mode}`)
  }
  const p: Saisie = {
    sejour_id: requiredId(raw.sejour_id, 'Séjour'),
    date_paiement: requiredDate(raw.date_paiement, 'Date du paiement'),
    mois,
    loyer: optionalDecimal(raw.loyer, 'Loyer') ?? '0',
    provision: optionalDecimal(raw.provision, 'Provision') ?? '0',
    regularisation_id: raw.regularisation_id ? requiredId(raw.regularisation_id, 'Régularisation') : null,
    regularisation: optionalDecimal(raw.regularisation, 'Versement de régularisation') ?? '0',
    mode,
    note: optionalText(raw.note),
    mouvement_id: raw.mouvement_id ? requiredId(raw.mouvement_id, 'Mouvement') : null,
  }
  if (!mois && (Number(p.loyer) !== 0 || Number(p.provision) !== 0)) {
    throw new InputError('Indiquer le mois du loyer et de la provision')
  }
  if (!p.regularisation_id && Number(p.regularisation) !== 0) {
    throw new InputError('Choisir la régularisation concernée par ce versement')
  }
  if (p.regularisation_id && Number(p.regularisation) === 0) {
    throw new InputError('Régularisation choisie sans versement : indiquer le montant, ou choisir « Aucune »')
  }
  // Amount received (bank statement), when given: the split must add up to it
  const montant = optionalDecimal(raw.montant, 'Montant reçu')
  if (montant !== null) {
    const reparti = new Big(p.loyer).plus(p.provision).plus(p.regularisation)
    if (!reparti.eq(montant)) {
      throw new InputError(`Loyer + provision + régularisation (${reparti.toFixed(2)}) ne retombent pas sur le montant `
        + `reçu (${new Big(montant).toFixed(2)})`)
    }
  }
  return p
}

/** A payment toward a regularisation must target the current (not replaced), sent regularisation of the stay. */
async function checkRegularisation(db: Pool | PoolClient, p: Saisie) {
  if (!p.regularisation_id) {
    return
  }
  const { rows: [r] } = await db.query<{ sejour_id: number, envoyee: boolean, remplacee: boolean }>(
    `SELECT r.sejour_id, r.date_envoi IS NOT NULL AS envoyee, EXISTS (SELECT 1 FROM regularisation n WHERE n.remplace_id = r.id) AS remplacee
     FROM regularisation r WHERE r.id = $1`,
    [p.regularisation_id],
  )
  if (!r || r.sejour_id !== p.sejour_id) {
    throw new InputError('Cette régularisation ne concerne pas ce séjour')
  }
  if (r.remplacee) {
    throw new InputError('Cette régularisation a été rectifiée : enregistrer le versement sur le rectificatif')
  }
  if (!r.envoyee) {
    throw new InputError('Régularisation pas encore envoyée')
  }
}

/**
 * A payment seen on a bank statement (ADR 0018): a payment received on a credit, a refund (negative) on a debit; the
 * detail linked does not exceed the amount (a transfer may pay two months: two payments). The movement must be of the
 * category « locataire », or have none yet.
 */
async function checkMouvement(db: Pool | PoolClient, p: Saisie, id: number | null) {
  if (!p.mouvement_id) {
    return
  }
  const paiement = new Big(p.loyer).plus(p.provision).plus(p.regularisation)
  if (paiement.eq(0)) {
    throw new InputError('Un paiement nul ne se rattache pas à un mouvement')
  }
  await verifierMouvement(db, p.mouvement_id, {
    categories: ['locataire'], signe: paiement.gt(0) ? 1 : -1, montant: paiement, detail: 'paiement', exclure: id,
  })
}

/** A payment linked to a movement without category: it becomes « locataire ». */
const categoriserMouvement = (db: Pool, p: Saisie) => categoriserSiVide(db, p.mouvement_id, 'locataire')

const paiementRoutes: FastifyPluginAsync<{ db: Pool }> = async (app, { db }) => {
  const load = async (id: number) => (await db.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE p.id = $1`, [id])).rows[0]

  // Payments of a calendar year: rent months of the year, and regularisation payments received during it; without
  // « annee », every payment of the building.
  // With « regularisation »: the payments toward it, any year, previous regularisations of its corrective chain included.
  app.get('/paiements', async (request, reply) => {
    try {
      const q = query(request)
      const immeuble = requiredId(q.immeuble, 'Immeuble')
      if (q.regularisation !== undefined) {
        const { rows } = await db.query(
          `WITH RECURSIVE chaine AS (
             SELECT id, remplace_id FROM regularisation WHERE id = $2
             UNION ALL
             SELECT r.id, r.remplace_id FROM regularisation r JOIN chaine c ON r.id = c.remplace_id
           )
           SELECT ${COLUMNS} FROM ${FROM}
           WHERE lt.immeuble_id = $1 AND p.regularisation_id IN (SELECT id FROM chaine)
           ORDER BY p.date_paiement, p.id`,
          [immeuble, requiredId(q.regularisation, 'Régularisation')],
        )
        return rows
      }
      const annee = q.annee ? Number(q.annee) : null
      if (annee !== null && !Number.isInteger(annee)) {
        throw new InputError('Année invalide')
      }
      const { rows } = await db.query(
        `SELECT ${COLUMNS} FROM ${FROM}
         WHERE lt.immeuble_id = $1
           AND ($2::int IS NULL OR extract(year FROM p.mois) = $2
                OR (p.mois IS NULL AND extract(year FROM p.date_paiement) = $2))
         ORDER BY p.date_paiement, p.id`,
        [immeuble, annee],
      )
      return rows
    } catch (error) {
      return sendError(reply, error)
    }
  })

  /**
   * Monthly entry: the stays present during the month, whether they already paid it, and the amounts of their last
   * paid month as a suggestion.
   */
  app.get('/paiements/mois', async (request, reply) => {
    try {
      const q = query(request)
      const immeuble = requiredId(q.immeuble, 'Immeuble')
      const mois = requiredDate(`${String(q.mois ?? '').slice(0, 7)}-01`, 'Mois')
      const { rows } = await db.query(
        `SELECT s.id AS sejour_id, lo.nom AS locataire, lt.code AS lot,
                (SELECT json_agg(json_build_object('id', p.id, 'loyer', p.loyer::text, 'provision', p.provision::text,
                   'date_paiement', p.date_paiement::text, 'mode', p.mode) ORDER BY p.date_paiement)
                 FROM paiement p WHERE p.sejour_id = s.id AND p.mois = $2) AS paiements,
                (SELECT json_build_object('loyer', p.loyer::text, 'provision', p.provision::text, 'mode', p.mode)
                 FROM paiement p WHERE p.sejour_id = s.id AND p.mois < $2 ORDER BY p.mois DESC, p.id DESC LIMIT 1)
                  AS precedent
         FROM sejour s JOIN lot lt ON lt.id = s.lot_id JOIN locataire lo ON lo.id = s.locataire_id
         WHERE lt.immeuble_id = $1 AND s.periode && daterange($2, ($2 + interval '1 month')::date)
         ORDER BY lt.code, lower(s.periode)`,
        [immeuble, mois],
      )
      return rows
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/paiements', async (request, reply) => {
    try {
      const p = readPaiement(body(request))
      await checkRegularisation(db, p)
      await checkMouvement(db, p, null)
      const { rows: [created] } = await db.query<{ id: number }>(
        `INSERT INTO paiement (sejour_id, date_paiement, mois, loyer, provision, regularisation_id, regularisation, mode, note,
                               mouvement_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [p.sejour_id, p.date_paiement, p.mois, p.loyer, p.provision, p.regularisation_id, p.regularisation, p.mode, p.note,
          p.mouvement_id],
      )
      await categoriserMouvement(db, p)
      return reply.code(201).send(await load(created!.id))
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.put('/paiements/:id', async (request, reply) => {
    try {
      const id = idParam(request)
      await refuserRetenue(db, id)
      const raw = body(request)
      const p = readPaiement(raw)
      // Without « mouvement_id », a change keeps the link to the bank movement (Paiements screen)
      const garderLien = !('mouvement_id' in raw)
      if (garderLien) {
        p.mouvement_id = (await db.query<{ mouvement_id: number | null }>(
          'SELECT mouvement_id FROM paiement WHERE id = $1', [id])).rows[0]?.mouvement_id ?? null
      }
      await checkRegularisation(db, p)
      await checkMouvement(db, p, id)
      const { rows: [before] } = await db.query<{ regularisation_id: number | null }>(
        'SELECT regularisation_id FROM paiement WHERE id = $1',
        [id],
      )
      if (!before) {
        return reply.code(404).send({ message: 'Paiement introuvable' })
      }
      await db.query(
        `UPDATE paiement SET sejour_id = $2, date_paiement = $3, mois = $4, loyer = $5, provision = $6,
           regularisation_id = $7, regularisation = $8, mode = $9, note = $10, mouvement_id = $11 WHERE id = $1`,
        [id, p.sejour_id, p.date_paiement, p.mois, p.loyer, p.provision, p.regularisation_id, p.regularisation, p.mode, p.note,
          p.mouvement_id],
      )
      await categoriserMouvement(db, p)
      return load(id)
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.delete('/paiements/:id', async (request, reply) => {
    try {
      await refuserRetenue(db, idParam(request))
      const { rows: [deleted] } = await db.query<{ regularisation_id: number | null }>(
        'DELETE FROM paiement WHERE id = $1 RETURNING regularisation_id',
        [idParam(request)],
      )
      if (!deleted) {
        return reply.code(404).send({ message: 'Paiement introuvable' })
      }
      return reply.code(204).send()
    } catch (error) {
      return sendError(reply, error)
    }
  })
}

export default paiementRoutes

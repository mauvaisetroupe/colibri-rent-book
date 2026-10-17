import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import Big from 'big.js'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import type { Pool } from 'pg'

import { euros, frenchDate } from '../format.js'
import {
  body, exercise, idParam, InputError, optionalDecimal, optionalText, query, requiredDate, requiredDecimal, requiredId,
  sendError,
} from '../http.js'
import { buildJustificatif, SejourHorsExercice, type Justificatif } from '../justificatif.js'
import { justificatifPdf, type Annexe, type Entete } from '../justificatifPdf.js'
import { mailRectificatif, mailRegularisation, suggestionProvision, type MailOptions, type RegulMail } from '../mails.js'
import { inclusiveBounds, inclusiveRange } from '../periods.js'

// Regularisations (ADR 0007): created from the statement of an exercise, they freeze what is sent (instantane); a
// corrective one replaces the previous (remplace_id). A regularisation sent outside the application can be entered
// by hand, to prepare its corrective mail. Its state (draft, waiting, settled) is computed from the sending date and
// the payments; the owner only records a decision: charge given up, unrecoverable (ADR 0010).

const COLUMNS = `
  r.id, r.sejour_id, lo.nom AS locataire, lo.email, lt.code AS lot, lt.immeuble_id,
  ${inclusiveBounds('r.exercice')}, r.montant_du::text, r.provisions::text, r.solde::text,
  regularisation_etat(r.id) AS etat, r.decision, r.date_envoi::text, regularisation_verse(r.id)::text AS montant_recu,
  regularisation_date_solde(r.id)::text AS date_solde, r.remplace_id,
  (SELECT n.id FROM regularisation n WHERE n.remplace_id = r.id) AS remplacee_par,
  r.instantane IS NOT NULL AS justificatif, r.note, r.cree_le`

const FROM = `regularisation r
  JOIN sejour s ON s.id = r.sejour_id
  JOIN lot lt ON lt.id = s.lot_id
  JOIN locataire lo ON lo.id = s.locataire_id`

type Regularisation = {
  id: number
  sejour_id: number
  locataire: string
  email: string | null
  lot: string
  immeuble_id: number
  debut: string
  fin: string
  montant_du: string
  provisions: string
  solde: string
  etat: 'brouillon' | 'en_attente' | 'soldee'
  decision: 'abandonnee' | 'irrecouvrable' | null
  date_envoi: string | null
  // Payments received, corrective chain included (ADR 0008)
  montant_recu: string
  date_solde: string | null
  remplace_id: number | null
  remplacee_par: number | null
  justificatif: boolean
  note: string | null
}

// From this gap on between a regularisation entered by hand and the statement recomputed today, its rebuilt supporting
// document is marked as not matching what was sent (same threshold as « à rectifier », frontend/src/rectification.ts)
const SEUIL_RECTIFICATION = new Big('5')

const cents = (value: string) => new Big(value).round(2, Big.roundHalfUp).toFixed(2)

const nextMonth = () => {
  const now = new Date()
  return new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 1)).toISOString().slice(0, 10)
}

const regularisationRoutes: FastifyPluginAsync<{ db: Pool, storageDir: string }> = async (app, { db, storageDir }) => {
  async function load(id: number) {
    const { rows: [r] } = await db.query<Regularisation & { instantane: Justificatif | null }>(
      `SELECT ${COLUMNS}, r.instantane FROM ${FROM} WHERE r.id = $1`,
      [id],
    )
    return r ?? null
  }

  /** The PDFs of the invoices of a supporting document, but those of a confidential supplier (ADR 0014). */
  async function annexes(j: Justificatif): Promise<Annexe[]> {
    const { rows } = await db.query<{ id: number, fichier_pdf: string | null, confidentiel: boolean }>(
      `SELECT f.id, f.fichier_pdf, fo.confidentiel FROM facture f JOIN fournisseur fo ON fo.id = f.fournisseur_id
       WHERE f.id = ANY($1)`,
      [j.factures.map((f) => f.facture_id)],
    )
    return Promise.all(rows.map(async (f): Promise<Annexe> => {
      if (f.confidentiel) {
        return { facture_id: f.id, pdf: null, raison: 'confidentiel' }
      }
      if (!f.fichier_pdf) {
        return { facture_id: f.id, pdf: null, raison: 'sans_pdf' }
      }
      const pdf = await readFile(join(storageDir, f.fichier_pdf)).catch(() => null)
      return { facture_id: f.id, pdf, raison: pdf ? null : 'sans_pdf' }
    }))
  }

  const pdf = async (reply: FastifyReply, j: Justificatif, entete: Entete, nom: string) => reply
    .type('application/pdf')
    .header('content-disposition', `inline; filename="${nom}.pdf"`)
    .send(await justificatifPdf(j, entete, await annexes(j)))

  /** Statement row of a stay frozen into a new regularisation (draft). */
  async function create(sejourId: number, debut: string, fin: string, remplace: number | null) {
    const { rows: [sejour] } = await db.query<{ immeuble_id: number }>(
      'SELECT lt.immeuble_id FROM sejour s JOIN lot lt ON lt.id = s.lot_id WHERE s.id = $1',
      [sejourId],
    )
    if (!sejour) {
      throw new InputError('Séjour inconnu')
    }
    const j = await buildJustificatif(db, { immeuble: sejour.immeuble_id, debut, fin }, sejourId)
    const { rows: [created] } = await db.query<{ id: number }>(
      `INSERT INTO regularisation (sejour_id, exercice, montant_du, provisions, remplace_id, instantane)
       VALUES ($1, ${inclusiveRange('$2', '$3')}, $4, $5, $6, $7) RETURNING id`,
      [sejourId, debut, fin, cents(j.total), cents(j.provisions), remplace, JSON.stringify(j)],
    )
    return load(created!.id)
  }

  /** The current (not replaced) regularisation of a stay for an exercise, if any. */
  async function current(sejourId: number, debut: string, fin: string) {
    const { rows: [r] } = await db.query<{ id: number }>(
      `SELECT r.id FROM regularisation r
       WHERE r.sejour_id = $1 AND r.exercice = ${inclusiveRange('$2', '$3')}
         AND NOT EXISTS (SELECT 1 FROM regularisation n WHERE n.remplace_id = r.id)`,
      [sejourId, debut, fin],
    )
    return r?.id ?? null
  }

  const handle = (reply: FastifyReply, error: unknown) =>
    (error instanceof SejourHorsExercice ? reply.code(400).send({ message: error.message }) : sendError(reply, error))

  app.get('/regularisations', async (request, reply) => {
    try {
      const immeuble = requiredId(query(request).immeuble, 'Immeuble')
      const { rows } = await db.query<Regularisation>(
        `SELECT ${COLUMNS} FROM ${FROM} WHERE lt.immeuble_id = $1 ORDER BY lower(r.exercice) DESC, lt.code, r.id`,
        [immeuble],
      )
      return rows
    } catch (error) {
      return handle(reply, error)
    }
  })

  app.get('/regularisations/:id', async (request, reply) => {
    const r = await load(idParam(request))
    if (!r) {
      return reply.code(404).send({ message: 'Régularisation introuvable' })
    }
    const { instantane, ...rest } = r
    return {
      ...rest,
      instantane,
      suggestion: {
        provision_mensuelle: instantane ? suggestionProvision(instantane.total, instantane.sejour.jours) : null,
        provision_a_partir_du: nextMonth(),
      },
    }
  })

  // From the statement: the amounts are frozen at this moment
  app.post('/regularisations', async (request, reply) => {
    try {
      const b = body(request)
      const sejourId = requiredId(b.sejour_id, 'Séjour')
      const debut = requiredDate(b.debut, 'Début')
      const fin = requiredDate(b.fin, 'Fin')
      const existing = await current(sejourId, debut, fin)
      if (existing) {
        return reply.code(409).send({
          message: 'Une régularisation existe déjà pour ce séjour et cette période : faire un rectificatif',
          regularisation_id: existing,
        })
      }
      return reply.code(201).send(await create(sejourId, debut, fin, null))
    } catch (error) {
      return handle(reply, error)
    }
  })

  // Regularisation already sent outside the application (SPEC § 11): what was asked, as sent
  app.post('/regularisations/manuelle', async (request, reply) => {
    try {
      const b = body(request)
      const sejourId = requiredId(b.sejour_id, 'Séjour')
      const debut = requiredDate(b.debut, 'Début')
      const fin = requiredDate(b.fin, 'Fin')
      const solde = requiredDecimal(b.solde, 'Montant demandé')
      const provisions = optionalDecimal(b.provisions, 'Provisions') ?? '0'
      const existing = await current(sejourId, debut, fin)
      if (existing) {
        return reply.code(409).send({ message: 'Une régularisation existe déjà pour ce séjour et cette période',
          regularisation_id: existing })
      }
      const dateEnvoi = requiredDate(b.date_envoi, 'Date d\'envoi')
      const recu = optionalDecimal(b.montant_recu, 'Montant reçu')
      const { rows: [created] } = await db.query<{ id: number }>(
        `INSERT INTO regularisation (sejour_id, exercice, montant_du, provisions, date_envoi, note)
         VALUES ($1, ${inclusiveRange('$2', '$3')}, $4, $5, $6, $7) RETURNING id`,
        [sejourId, debut, fin, new Big(solde).plus(provisions).toString(), provisions, dateEnvoi, optionalText(b.note)],
      )
      // What was already received becomes a payment (date unknown: the sending date)
      if (recu && Number(recu) !== 0) {
        await db.query(
          `INSERT INTO paiement (sejour_id, date_paiement, regularisation_id, regularisation, note)
           VALUES ($1, $2, $3, $4, 'Montant reçu indiqué à la saisie')`,
          [sejourId, dateEnvoi, created!.id, recu],
        )
      }
      return reply.code(201).send(await load(created!.id))
    } catch (error) {
      return handle(reply, error)
    }
  })

  // Corrective: the statement as it is now, replacing the previous regularisation
  app.post('/regularisations/:id/rectificatif', async (request, reply) => {
    try {
      const previous = await load(idParam(request))
      if (!previous) {
        return reply.code(404).send({ message: 'Régularisation introuvable' })
      }
      if (previous.remplacee_par) {
        return reply.code(409).send({ message: 'Cette régularisation a déjà un rectificatif',
          regularisation_id: previous.remplacee_par })
      }
      if (previous.etat === 'brouillon') {
        return reply.code(409).send({ message: 'Brouillon jamais envoyé : le supprimer et en créer un nouveau' })
      }
      return reply.code(201).send(await create(previous.sejour_id, previous.debut, previous.fin, previous.id))
    } catch (error) {
      return handle(reply, error)
    }
  })

  app.post('/regularisations/:id/envoi', async (request, reply) => {
    try {
      const date = requiredDate(body(request).date_envoi, 'Date d\'envoi')
      const { rowCount } = await db.query(
        'UPDATE regularisation SET date_envoi = $2 WHERE id = $1 AND date_envoi IS NULL',
        [idParam(request), date],
      )
      return rowCount ? load(idParam(request)) : reply.code(409).send({ message: 'Seul un brouillon peut être marqué envoyé' })
    } catch (error) {
      return handle(reply, error)
    }
  })

  // « Marquer envoyée » done by mistake: back to a draft, while nothing depends on the sending (no payment toward it,
  // no decision, not corrected)
  app.delete('/regularisations/:id/envoi', async (request, reply) => {
    const id = idParam(request)
    const r = await load(id)
    if (!r) {
      return reply.code(404).send({ message: 'Régularisation introuvable' })
    }
    const { rowCount: paiements } = await db.query('SELECT 1 FROM paiement WHERE regularisation_id = $1 LIMIT 1', [id])
    const refus = !r.date_envoi ? 'Pas encore envoyée'
      : r.remplacee_par ? 'Déjà rectifiée : l\'envoi ne peut plus être annulé'
        : r.decision ? 'Une décision est prise (abandon, irrécouvrable) : l\'annuler d\'abord'
          : paiements ? 'Des versements y sont rattachés : les supprimer d\'abord (écran Paiements)'
            : null
    if (refus) {
      return reply.code(409).send({ message: refus })
    }
    await db.query('UPDATE regularisation SET date_envoi = NULL WHERE id = $1', [id])
    return load(id)
  })

  // The only thing set by hand (ADR 0010): what remains is given up (charge « offerte ») or unrecoverable; null
  // withdraws the decision
  app.post('/regularisations/:id/decision', async (request, reply) => {
    try {
      const raw = body(request).decision
      const decision = raw === null || raw === undefined || raw === '' ? null : String(raw)
      if (decision !== null && !['abandonnee', 'irrecouvrable'].includes(decision)) {
        throw new InputError('Décision possible : abandonnée, irrécouvrable, ou aucune')
      }
      const { rowCount } = await db.query(
        `UPDATE regularisation r SET decision = $2::decision_regul
         WHERE r.id = $1 AND r.date_envoi IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM regularisation n WHERE n.remplace_id = r.id)`,
        [idParam(request), decision],
      )
      if (!rowCount) {
        return reply.code(409).send({ message: 'Décision possible seulement sur une régularisation envoyée et en cours' })
      }
      return load(idParam(request))
    } catch (error) {
      return handle(reply, error)
    }
  })

  app.delete('/regularisations/:id', async (request, reply) => {
    const { rowCount } = await db.query(
      `DELETE FROM regularisation r WHERE r.id = $1 AND r.date_envoi IS NULL
         AND NOT EXISTS (SELECT 1 FROM regularisation n WHERE n.remplace_id = r.id)`,
      [idParam(request)],
    )
    return rowCount ? reply.code(204).send() : reply.code(409).send({ message: 'Seul un brouillon peut être supprimé' })
  })

  // Supporting PDF as frozen in the regularisation. Entered by hand (sent outside the application, nothing frozen):
  // rebuilt from today's statement of its period, saying so and comparing with the amount sent.
  app.get('/regularisations/:id/justificatif', async (request, reply) => {
    const r = await load(idParam(request))
    if (!r) {
      return reply.code(404).send({ message: 'Régularisation introuvable' })
    }
    if (!r.instantane) {
      try {
        const j = await buildJustificatif(db, { immeuble: r.immeuble_id, debut: r.debut, fin: r.fin }, r.sejour_id)
        const recalcule = new Big(j.solde).round(2, Big.roundHalfUp)
        const ecart = recalcule.minus(r.solde)
        const envoi = r.date_envoi ? ` le ${frenchDate(r.date_envoi)}` : ''
        const entete: Entete = ecart.abs().lt(SEUIL_RECTIFICATION)
          ? {
            titre: 'Justificatif reconstitué',
            remarque: `Régularisation envoyée${envoi} pour un solde de ${euros(r.solde)} ; recalculée par `
              + `l'application : ${euros(recalcule.toString())}`
              + (ecart.eq(0) ? '.' : ` (écart d'arrondi de ${euros(ecart.toString())}).`),
          }
          : {
            titre: 'Justificatif reconstitué',
            alerte: `Ce calcul diffère de ${euros(ecart.abs().toString())} du montant envoyé${envoi} `
              + `(${euros(r.solde)}) : il ne correspond pas à ce que le locataire a reçu. Voir le rectificatif.`,
          }
        return pdf(reply, j, entete, `reconstitue-${r.lot}-${r.debut}-${r.fin}`.replace(/\s+/g, '-'))
      } catch (error) {
        return handle(reply, error)
      }
    }
    const previous = r.remplace_id ? await load(r.remplace_id) : null
    const entete: Entete = previous
      ? {
        titre: 'Décompte rectificatif',
        remarque: `Ce décompte remplace celui${previous.date_envoi ? ` du ${frenchDate(previous.date_envoi)}` : ''}, `
          + 'qui comportait une erreur.',
      }
      : { titre: 'Régularisation des charges' }
    return pdf(reply, r.instantane, entete, `justificatif-${r.lot}-${r.debut}-${r.fin}`.replace(/\s+/g, '-'))
  })

  // Preview from the current statement, nothing stored
  app.get('/justificatif', async (request, reply) => {
    try {
      const ex = exercise(request)
      const sejour = requiredId(query(request).sejour, 'Séjour')
      const j = await buildJustificatif(db, ex, sejour)
      return pdf(reply, j, { titre: 'Projet – non envoyé' }, `projet-${j.sejour.lot}-${ex.debut}-${ex.fin}`.replace(/\s+/g, '-'))
    } catch (error) {
      return handle(reply, error)
    }
  })

  app.post('/regularisations/:id/mail', async (request, reply) => {
    try {
      const r = await load(idParam(request))
      if (!r) {
        return reply.code(404).send({ message: 'Régularisation introuvable' })
      }
      const b = body(request)
      const etalement = Number(b.etalement ?? 1)
      if (!Number.isInteger(etalement) || etalement < 1 || etalement > 24) {
        throw new InputError('Étalement : de 1 à 24 mensualités')
      }
      const options: MailOptions = {
        etalement,
        provision_mensuelle: optionalDecimal(b.provision_mensuelle, 'Provision mensuelle'),
        provision_a_partir_du: b.provision_a_partir_du ? requiredDate(b.provision_a_partir_du, 'Date d\'effet') : null,
        signature: optionalText(b.signature) ?? '',
      }
      const toMail = (x: NonNullable<Awaited<ReturnType<typeof load>>>): RegulMail => ({
        lot: x.lot, debut: x.debut, fin: x.fin,
        present_du: x.instantane?.sejour.present_du ?? null, present_au: x.instantane?.sejour.present_au ?? null,
        montant_du: x.montant_du, provisions: x.provisions, solde: x.solde, date_envoi: x.date_envoi,
        montant_recu: x.montant_recu,
      })
      const previous = r.remplace_id ? await load(r.remplace_id) : null
      const mail = previous ? mailRectificatif(toMail(previous), toMail(r), options) : mailRegularisation(toMail(r), options)
      return { destinataire: r.email, ...mail }
    } catch (error) {
      return handle(reply, error)
    }
  })
}

export default regularisationRoutes

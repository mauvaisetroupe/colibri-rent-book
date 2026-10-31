import Big from 'big.js'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import type { Pool } from 'pg'

import { annexesJointes, annexesVerifiees, etatsAnnexes } from '../annexes.js'
import { euros, frenchDate } from '../format.js'
import {
  body, exercise, idParam, InputError, optionalDecimal, optionalText, query, requiredDate, requiredDecimal, requiredId,
  sendError,
} from '../http.js'
import { buildJustificatif, SejourHorsExercice, type Justificatif } from '../justificatif.js'
import { justificatifPdf, type Entete } from '../justificatifPdf.js'
import { mailRectificatif, mailRegularisation, suggestionProvision, type MailOptions, type RegulMail } from '../mails.js'
import { inclusiveBounds, inclusiveRange } from '../periods.js'

// Regularisations (ADR 0007): created from the statement of an exercise, they freeze what is sent (instantane); a
// corrective one replaces the previous (remplace_id). A regularisation sent outside the application can be entered
// by hand, to prepare its corrective mail. Its state (draft, waiting, settled) is computed from the sending date and
// the payments; the owner only records a decision: charge given up, unrecoverable (ADR 0010).

const COLUMNS = `
  r.id, r.tenancy_id, lo.name AS tenant, lo.email, lt.code AS unit, lt.building_id,
  ${inclusiveBounds('r.period')}, r.amount_due::text, r.advances::text, r.balance::text,
  charge_adjustment_state(r.id) AS state, r.decision, r.sent_on::text, charge_adjustment_paid(r.id)::text AS amount_received,
  charge_adjustment_settled_on(r.id)::text AS settled_on, r.replaces_id,
  (SELECT n.id FROM charge_adjustment n WHERE n.replaces_id = r.id) AS replaced_by,
  r.snapshot IS NOT NULL AS supporting_statement, r.note, r.created_at`

const FROM = `charge_adjustment r
  JOIN tenancy s ON s.id = r.tenancy_id
  JOIN unit lt ON lt.id = s.unit_id
  JOIN tenant lo ON lo.id = s.tenant_id`

type Regularisation = {
  id: number
  tenancy_id: number
  tenant: string
  email: string | null
  unit: string
  building_id: number
  start: string
  end: string
  amount_due: string
  advances: string
  balance: string
  state: 'draft' | 'pending' | 'settled'
  decision: 'written_off' | 'unrecoverable' | null
  sent_on: string | null
  // Payments received, corrective chain included (ADR 0008)
  amount_received: string
  settled_on: string | null
  replaces_id: number | null
  replaced_by: number | null
  supporting_statement: boolean
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
    const { rows: [r] } = await db.query<Regularisation & {
      snapshot: Justificatif | null, sent_tenant_copies: Record<string, number> | null
    }>(
      `SELECT ${COLUMNS}, r.snapshot, r.sent_tenant_copies FROM ${FROM} WHERE r.id = $1`,
      [id],
    )
    return r ?? null
  }

  /** The PDF; `envoyees`: the versions in images joined at sending (ADR 0024), null: the current verified ones. */
  const pdf = async (reply: FastifyReply, j: Justificatif, entete: Entete, name: string,
    envoyees: Record<string, number> | null = null) => reply
    .type('application/pdf')
    .header('content-disposition', `inline; filename="${name}.pdf"`)
    .send(await justificatifPdf(j, entete,
      await annexesJointes(db, storageDir, j.invoices.map((f) => f.invoice_id), envoyees)))

  /** Statement row of a stay frozen into a new regularisation (draft). */
  async function create(sejourId: number, start: string, end: string, remplace: number | null) {
    const { rows: [tenancy] } = await db.query<{ building_id: number }>(
      'SELECT lt.building_id FROM tenancy s JOIN unit lt ON lt.id = s.unit_id WHERE s.id = $1',
      [sejourId],
    )
    if (!tenancy) {
      throw new InputError('Séjour inconnu')
    }
    const j = await buildJustificatif(db, { building: tenancy.building_id, start, end }, sejourId)
    const { rows: [created] } = await db.query<{ id: number }>(
      `INSERT INTO charge_adjustment (tenancy_id, period, amount_due, advances, replaces_id, snapshot)
       VALUES ($1, ${inclusiveRange('$2', '$3')}, $4, $5, $6, $7) RETURNING id`,
      [sejourId, start, end, cents(j.total), cents(j.advances), remplace, JSON.stringify(j)],
    )
    return load(created!.id)
  }

  /** The current (not replaced) regularisation of a stay for an exercise, if any. */
  async function current(sejourId: number, start: string, end: string) {
    const { rows: [r] } = await db.query<{ id: number }>(
      `SELECT r.id FROM charge_adjustment r
       WHERE r.tenancy_id = $1 AND r.period = ${inclusiveRange('$2', '$3')}
         AND NOT EXISTS (SELECT 1 FROM charge_adjustment n WHERE n.replaces_id = r.id)`,
      [sejourId, start, end],
    )
    return r?.id ?? null
  }

  const handle = (reply: FastifyReply, error: unknown) =>
    (error instanceof SejourHorsExercice ? reply.code(400).send({ message: error.message }) : sendError(reply, error))

  app.get('/regularisations', async (request, reply) => {
    try {
      const building = requiredId(query(request).building, 'Immeuble')
      const { rows } = await db.query<Regularisation>(
        `SELECT ${COLUMNS} FROM ${FROM} WHERE lt.building_id = $1 ORDER BY lower(r.period) DESC, lt.code, r.id`,
        [building],
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
    const { snapshot, sent_tenant_copies: _, ...rest } = r
    return {
      ...rest,
      snapshot,
      // What becomes of each invoice in the annexes now (ADR 0024): shown before sending
      tenant_copies: snapshot ? await etatsAnnexes(db, snapshot.invoices.map((f) => f.invoice_id)) : [],
      suggestion: {
        monthly_charge_advance: snapshot ? suggestionProvision(snapshot.total, snapshot.tenancy.days) : null,
        charge_advance_from: nextMonth(),
      },
    }
  })

  // From the statement: the amounts are frozen at this moment
  app.post('/regularisations', async (request, reply) => {
    try {
      const b = body(request)
      const sejourId = requiredId(b.tenancy_id, 'Séjour')
      const start = requiredDate(b.start, 'Début')
      const end = requiredDate(b.end, 'Fin')
      const existing = await current(sejourId, start, end)
      if (existing) {
        return reply.code(409).send({
          message: 'Une régularisation existe déjà pour ce séjour et cette période : faire un rectificatif',
          charge_adjustment_id: existing,
        })
      }
      return reply.code(201).send(await create(sejourId, start, end, null))
    } catch (error) {
      return handle(reply, error)
    }
  })

  // Regularisation already sent outside the application (SPEC § 11): what was asked, as sent
  app.post('/regularisations/manuelle', async (request, reply) => {
    try {
      const b = body(request)
      const sejourId = requiredId(b.tenancy_id, 'Séjour')
      const start = requiredDate(b.start, 'Début')
      const end = requiredDate(b.end, 'Fin')
      const balance = requiredDecimal(b.balance, 'Montant demandé')
      const advances = optionalDecimal(b.advances, 'Provisions') ?? '0'
      const existing = await current(sejourId, start, end)
      if (existing) {
        return reply.code(409).send({ message: 'Une régularisation existe déjà pour ce séjour et cette période',
          charge_adjustment_id: existing })
      }
      const dateEnvoi = requiredDate(b.sent_on, 'Date d\'envoi')
      const recu = optionalDecimal(b.amount_received, 'Montant reçu')
      const { rows: [created] } = await db.query<{ id: number }>(
        `INSERT INTO charge_adjustment (tenancy_id, period, amount_due, advances, sent_on, note)
         VALUES ($1, ${inclusiveRange('$2', '$3')}, $4, $5, $6, $7) RETURNING id`,
        [sejourId, start, end, new Big(balance).plus(advances).toString(), advances, dateEnvoi, optionalText(b.note)],
      )
      // What was already received becomes a payment (date unknown: the sending date)
      if (recu && Number(recu) !== 0) {
        await db.query(
          `INSERT INTO payment (tenancy_id, payment_date, charge_adjustment_id, charge_adjustment, note)
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
      if (previous.replaced_by) {
        return reply.code(409).send({ message: 'Cette régularisation a déjà un rectificatif',
          charge_adjustment_id: previous.replaced_by })
      }
      if (previous.state === 'draft') {
        return reply.code(409).send({ message: 'Brouillon jamais envoyé : le supprimer et en créer un nouveau' })
      }
      return reply.code(201).send(await create(previous.tenancy_id, previous.start, previous.end, previous.id))
    } catch (error) {
      return handle(reply, error)
    }
  })

  app.post('/regularisations/:id/envoi', async (request, reply) => {
    try {
      const date = requiredDate(body(request).sent_on, 'Date d\'envoi')
      const r = await load(idParam(request))
      // The versions in images joined now are those the tenant receives (ADR 0024)
      const envoyees = r?.snapshot ? await annexesVerifiees(db, r.snapshot.invoices.map((f) => f.invoice_id)) : null
      const { rowCount } = await db.query(
        'UPDATE charge_adjustment SET sent_on = $2, sent_tenant_copies = $3 WHERE id = $1 AND sent_on IS NULL',
        [idParam(request), date, envoyees && JSON.stringify(envoyees)],
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
    const { rowCount: payments } = await db.query('SELECT 1 FROM payment WHERE charge_adjustment_id = $1 LIMIT 1', [id])
    const refus = !r.sent_on ? 'Pas encore envoyée'
      : r.replaced_by ? 'Déjà rectifiée : l\'envoi ne peut plus être annulé'
        : r.decision ? 'Une décision est prise (abandon, irrécouvrable) : l\'annuler d\'abord'
          : payments ? 'Des versements y sont rattachés : les supprimer d\'abord (écran Paiements)'
            : null
    if (refus) {
      return reply.code(409).send({ message: refus })
    }
    await db.query('UPDATE charge_adjustment SET sent_on = NULL, sent_tenant_copies = NULL WHERE id = $1', [id])
    return load(id)
  })

  // The only thing set by hand (ADR 0010): what remains is given up (charge « offerte ») or unrecoverable; null
  // withdraws the decision
  app.post('/regularisations/:id/decision', async (request, reply) => {
    try {
      const raw = body(request).decision
      const decision = raw === null || raw === undefined || raw === '' ? null : String(raw)
      if (decision !== null && !['written_off', 'unrecoverable'].includes(decision)) {
        throw new InputError('Décision possible : abandonnée, irrécouvrable, ou aucune')
      }
      const { rowCount } = await db.query(
        `UPDATE charge_adjustment r SET decision = $2::adjustment_decision
         WHERE r.id = $1 AND r.sent_on IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM charge_adjustment n WHERE n.replaces_id = r.id)`,
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
      `DELETE FROM charge_adjustment r WHERE r.id = $1 AND r.sent_on IS NULL
         AND NOT EXISTS (SELECT 1 FROM charge_adjustment n WHERE n.replaces_id = r.id)`,
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
    if (!r.snapshot) {
      try {
        const j = await buildJustificatif(db, { building: r.building_id, start: r.start, end: r.end }, r.tenancy_id)
        const recalcule = new Big(j.balance).round(2, Big.roundHalfUp)
        const ecart = recalcule.minus(r.balance)
        const envoi = r.sent_on ? ` le ${frenchDate(r.sent_on)}` : ''
        const entete: Entete = ecart.abs().lt(SEUIL_RECTIFICATION)
          ? {
            title: 'Justificatif reconstitué',
            remarque: `Régularisation envoyée${envoi} pour un solde de ${euros(r.balance)} ; recalculée par `
              + `l'application : ${euros(recalcule.toString())}`
              + (ecart.eq(0) ? '.' : ` (écart d'arrondi de ${euros(ecart.toString())}).`),
          }
          : {
            title: 'Justificatif reconstitué',
            alerte: `Ce calcul diffère de ${euros(ecart.abs().toString())} du montant envoyé${envoi} `
              + `(${euros(r.balance)}) : il ne correspond pas à ce que le locataire a reçu. Voir le rectificatif.`,
          }
        return pdf(reply, j, entete, `reconstitue-${r.unit}-${r.start}-${r.end}`.replace(/\s+/g, '-'))
      } catch (error) {
        return handle(reply, error)
      }
    }
    const previous = r.replaces_id ? await load(r.replaces_id) : null
    const entete: Entete = previous
      ? {
        title: 'Décompte rectificatif',
        remarque: `Ce décompte remplace celui${previous.sent_on ? ` du ${frenchDate(previous.sent_on)}` : ''}, `
          + 'qui comportait une erreur.',
      }
      : { title: 'Régularisation des charges' }
    return pdf(reply, r.snapshot, entete, `justificatif-${r.unit}-${r.start}-${r.end}`.replace(/\s+/g, '-'),
      r.sent_tenant_copies)
  })

  // Preview from the current statement, nothing stored
  app.get('/justificatif', async (request, reply) => {
    try {
      const ex = exercise(request)
      const tenancy = requiredId(query(request).tenancy, 'Séjour')
      const j = await buildJustificatif(db, ex, tenancy)
      return pdf(reply, j, { title: 'Projet – non envoyé' }, `projet-${j.tenancy.unit}-${ex.start}-${ex.end}`.replace(/\s+/g, '-'))
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
        monthly_charge_advance: optionalDecimal(b.monthly_charge_advance, 'Provision mensuelle'),
        charge_advance_from: b.charge_advance_from ? requiredDate(b.charge_advance_from, 'Date d\'effet') : null,
        signature: optionalText(b.signature) ?? '',
      }
      const toMail = (x: NonNullable<Awaited<ReturnType<typeof load>>>): RegulMail => ({
        unit: x.unit, start: x.start, end: x.end,
        present_from: x.snapshot?.tenancy.present_from ?? null, present_to: x.snapshot?.tenancy.present_to ?? null,
        amount_due: x.amount_due, advances: x.advances, balance: x.balance, sent_on: x.sent_on,
        amount_received: x.amount_received,
      })
      const previous = r.replaces_id ? await load(r.replaces_id) : null
      const mail = previous ? mailRectificatif(toMail(previous), toMail(r), options) : mailRegularisation(toMail(r), options)
      return { destinataire: r.email, ...mail }
    } catch (error) {
      return handle(reply, error)
    }
  })
}

export default regularisationRoutes

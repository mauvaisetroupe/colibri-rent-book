import { createReadStream } from 'node:fs'
import { join } from 'node:path'

import multipart from '@fastify/multipart'
import Big from 'big.js'
import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'

import {
  body, idParam, InputError, optionalDate, optionalText, query, requiredDate, requiredDecimal, requiredId, requiredText,
  sendError,
} from '../http.js'
import { AVEC_DETAIL, estCategorie, type Categorie } from '../categories.js'
import { COUVERT_SQL, categoriserSiVide, verifierMouvement } from '../couverture.js'
import { isPdf, removeIfUnused, storePdf } from '../pdfStorage.js'

// Bank statements (ADR 0018): the PDF is read in the browser by the extractor of its bank, the server checks the
// balances and stores the statement with its movements. Each movement then gets a category (categories.ts): the payment
// of a tenant, works and deposits have a detail (ADR 0019), linked on the other side (paiement, reglement_travaux,
// versement_depot: mouvement_id), so deleting a payment leaves its movement « incomplet »; a note justifies a rest the
// detail does not cover.

type MouvementLu = { date_operation: string, date_valeur: string | null, libelle: string, detail: string | null, montant: string }
type ReleveLu = {
  extracteur_id: number
  compte: string
  date_releve: string
  solde_precedent: string
  nouveau_solde: string
  totaux: { debit: string | null, credit: string | null } | null
  mouvements: MouvementLu[]
}

const sum = (amounts: string[]) => amounts.reduce((s, m) => s.plus(m), new Big(0))

/** The statement as read in the browser; refused when its balances do not add up (SPEC § 6 for invoices, same idea). */
export function readReleve(raw: Record<string, unknown>): ReleveLu {
  const mouvements = Array.isArray(raw.mouvements) ? raw.mouvements as Record<string, unknown>[] : null
  if (!mouvements) {
    throw new InputError('« mouvements » : liste attendue')
  }
  const totaux = raw.totaux && typeof raw.totaux === 'object' ? raw.totaux as Record<string, unknown> : null
  const r: ReleveLu = {
    extracteur_id: requiredId(raw.extracteur_id, 'Extracteur'),
    compte: requiredText(raw.compte, 'Compte'),
    date_releve: requiredDate(raw.date_releve, 'Date du relevé'),
    solde_precedent: requiredDecimal(raw.solde_precedent, 'Solde précédent'),
    nouveau_solde: requiredDecimal(raw.nouveau_solde, 'Nouveau solde'),
    totaux: totaux && {
      debit: totaux.debit == null ? null : requiredDecimal(totaux.debit, 'Total des débits'),
      credit: totaux.credit == null ? null : requiredDecimal(totaux.credit, 'Total des crédits'),
    },
    mouvements: mouvements.map((m, i) => {
      const montant = requiredDecimal(m.montant, `Mouvement ${i + 1}, montant`)
      if (new Big(montant).eq(0)) {
        throw new InputError(`Mouvement ${i + 1} : montant nul`)
      }
      return {
        date_operation: requiredDate(m.date_operation, `Mouvement ${i + 1}, date`),
        date_valeur: optionalDate(m.date_valeur, `Mouvement ${i + 1}, date de valeur`),
        libelle: requiredText(m.libelle, `Mouvement ${i + 1}, libellé`),
        detail: optionalText(m.detail),
        montant,
      }
    }),
  }
  const credits = sum(r.mouvements.filter((m) => new Big(m.montant).gt(0)).map((m) => m.montant))
  const debits = sum(r.mouvements.filter((m) => new Big(m.montant).lt(0)).map((m) => m.montant)).abs()
  const calcule = new Big(r.solde_precedent).plus(credits).minus(debits)
  if (!calcule.eq(r.nouveau_solde)) {
    throw new InputError(`Solde précédent + crédits − débits = ${calcule.toFixed(2)}, le relevé dit ${new Big(r.nouveau_solde).toFixed(2)}`)
  }
  if (r.totaux?.debit != null && !debits.eq(r.totaux.debit)) {
    throw new InputError(`Débits lus ${debits.toFixed(2)}, total imprimé ${new Big(r.totaux.debit).toFixed(2)}`)
  }
  if (r.totaux?.credit != null && !credits.eq(r.totaux.credit)) {
    throw new InputError(`Crédits lus ${credits.toFixed(2)}, total imprimé ${new Big(r.totaux.credit).toFixed(2)}`)
  }
  return r
}

const RELEVE_COLUMNS = `
  r.id, fo.nom AS banque, r.compte, r.date_releve::text, r.solde_precedent::text, r.nouveau_solde::text,
  r.fichier_pdf IS NOT NULL AS pdf, r.extracteur_id, r.importe_le::text`

// What a movement became: its payments, works payments and deposits, the amount they cover, and its state
const MOUVEMENT_COLUMNS = `
  m.id, m.releve_id, m.ordre, m.date_operation::text, m.date_valeur::text, m.libelle, m.detail, m.montant::text,
  m.categorie, m.note, r.compte, r.date_releve::text,
  coalesce(l.paiements, '[]'::json) AS paiements, coalesce(l.travaux, '[]'::json) AS travaux,
  coalesce(l.depots, '[]'::json) AS depots,
  coalesce(l.couvert, 0)::text AS couvert,
  coalesce(l.possibles, '[]'::json) AS possibles,
  CASE WHEN m.categorie IS NULL THEN 'a_categoriser'
       -- A category with a detail that does not cover the amount, and no note to justify the rest
       WHEN m.categorie IN (${AVEC_DETAIL.map((c) => `'${c}'`).join(', ')}) AND coalesce(l.couvert, 0) < abs(m.montant)
            AND m.note IS NULL
         THEN 'incomplet'
       ELSE 'categorise' END AS statut`

const MOUVEMENT_FROM = `mouvement m
  JOIN releve_bancaire r ON r.id = m.releve_id
  LEFT JOIN LATERAL (
    SELECT
      (SELECT json_agg(json_build_object('id', p.id, 'locataire', lo.nom, 'lot', lt.code, 'mois', p.mois::text,
                                         'total', (p.loyer + p.provision + p.regularisation)::text) ORDER BY p.mois)
       FROM paiement p JOIN sejour s ON s.id = p.sejour_id JOIN lot lt ON lt.id = s.lot_id
       JOIN locataire lo ON lo.id = s.locataire_id WHERE p.mouvement_id = m.id) AS paiements,
      -- The payments of works invoices: total, the amount of this payment; montant_ttc and reste, those of the invoice
      (SELECT json_agg(json_build_object('id', t.id, 'reglement_id', rt.id, 'description', t.description,
                                         'fournisseur', t.fournisseur, 'total', rt.montant::text,
                                         'montant_ttc', t.montant_ttc::text,
                                         'reste', (t.montant_ttc - (SELECT sum(x.montant) FROM reglement_travaux x
                                                                    WHERE x.travaux_id = t.id))::text) ORDER BY rt.id)
       FROM reglement_travaux rt JOIN travaux t ON t.id = rt.travaux_id WHERE rt.mouvement_id = m.id) AS travaux,
      (SELECT json_agg(json_build_object('id', vd.id, 'sejour_id', vd.sejour_id, 'locataire', lo.nom, 'lot', lt.code,
                                         'date', vd.date_versement::text, 'montant', vd.montant::text) ORDER BY vd.id)
       FROM versement_depot vd JOIN sejour s ON s.id = vd.sejour_id JOIN lot lt ON lt.id = s.lot_id
       JOIN locataire lo ON lo.id = s.locataire_id WHERE vd.mouvement_id = m.id) AS depots,
      ${COUVERT_SQL} AS couvert,
      -- Recorded by hand before the statements: payments (credit) or works (debit) not linked yet, of the same amount,
      -- within ten days: to link rather than to type again
      -- (a transfer of several months typed as several payments: those of one tenant whose sum is the amount)
      CASE WHEN m.montant > 0 THEN coalesce(
        (SELECT json_agg(json_build_object('type', 'paiement', 'id', p.id, 'locataire', lo.nom, 'lot', lt.code,
                                           'mois', p.mois::text, 'date', p.date_paiement::text) ORDER BY abs(p.date_paiement - m.date_operation))
         FROM paiement p JOIN sejour s ON s.id = p.sejour_id JOIN lot lt ON lt.id = s.lot_id
         JOIN locataire lo ON lo.id = s.locataire_id
         WHERE p.mouvement_id IS NULL AND p.loyer + p.provision + p.regularisation = m.montant
           AND abs(p.date_paiement - m.date_operation) <= 10),
        (SELECT json_agg(json_build_object('type', 'groupe', 'ids', g.ids, 'locataire', g.locataire, 'lot', g.lot, 'mois', g.mois))
         FROM (
           SELECT array_agg(p.id ORDER BY p.mois) AS ids, lo.nom AS locataire, lt.code AS lot,
                  string_agg(to_char(p.mois, 'MM/YYYY'), ', ' ORDER BY p.mois) AS mois
           FROM paiement p JOIN sejour s ON s.id = p.sejour_id JOIN lot lt ON lt.id = s.lot_id
           JOIN locataire lo ON lo.id = s.locataire_id
           WHERE p.mouvement_id IS NULL AND abs(p.date_paiement - m.date_operation) <= 10
           GROUP BY s.id, lo.nom, lt.code
           HAVING count(*) > 1 AND sum(p.loyer + p.provision + p.regularisation) = m.montant
         ) g))
      ELSE coalesce(
        -- Works: an invoice whose unpaid rest is the amount
        (SELECT json_agg(json_build_object('type', 'travaux', 'id', t.id, 'description', t.description,
                                           'fournisseur', t.fournisseur, 'date', t.date_facture::text))
         FROM travaux t
         WHERE t.montant_ttc - (SELECT coalesce(sum(rt.montant), 0) FROM reglement_travaux rt WHERE rt.travaux_id = t.id)
               = -m.montant),
        -- A refund to a tenant (negative payment) typed by hand
        (SELECT json_agg(json_build_object('type', 'paiement', 'id', p.id, 'locataire', lo.nom, 'lot', lt.code,
                                           'mois', p.mois::text, 'date', p.date_paiement::text))
         FROM paiement p JOIN sejour s ON s.id = p.sejour_id JOIN lot lt ON lt.id = s.lot_id
         JOIN locataire lo ON lo.id = s.locataire_id
         WHERE p.mouvement_id IS NULL AND p.loyer + p.provision + p.regularisation = m.montant
           AND abs(p.date_paiement - m.date_operation) <= 10))
      END AS possibles
  ) l ON true`

const releveRoutes: FastifyPluginAsync<{ db: Pool, storageDir: string }> = async (app, { db, storageDir }) => {
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1, fieldSize: 5 * 1024 * 1024 } })

  const mouvementsDe = async (releveId: number) => (await db.query(
    `SELECT ${MOUVEMENT_COLUMNS} FROM ${MOUVEMENT_FROM} WHERE m.releve_id = $1 ORDER BY m.ordre`, [releveId])).rows

  async function load(id: number) {
    const { rows: [releve] } = await db.query(
      `SELECT ${RELEVE_COLUMNS} FROM releve_bancaire r JOIN fournisseur fo ON fo.id = r.fournisseur_id WHERE r.id = $1`, [id])
    return releve ? { ...releve, mouvements: await mouvementsDe(id) } : null
  }

  // Every statement, the latest first; « suite » says whether its opening balance is the closing balance of the
  // previous statement of the account (false: a statement is missing in between)
  app.get('/releves', async () => {
    const { rows } = await db.query(
      `SELECT ${RELEVE_COLUMNS},
              (SELECT count(*)::int FROM mouvement m WHERE m.releve_id = r.id) AS nb_mouvements,
              lag(r.nouveau_solde) OVER (PARTITION BY r.compte ORDER BY r.date_releve) AS precedent
       FROM releve_bancaire r JOIN fournisseur fo ON fo.id = r.fournisseur_id
       ORDER BY r.date_releve DESC, r.compte`,
    )
    return rows.map(({ precedent, ...r }) => ({
      ...r, suite: precedent === null ? null : new Big(precedent).eq(r.solde_precedent),
    }))
  })

  app.get('/releves/:id', async (request, reply) =>
    (await load(idParam(request))) ?? reply.code(404).send({ message: 'Relevé introuvable' }))

  app.get('/releves/:id/pdf', async (request, reply) => {
    const { rows: [r] } = await db.query<{ fichier_pdf: string | null }>(
      'SELECT fichier_pdf FROM releve_bancaire WHERE id = $1', [idParam(request)])
    if (!r?.fichier_pdf) {
      return reply.code(404).send({ message: 'Pas de PDF pour ce relevé' })
    }
    return reply.type('application/pdf').header('content-disposition', 'inline')
      .send(createReadStream(join(storageDir, r.fichier_pdf)))
  })

  // PDF and the statement read from it by an extractor, in the browser. Multipart: « file » and « releve » (JSON)
  app.post('/releves/import', async (request, reply) => {
    let content: Buffer | null = null
    let raw: Record<string, unknown> | null = null
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        content = await part.toBuffer()
      } else if (part.fieldname === 'releve') {
        try {
          raw = JSON.parse(String(part.value))
        } catch {
          return reply.code(400).send({ message: '« releve » doit être du JSON' })
        }
      }
    }
    if (!content || !isPdf(content)) {
      return reply.code(content ? 415 : 400).send({ message: content ? 'Le fichier n\'est pas un PDF' : 'Aucun fichier reçu' })
    }
    if (!raw) {
      return reply.code(400).send({ message: 'Relevé manquant : il est lu dans le navigateur' })
    }
    let r: ReleveLu
    try {
      r = readReleve(raw)
    } catch (error) {
      return sendError(reply, error)
    }
    const { rows: [extracteur] } = await db.query<{ fournisseur_id: number }>(
      'SELECT fournisseur_id FROM extracteur WHERE id = $1 AND type = \'releve\'', [r.extracteur_id])
    if (!extracteur) {
      return reply.code(400).send({ message: 'Extracteur de relevé inconnu' })
    }
    const { rows: [existant] } = await db.query<{ id: number }>(
      'SELECT id FROM releve_bancaire WHERE compte = $1 AND date_releve = $2', [r.compte, r.date_releve])
    if (existant) {
      return reply.code(409).send({ message: `Relevé du ${r.date_releve} du compte ${r.compte} déjà importé`, releve_id: existant.id })
    }
    const { fileName } = await storePdf(storageDir, content, 'releves')
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const { rows: [created] } = await client.query<{ id: number }>(
        `INSERT INTO releve_bancaire (fournisseur_id, compte, date_releve, solde_precedent, nouveau_solde, fichier_pdf, extracteur_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [extracteur.fournisseur_id, r.compte, r.date_releve, r.solde_precedent, r.nouveau_solde, fileName, r.extracteur_id],
      )
      for (const [ordre, m] of r.mouvements.entries()) {
        await client.query(
          `INSERT INTO mouvement (releve_id, ordre, date_operation, date_valeur, libelle, detail, montant)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [created!.id, ordre, m.date_operation, m.date_valeur, m.libelle, m.detail, m.montant],
        )
      }
      await client.query('COMMIT')
      return reply.code(201).send(await load(created!.id))
    } catch (error) {
      await client.query('ROLLBACK')
      await removeIfUnused(db, storageDir, fileName)
      if ((error as { code?: string }).code === '23505') {
        return reply.code(409).send({ message: `Relevé du ${r.date_releve} du compte ${r.compte} déjà importé` })
      }
      throw error
    } finally {
      client.release()
    }
  })

  // A statement whose movements are not matched yet (to import it again); a matched one stays
  app.delete('/releves/:id', async (request, reply) => {
    const id = idParam(request)
    const { rows: [lie] } = await db.query(
      `SELECT 1 FROM mouvement m WHERE m.releve_id = $1 AND (m.categorie IS NOT NULL
         OR EXISTS (SELECT 1 FROM paiement p WHERE p.mouvement_id = m.id)
         OR EXISTS (SELECT 1 FROM reglement_travaux rt WHERE rt.mouvement_id = m.id)
         OR EXISTS (SELECT 1 FROM versement_depot vd WHERE vd.mouvement_id = m.id))`,
      [id],
    )
    if (lie) {
      return reply.code(409).send({ message: 'Des mouvements de ce relevé sont catégorisés : le relevé est gardé' })
    }
    const { rows: [deleted] } = await db.query<{ fichier_pdf: string | null }>(
      'DELETE FROM releve_bancaire WHERE id = $1 RETURNING fichier_pdf', [id])
    if (!deleted) {
      return reply.code(404).send({ message: 'Relevé introuvable' })
    }
    if (deleted.fichier_pdf) {
      await removeIfUnused(db, storageDir, deleted.fichier_pdf)
    }
    return reply.code(204).send()
  })

  // ---------------------------------------------------------------- movements

  // Movements, the oldest first: all, or by state (a_categoriser, incomplet, categorise), of a category
  app.get('/mouvements', async (request, reply) => {
    const q = query(request)
    const statut = q.statut ?? 'tous'
    if (!['tous', 'a_categoriser', 'incomplet', 'categorise'].includes(statut)) {
      return reply.code(400).send({ message: 'Statut : tous, a_categoriser, incomplet ou categorise' })
    }
    if (q.categorie && !estCategorie(q.categorie)) {
      return reply.code(400).send({ message: 'Catégorie inconnue' })
    }
    const { rows } = await db.query(
      `SELECT * FROM (SELECT ${MOUVEMENT_COLUMNS} FROM ${MOUVEMENT_FROM}) x
       WHERE ($1 = 'tous' OR statut = $1) AND ($4::text IS NULL OR categorie = $4)
         AND ($2::date IS NULL OR date_operation::date >= $2::date) AND ($3::date IS NULL OR date_operation::date <= $3::date)
       ORDER BY date_operation, releve_id, ordre`,
      [statut, q.du || null, q.au || null, q.categorie || null],
    )
    return rows
  })

  const loadMouvement = async (id: number) => (await db.query(
    `SELECT ${MOUVEMENT_COLUMNS} FROM ${MOUVEMENT_FROM} WHERE m.id = $1`, [id])).rows[0] ?? null

  /** Its links: payments, works payments, deposits. */
  async function liens(id: number) {
    const { rows: [l] } = await db.query<{ paiements: number, travaux: number, depots: number }>(
      `SELECT (SELECT count(*)::int FROM paiement WHERE mouvement_id = $1) AS paiements,
              (SELECT count(*)::int FROM reglement_travaux WHERE mouvement_id = $1) AS travaux,
              (SELECT count(*)::int FROM versement_depot WHERE mouvement_id = $1) AS depots`, [id])
    return l!
  }

  /** The categories a movement may have with its links: payments, works or deposits keep theirs. */
  function categoriesPermises(l: { paiements: number, travaux: number, depots: number }): Categorie[] | null {
    if (l.travaux) {
      return ['travaux']
    }
    if (l.paiements) {
      return ['locataire']
    }
    return l.depots ? ['locataire', 'depot_garantie'] : null
  }

  // The category of a movement, and a note (required for « autre »; for a category with a detail, it justifies the
  // rest the detail does not cover). A movement with a detail linked stays in a category that has it.
  app.put('/mouvements/:id/categorie', async (request, reply) => {
    const id = idParam(request)
    try {
      const raw = body(request)
      if (!estCategorie(raw.categorie)) {
        throw new InputError('Catégorie inconnue')
      }
      const note = optionalText(raw.note)
      if (raw.categorie === 'autre' && !note) {
        throw new InputError('« Autre » : préciser ce qu\'est ce mouvement dans la note')
      }
      const permises = categoriesPermises(await liens(id))
      if (permises && !permises.includes(raw.categorie)) {
        return reply.code(409).send({ message: 'Des paiements, des travaux ou des dépôts y sont rattachés : les détacher d\'abord' })
      }
      const { rowCount } = await db.query('UPDATE mouvement SET categorie = $2, note = $3 WHERE id = $1', [id, raw.categorie, note])
      return rowCount ? loadMouvement(id) : reply.code(404).send({ message: 'Mouvement introuvable' })
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.delete('/mouvements/:id/categorie', async (request, reply) => {
    const id = idParam(request)
    if (categoriesPermises(await liens(id))) {
      return reply.code(409).send({ message: 'Des paiements, des travaux ou des dépôts y sont rattachés : les détacher d\'abord' })
    }
    const { rowCount } = await db.query('UPDATE mouvement SET categorie = NULL, note = NULL WHERE id = $1', [id])
    return rowCount ? loadMouvement(id) : reply.code(404).send({ message: 'Mouvement introuvable' })
  })

  // Links what was recorded by hand (before the statements) to the movement: payments of a tenant, works (a payment
  // typed of this amount, else a new payment of what remains of the invoice), a deposit
  app.post('/mouvements/:id/lier', async (request, reply) => {
    const id = idParam(request)
    try {
      const raw = body(request)
      const m = await loadMouvement(id)
      if (!m) {
        return reply.code(404).send({ message: 'Mouvement introuvable' })
      }
      const montant = new Big(m.montant)
      const resteMouvement = montant.abs().minus(m.couvert)
      if (raw.paiement_ids !== undefined || raw.paiement_id) {
        // One payment, or several at once (a transfer of several months)
        const ids = Array.isArray(raw.paiement_ids) ? raw.paiement_ids.map((x) => requiredId(x, 'Paiement')) : [requiredId(raw.paiement_id, 'Paiement')]
        const { rows } = await db.query<{ id: number, mouvement_id: number | null, total: string }>(
          'SELECT id, mouvement_id, (loyer + provision + regularisation)::text AS total FROM paiement WHERE id = ANY($1)', [ids])
        if (rows.length !== ids.length) {
          return reply.code(404).send({ message: 'Paiement introuvable' })
        }
        if (rows.some((p) => p.mouvement_id !== null && p.mouvement_id !== id)) {
          throw new InputError('Un de ces paiements est déjà rattaché à un autre mouvement')
        }
        // Payments chosen by hand may exceed the transfer: an agency pays the rents it collected less its fees, a rent
        // paid by two transfers is linked to one of them; only the category and the sign are checked
        await verifierMouvement(db, id, {
          categories: ['locataire'], signe: montant.gt(0) ? 1 : -1, montant: new Big(0), detail: 'paiement', exclure: null,
        })
        await db.query('UPDATE paiement SET mouvement_id = $2 WHERE id = ANY($1)', [ids, id])
        await categoriserSiVide(db, id, 'locataire')
        return loadMouvement(id)
      }
      if (raw.travaux_id) {
        // A payment of the invoice by this movement: what remains of the movement, no more than what remains of the
        // invoice (a transfer paying two invoices is linked to both)
        const travauxId = requiredId(raw.travaux_id, 'Travaux')
        const { rows: [t] } = await db.query<{ reste: string }>(
          `SELECT (t.montant_ttc - (SELECT coalesce(sum(montant), 0) FROM reglement_travaux WHERE travaux_id = t.id))::text AS reste
           FROM travaux t WHERE t.id = $1`, [travauxId])
        if (!t) {
          return reply.code(404).send({ message: 'Travaux introuvables' })
        }
        const montantReglement = resteMouvement.lt(t.reste) ? resteMouvement : new Big(t.reste)
        if (!montantReglement.gt(0)) {
          throw new InputError(new Big(t.reste).gt(0) ? 'Ce mouvement est déjà rattaché en entier' : 'Cette facture est déjà réglée en entier')
        }
        await verifierMouvement(db, id, {
          categories: ['travaux'], signe: -1, montant: montantReglement, detail: 'reglement_travaux', exclure: null,
        })
        await db.query(
          `INSERT INTO reglement_travaux (travaux_id, mouvement_id, montant) VALUES ($1, $2, $3)
           ON CONFLICT (travaux_id, mouvement_id) DO UPDATE SET montant = reglement_travaux.montant + excluded.montant`,
          [travauxId, id, montantReglement.toString()])
        await categoriserSiVide(db, id, 'travaux')
        return loadMouvement(id)
      }
      if (raw.depot_id) {
        const depotId = requiredId(raw.depot_id, 'Versement de dépôt')
        const { rows: [d] } = await db.query<{ montant: string, mouvement_id: number | null }>(
          'SELECT montant::text, mouvement_id FROM versement_depot WHERE id = $1', [depotId])
        if (!d) {
          return reply.code(404).send({ message: 'Versement introuvable' })
        }
        if (d.mouvement_id !== null && d.mouvement_id !== id) {
          throw new InputError('Déjà rattaché à un autre mouvement')
        }
        await verifierMouvement(db, id, {
          categories: ['locataire', 'depot_garantie'], signe: new Big(d.montant).gt(0) ? 1 : -1, montant: new Big(d.montant),
          detail: 'versement_depot', exclure: depotId,
        })
        await db.query('UPDATE versement_depot SET mouvement_id = $2 WHERE id = $1', [depotId, id])
        await categoriserSiVide(db, id, 'depot_garantie')
        return loadMouvement(id)
      }
      throw new InputError('Indiquer le paiement, les travaux ou le versement de dépôt à rattacher')
    } catch (error) {
      return sendError(reply, error)
    }
  })

  // Detaches: the payment or the deposit stays, in its screen; a works payment is the movement itself, it goes
  app.post('/mouvements/:id/delier', async (request, reply) => {
    const id = idParam(request)
    const raw = body(request)
    if (raw.paiement_id) {
      await db.query('UPDATE paiement SET mouvement_id = NULL WHERE id = $1 AND mouvement_id = $2', [Number(raw.paiement_id), id])
    } else if (raw.reglement_id) {
      await db.query('DELETE FROM reglement_travaux WHERE id = $1 AND mouvement_id = $2', [Number(raw.reglement_id), id])
    } else if (raw.travaux_id) {
      await db.query('DELETE FROM reglement_travaux WHERE travaux_id = $1 AND mouvement_id = $2', [Number(raw.travaux_id), id])
    } else if (raw.depot_id) {
      await db.query('UPDATE versement_depot SET mouvement_id = NULL WHERE id = $1 AND mouvement_id = $2', [Number(raw.depot_id), id])
    }
    return (await loadMouvement(id)) ?? reply.code(404).send({ message: 'Mouvement introuvable' })
  })
}

export default releveRoutes

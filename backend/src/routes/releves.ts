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
import { AVEC_DETAIL, AVEC_FACTURE, estCategorie, type Categorie } from '../categories.js'
import { COUVERT_SQL, categoriserSiVide, verifierMouvement } from '../couverture.js'
import { isPdf, removeIfUnused, storePdf } from '../pdfStorage.js'
import { IntrouvableError, NUMERO_LISIBLE_SQL, RESTE_FACTURE_SQL, reglerFacture } from '../reglementsFacture.js'

// Bank statements (ADR 0018): the PDF is read in the browser by the extractor of its bank, the server checks the
// balances and stores the statement with its movements. Each movement then gets a category (categories.ts): the payment
// of a tenant, works and deposits have a detail (ADR 0019), linked on the other side (paiement, reglement_travaux,
// versement_depot: mouvement_id), so deleting a payment leaves its movement « incomplet »: complete only when its
// detail covers the amount. A debit « energie », « eau » or « impots » pays invoices of charges (reglement_facture,
// ADR 0022): « incomplet » too until they cover it.

type MouvementLu = { transaction_date: string, value_date: string | null, label: string, detail: string | null, amount: string }
type ReleveLu = {
  extractor_id: number
  account: string
  statement_date: string
  previous_balance: string
  new_balance: string
  totaux: { debit: string | null, credit: string | null } | null
  transactions: MouvementLu[]
}

const sum = (amounts: string[]) => amounts.reduce((s, m) => s.plus(m), new Big(0))

/** The statement as read in the browser; refused when its balances do not add up (SPEC § 6 for invoices, same idea). */
export function readReleve(raw: Record<string, unknown>): ReleveLu {
  const transactions = Array.isArray(raw.transactions) ? raw.transactions as Record<string, unknown>[] : null
  if (!transactions) {
    throw new InputError('« mouvements » : liste attendue')
  }
  const totaux = raw.totaux && typeof raw.totaux === 'object' ? raw.totaux as Record<string, unknown> : null
  const r: ReleveLu = {
    extractor_id: requiredId(raw.extractor_id, 'Extracteur'),
    account: requiredText(raw.account, 'Compte'),
    statement_date: requiredDate(raw.statement_date, 'Date du relevé'),
    previous_balance: requiredDecimal(raw.previous_balance, 'Solde précédent'),
    new_balance: requiredDecimal(raw.new_balance, 'Nouveau solde'),
    totaux: totaux && {
      debit: totaux.debit == null ? null : requiredDecimal(totaux.debit, 'Total des débits'),
      credit: totaux.credit == null ? null : requiredDecimal(totaux.credit, 'Total des crédits'),
    },
    transactions: transactions.map((m, i) => {
      const amount = requiredDecimal(m.amount, `Mouvement ${i + 1}, montant`)
      if (new Big(amount).eq(0)) {
        throw new InputError(`Mouvement ${i + 1} : montant nul`)
      }
      return {
        transaction_date: requiredDate(m.transaction_date, `Mouvement ${i + 1}, date`),
        value_date: optionalDate(m.value_date, `Mouvement ${i + 1}, date de valeur`),
        label: requiredText(m.label, `Mouvement ${i + 1}, libellé`),
        detail: optionalText(m.detail),
        amount,
      }
    }),
  }
  const credits = sum(r.transactions.filter((m) => new Big(m.amount).gt(0)).map((m) => m.amount))
  const debits = sum(r.transactions.filter((m) => new Big(m.amount).lt(0)).map((m) => m.amount)).abs()
  const calcule = new Big(r.previous_balance).plus(credits).minus(debits)
  if (!calcule.eq(r.new_balance)) {
    throw new InputError(`Solde précédent + crédits − débits = ${calcule.toFixed(2)}, le relevé dit ${new Big(r.new_balance).toFixed(2)}`)
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
  r.id, fo.name AS bank, r.account, r.statement_date::text, r.previous_balance::text, r.new_balance::text,
  r.pdf_file IS NOT NULL AS pdf, r.extractor_id, r.imported_at::text`

// What a movement became: its payments, works payments and deposits, the amount they cover, and its state
const MOUVEMENT_COLUMNS = `
  m.id, m.bank_statement_id, m.position, m.transaction_date::text, m.value_date::text, m.label, m.detail, m.amount::text,
  m.category, m.note, r.account, r.statement_date::text,
  coalesce(l.payments, '[]'::json) AS payments, coalesce(l.works_invoices, '[]'::json) AS works_invoices,
  coalesce(l.invoices, '[]'::json) AS invoices, coalesce(l.deposits, '[]'::json) AS deposits,
  coalesce(l.covered, 0)::text AS covered,
  coalesce(l.candidates, '[]'::json) AS candidates,
  CASE WHEN m.category IS NULL THEN 'to_categorise'
       -- A category with a detail that does not cover the amount (a note does not make up for it)
       WHEN m.category IN (${AVEC_DETAIL.map((c) => `'${c}'`).join(', ')}) AND coalesce(l.covered, 0) < abs(m.amount)
         THEN 'incomplet'
       ELSE 'categorise' END AS status`

const MOUVEMENT_FROM = `bank_transaction m
  JOIN bank_statement r ON r.id = m.bank_statement_id
  LEFT JOIN LATERAL (
    SELECT
      (SELECT json_agg(json_build_object('id', p.id, 'tenant', lo.name, 'unit', lt.code, 'month', p.month::text,
                                         'total', (p.rent + p.charge_advance + p.charge_adjustment)::text) ORDER BY p.month)
       FROM payment p JOIN tenancy s ON s.id = p.tenancy_id JOIN unit lt ON lt.id = s.unit_id
       JOIN tenant lo ON lo.id = s.tenant_id WHERE p.bank_transaction_id = m.id) AS payments,
      -- The payments of works invoices: total, the amount of this payment; total_incl_tax and remaining, those of the invoice
      (SELECT json_agg(json_build_object('id', t.id, 'works_invoice_payment_id', rt.id, 'description', t.description,
                                         'supplier', t.supplier, 'total', rt.amount::text,
                                         'total_incl_tax', t.total_incl_tax::text,
                                         'remaining', (t.total_incl_tax - (SELECT sum(x.amount) FROM works_invoice_payment x
                                                                    WHERE x.works_invoice_id = t.id))::text) ORDER BY rt.id)
       FROM works_invoice_payment rt JOIN works_invoice t ON t.id = rt.works_invoice_id WHERE rt.bank_transaction_id = m.id) AS works_invoices,
      -- The payments of invoices of charges (ADR 0022), the same way
      (SELECT json_agg(json_build_object('id', f.id, 'invoice_payment_id', rf.id, 'supplier', fo.name, 'number', f.number,
                                         'energy', f.energy, 'invoice_date', f.invoice_date::text, 'total', rf.amount::text,
                                         'total_incl_tax', f.total_incl_tax::text, 'remaining', ${RESTE_FACTURE_SQL}::text) ORDER BY rf.id)
       FROM invoice_payment rf JOIN invoice f ON f.id = rf.invoice_id JOIN supplier fo ON fo.id = f.supplier_id
       WHERE rf.bank_transaction_id = m.id) AS invoices,
      (SELECT json_agg(json_build_object('id', vd.id, 'tenancy_id', vd.tenancy_id, 'tenant', lo.name, 'unit', lt.code,
                                         'date', vd.payment_date::text, 'amount', vd.amount::text) ORDER BY vd.id)
       FROM deposit_payment vd JOIN tenancy s ON s.id = vd.tenancy_id JOIN unit lt ON lt.id = s.unit_id
       JOIN tenant lo ON lo.id = s.tenant_id WHERE vd.bank_transaction_id = m.id) AS deposits,
      ${COUVERT_SQL} AS covered,
      -- Recorded by hand before the statements: payments (credit) or works (debit) not linked yet, of the same amount,
      -- within ten days: to link rather than to type again
      -- (a transfer of several months typed as several payments: those of one tenant whose sum is the amount)
      CASE WHEN m.amount > 0 THEN coalesce(
        (SELECT json_agg(json_build_object('type', 'payment', 'id', p.id, 'tenant', lo.name, 'unit', lt.code,
                                           'month', p.month::text, 'date', p.payment_date::text) ORDER BY abs(p.payment_date - m.transaction_date))
         FROM payment p JOIN tenancy s ON s.id = p.tenancy_id JOIN unit lt ON lt.id = s.unit_id
         JOIN tenant lo ON lo.id = s.tenant_id
         WHERE p.bank_transaction_id IS NULL AND p.method IS DISTINCT FROM 'deposit' AND p.rent + p.charge_advance + p.charge_adjustment = m.amount
           AND abs(p.payment_date - m.transaction_date) <= 10),
        (SELECT json_agg(json_build_object('type', 'group', 'ids', g.ids, 'tenant', g.tenant, 'unit', g.unit, 'month', g.month))
         FROM (
           SELECT array_agg(p.id ORDER BY p.month) AS ids, lo.name AS tenant, lt.code AS unit,
                  string_agg(to_char(p.month, 'MM/YYYY'), ', ' ORDER BY p.month) AS month
           FROM payment p JOIN tenancy s ON s.id = p.tenancy_id JOIN unit lt ON lt.id = s.unit_id
           JOIN tenant lo ON lo.id = s.tenant_id
           WHERE p.bank_transaction_id IS NULL AND p.method IS DISTINCT FROM 'deposit' AND abs(p.payment_date - m.transaction_date) <= 10
           GROUP BY s.id, lo.name, lt.code
           HAVING count(*) > 1 AND sum(p.rent + p.charge_advance + p.charge_adjustment) = m.amount
         ) g))
      ELSE coalesce(
        nullif(coalesce(
          -- Works: an invoice whose unpaid rest is the amount
          (SELECT jsonb_agg(jsonb_build_object('type', 'works', 'id', t.id, 'description', t.description,
                                               'supplier', t.supplier, 'date', t.invoice_date::text))
           FROM works_invoice t
           WHERE t.total_incl_tax - (SELECT coalesce(sum(rt.amount), 0) FROM works_invoice_payment rt WHERE rt.works_invoice_id = t.id)
                 = -m.amount), '[]'::jsonb)
        -- Invoices of charges (ADR 0022): validated, not paid in full, whose rest is the amount or whose number is in
        -- the label (a part of the invoice paid by a transfer naming it)
        || coalesce(
          (SELECT jsonb_agg(jsonb_build_object('type', 'invoice', 'id', f.id, 'supplier', fo.name, 'number', f.number,
                                               'energy', f.energy, 'date', f.invoice_date::text, 'status', f.status)
                            ORDER BY abs(f.invoice_date - m.transaction_date))
           FROM invoice f JOIN supplier fo ON fo.id = f.supplier_id
           WHERE f.status IN ('validated', 'draft') AND f.total_incl_tax IS NOT NULL AND ${RESTE_FACTURE_SQL} > 0
             AND NOT EXISTS (SELECT 1 FROM invoice_payment rf WHERE rf.invoice_id = f.id AND rf.bank_transaction_id = m.id)
             AND (${RESTE_FACTURE_SQL} = -m.amount
                  OR (${NUMERO_LISIBLE_SQL} IS NOT NULL
                      AND regexp_replace(m.label || ' ' || coalesce(m.detail, ''), '\\D', '', 'g') LIKE '%' || ${NUMERO_LISIBLE_SQL} || '%'))),
          '[]'::jsonb), '[]'::jsonb)::json,
        -- A refund to a tenant (negative payment) typed by hand
        (SELECT json_agg(json_build_object('type', 'payment', 'id', p.id, 'tenant', lo.name, 'unit', lt.code,
                                           'month', p.month::text, 'date', p.payment_date::text))
         FROM payment p JOIN tenancy s ON s.id = p.tenancy_id JOIN unit lt ON lt.id = s.unit_id
         JOIN tenant lo ON lo.id = s.tenant_id
         WHERE p.bank_transaction_id IS NULL AND p.method IS DISTINCT FROM 'deposit' AND p.rent + p.charge_advance + p.charge_adjustment = m.amount
           AND abs(p.payment_date - m.transaction_date) <= 10))
      END AS candidates
  ) l ON true`

const releveRoutes: FastifyPluginAsync<{ db: Pool, storageDir: string }> = async (app, { db, storageDir }) => {
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1, fieldSize: 5 * 1024 * 1024 } })

  const mouvementsDe = async (releveId: number) => (await db.query(
    `SELECT ${MOUVEMENT_COLUMNS} FROM ${MOUVEMENT_FROM} WHERE m.bank_statement_id = $1 ORDER BY m.position`, [releveId])).rows

  async function load(id: number) {
    const { rows: [releve] } = await db.query(
      `SELECT ${RELEVE_COLUMNS} FROM bank_statement r JOIN supplier fo ON fo.id = r.supplier_id WHERE r.id = $1`, [id])
    return releve ? { ...releve, transactions: await mouvementsDe(id) } : null
  }

  // Every statement, the latest first; « suite » says whether its opening balance is the closing balance of the
  // previous statement of the account (false: a statement is missing in between)
  app.get('/releves', async () => {
    const { rows } = await db.query(
      `SELECT ${RELEVE_COLUMNS},
              (SELECT count(*)::int FROM bank_transaction m WHERE m.bank_statement_id = r.id) AS transaction_count,
              lag(r.new_balance) OVER (PARTITION BY r.account ORDER BY r.statement_date) AS previous
       FROM bank_statement r JOIN supplier fo ON fo.id = r.supplier_id
       ORDER BY r.statement_date DESC, r.account`,
    )
    return rows.map(({ previous, ...r }) => ({
      ...r, suite: previous === null ? null : new Big(previous).eq(r.previous_balance),
    }))
  })

  app.get('/releves/:id', async (request, reply) =>
    (await load(idParam(request))) ?? reply.code(404).send({ message: 'Relevé introuvable' }))

  app.get('/releves/:id/pdf', async (request, reply) => {
    const { rows: [r] } = await db.query<{ pdf_file: string | null }>(
      'SELECT pdf_file FROM bank_statement WHERE id = $1', [idParam(request)])
    if (!r?.pdf_file) {
      return reply.code(404).send({ message: 'Pas de PDF pour ce relevé' })
    }
    return reply.type('application/pdf').header('content-disposition', 'inline')
      .send(createReadStream(join(storageDir, r.pdf_file)))
  })

  // PDF and the statement read from it by an extractor, in the browser. Multipart: « file » and « releve » (JSON)
  app.post('/releves/import', async (request, reply) => {
    let content: Buffer | null = null
    let raw: Record<string, unknown> | null = null
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        content = await part.toBuffer()
      } else if (part.fieldname === 'bank_statement') {
        try {
          raw = JSON.parse(String(part.value))
        } catch {
          return reply.code(400).send({ message: '« bank_statement » doit être du JSON' })
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
    const { rows: [extractor] } = await db.query<{ supplier_id: number }>(
      'SELECT supplier_id FROM extractor WHERE id = $1 AND type = \'bank_statement\'', [r.extractor_id])
    if (!extractor) {
      return reply.code(400).send({ message: 'Extracteur de relevé inconnu' })
    }
    const { rows: [existant] } = await db.query<{ id: number }>(
      'SELECT id FROM bank_statement WHERE account = $1 AND statement_date = $2', [r.account, r.statement_date])
    if (existant) {
      return reply.code(409).send({ message: `Relevé du ${r.statement_date} du compte ${r.account} déjà importé`, bank_statement_id: existant.id })
    }
    const { fileName } = await storePdf(storageDir, content, 'releves')
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const { rows: [created] } = await client.query<{ id: number }>(
        `INSERT INTO bank_statement (supplier_id, account, statement_date, previous_balance, new_balance, pdf_file, extractor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [extractor.supplier_id, r.account, r.statement_date, r.previous_balance, r.new_balance, fileName, r.extractor_id],
      )
      for (const [position, m] of r.transactions.entries()) {
        await client.query(
          `INSERT INTO bank_transaction (bank_statement_id, position, transaction_date, value_date, label, detail, amount)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [created!.id, position, m.transaction_date, m.value_date, m.label, m.detail, m.amount],
        )
      }
      await client.query('COMMIT')
      return reply.code(201).send(await load(created!.id))
    } catch (error) {
      await client.query('ROLLBACK')
      await removeIfUnused(db, storageDir, fileName)
      if ((error as { code?: string }).code === '23505') {
        return reply.code(409).send({ message: `Relevé du ${r.statement_date} du compte ${r.account} déjà importé` })
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
      `SELECT 1 FROM bank_transaction m WHERE m.bank_statement_id = $1 AND (m.category IS NOT NULL
         OR EXISTS (SELECT 1 FROM payment p WHERE p.bank_transaction_id = m.id)
         OR EXISTS (SELECT 1 FROM works_invoice_payment rt WHERE rt.bank_transaction_id = m.id)
         OR EXISTS (SELECT 1 FROM invoice_payment rf WHERE rf.bank_transaction_id = m.id)
         OR EXISTS (SELECT 1 FROM deposit_payment vd WHERE vd.bank_transaction_id = m.id))`,
      [id],
    )
    if (lie) {
      return reply.code(409).send({ message: 'Des mouvements de ce relevé sont catégorisés : le relevé est gardé' })
    }
    const { rows: [deleted] } = await db.query<{ pdf_file: string | null }>(
      'DELETE FROM bank_statement WHERE id = $1 RETURNING pdf_file', [id])
    if (!deleted) {
      return reply.code(404).send({ message: 'Relevé introuvable' })
    }
    if (deleted.pdf_file) {
      await removeIfUnused(db, storageDir, deleted.pdf_file)
    }
    return reply.code(204).send()
  })

  // ---------------------------------------------------------------- movements

  // Movements, the oldest first: all, or by state (to_categorise, incomplet, categorise), of a category
  app.get('/mouvements', async (request, reply) => {
    const q = query(request)
    const status = q.status ?? 'tous'
    if (!['tous', 'to_categorise', 'incomplet', 'categorise'].includes(status)) {
      return reply.code(400).send({ message: 'Statut : tous, to_categorise, incomplet ou categorise' })
    }
    if (q.category && !estCategorie(q.category)) {
      return reply.code(400).send({ message: 'Catégorie inconnue' })
    }
    const { rows } = await db.query(
      `SELECT * FROM (SELECT ${MOUVEMENT_COLUMNS} FROM ${MOUVEMENT_FROM}) x
       WHERE ($1 = 'tous' OR status = $1) AND ($4::text IS NULL OR category = $4)
         AND ($2::date IS NULL OR transaction_date::date >= $2::date) AND ($3::date IS NULL OR transaction_date::date <= $3::date)
       ORDER BY transaction_date, bank_statement_id, position`,
      [status, q.du || null, q.au || null, q.category || null],
    )
    return rows
  })

  const loadMouvement = async (id: number) => (await db.query(
    `SELECT ${MOUVEMENT_COLUMNS} FROM ${MOUVEMENT_FROM} WHERE m.id = $1`, [id])).rows[0] ?? null

  /** Its links: payments, works payments, invoice payments, deposits. */
  async function liens(id: number) {
    const { rows: [l] } = await db.query<{ payments: number, works_invoice: number, invoices: number, deposits: number }>(
      `SELECT (SELECT count(*)::int FROM payment WHERE bank_transaction_id = $1) AS payments,
              (SELECT count(*)::int FROM works_invoice_payment WHERE bank_transaction_id = $1) AS works_invoice,
              (SELECT count(*)::int FROM invoice_payment WHERE bank_transaction_id = $1) AS invoices,
              (SELECT count(*)::int FROM deposit_payment WHERE bank_transaction_id = $1) AS deposits`, [id])
    return l!
  }

  /** The categories a movement may have with its links: payments, works, invoices or deposits keep theirs. */
  function categoriesPermises(l: { payments: number, works_invoice: number, invoices: number, deposits: number }): Categorie[] | null {
    if (l.works_invoice) {
      return ['works']
    }
    if (l.invoices) {
      return AVEC_FACTURE
    }
    if (l.payments) {
      return ['tenant']
    }
    return l.deposits ? ['tenant', 'security_deposit'] : null
  }

  // The category of a movement, and a note (required for « autre »; a comment only, it never completes a detail). A
  // movement with a detail linked stays in a category that has it.
  app.put('/mouvements/:id/categorie', async (request, reply) => {
    const id = idParam(request)
    try {
      const raw = body(request)
      if (!estCategorie(raw.category)) {
        throw new InputError('Catégorie inconnue')
      }
      const note = optionalText(raw.note)
      if (raw.category === 'other' && !note) {
        throw new InputError('« Autre » : préciser ce qu\'est ce mouvement dans la note')
      }
      const permises = categoriesPermises(await liens(id))
      if (permises && !permises.includes(raw.category)) {
        return reply.code(409).send({ message: 'Des paiements, des factures ou des dépôts y sont rattachés : les détacher d\'abord' })
      }
      const { rowCount } = await db.query('UPDATE bank_transaction SET category = $2, note = $3 WHERE id = $1', [id, raw.category, note])
      return rowCount ? loadMouvement(id) : reply.code(404).send({ message: 'Mouvement introuvable' })
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.delete('/mouvements/:id/categorie', async (request, reply) => {
    const id = idParam(request)
    if (categoriesPermises(await liens(id))) {
      return reply.code(409).send({ message: 'Des paiements, des factures ou des dépôts y sont rattachés : les détacher d\'abord' })
    }
    const { rowCount } = await db.query('UPDATE bank_transaction SET category = NULL, note = NULL WHERE id = $1', [id])
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
      const amount = new Big(m.amount)
      const resteMouvement = amount.abs().minus(m.covered)
      if (raw.payment_ids !== undefined || raw.payment_id) {
        // One payment, or several at once (a transfer of several months)
        const ids = Array.isArray(raw.payment_ids) ? raw.payment_ids.map((x) => requiredId(x, 'Paiement')) : [requiredId(raw.payment_id, 'Paiement')]
        const { rows } = await db.query<{ id: number, bank_transaction_id: number | null, total: string, method: string | null }>(
          'SELECT id, bank_transaction_id, (rent + charge_advance + charge_adjustment)::text AS total, method FROM payment WHERE id = ANY($1)', [ids])
        if (rows.length !== ids.length) {
          return reply.code(404).send({ message: 'Paiement introuvable' })
        }
        // A retention on the deposit (ADR 0021) is seen on no statement
        if (rows.some((p) => p.method === 'deposit')) {
          throw new InputError('Une retenue sur le dépôt de garantie ne passe pas par la banque')
        }
        if (rows.some((p) => p.bank_transaction_id !== null && p.bank_transaction_id !== id)) {
          throw new InputError('Un de ces paiements est déjà rattaché à un autre mouvement')
        }
        // Payments chosen by hand may exceed the transfer: an agency pays the rents it collected less its fees, a rent
        // paid by two transfers is linked to one of them; only the category and the sign are checked
        await verifierMouvement(db, id, {
          categories: ['tenant'], signe: amount.gt(0) ? 1 : -1, amount: new Big(0), detail: 'payment', exclure: null,
        })
        await db.query('UPDATE payment SET bank_transaction_id = $2 WHERE id = ANY($1)', [ids, id])
        await categoriserSiVide(db, id, 'tenant')
        return loadMouvement(id)
      }
      if (raw.works_invoice_id) {
        // A payment of the invoice by this movement: what remains of the movement, no more than what remains of the
        // invoice (a transfer paying two invoices is linked to both)
        const travauxId = requiredId(raw.works_invoice_id, 'Travaux')
        const { rows: [t] } = await db.query<{ remaining: string }>(
          `SELECT (t.total_incl_tax - (SELECT coalesce(sum(amount), 0) FROM works_invoice_payment WHERE works_invoice_id = t.id))::text AS remaining
           FROM works_invoice t WHERE t.id = $1`, [travauxId])
        if (!t) {
          return reply.code(404).send({ message: 'Travaux introuvables' })
        }
        const montantReglement = resteMouvement.lt(t.remaining) ? resteMouvement : new Big(t.remaining)
        if (!montantReglement.gt(0)) {
          throw new InputError(new Big(t.remaining).gt(0) ? 'Ce mouvement est déjà rattaché en entier' : 'Cette facture est déjà réglée en entier')
        }
        await verifierMouvement(db, id, {
          categories: ['works'], signe: -1, amount: montantReglement, detail: 'works_invoice_payment', exclure: null,
        })
        await db.query(
          `INSERT INTO works_invoice_payment (works_invoice_id, bank_transaction_id, amount) VALUES ($1, $2, $3)
           ON CONFLICT (works_invoice_id, bank_transaction_id) DO UPDATE SET amount = works_invoice_payment.amount + excluded.amount`,
          [travauxId, id, montantReglement.toString()])
        await categoriserSiVide(db, id, 'works')
        return loadMouvement(id)
      }
      if (raw.invoice_id) {
        await reglerFacture(db, requiredId(raw.invoice_id, 'Facture'), id)
        return loadMouvement(id)
      }
      if (raw.deposit_payment_id) {
        const depotId = requiredId(raw.deposit_payment_id, 'Versement de dépôt')
        const { rows: [d] } = await db.query<{ amount: string, bank_transaction_id: number | null }>(
          'SELECT amount::text, bank_transaction_id FROM deposit_payment WHERE id = $1', [depotId])
        if (!d) {
          return reply.code(404).send({ message: 'Versement introuvable' })
        }
        if (d.bank_transaction_id !== null && d.bank_transaction_id !== id) {
          throw new InputError('Déjà rattaché à un autre mouvement')
        }
        await verifierMouvement(db, id, {
          categories: ['tenant', 'security_deposit'], signe: new Big(d.amount).gt(0) ? 1 : -1, amount: new Big(d.amount),
          detail: 'deposit_payment', exclure: depotId,
        })
        await db.query('UPDATE deposit_payment SET bank_transaction_id = $2 WHERE id = $1', [depotId, id])
        await categoriserSiVide(db, id, 'security_deposit')
        return loadMouvement(id)
      }
      throw new InputError('Indiquer le paiement, les travaux, la facture ou le versement de dépôt à rattacher')
    } catch (error) {
      if (error instanceof IntrouvableError) {
        return reply.code(404).send({ message: error.message })
      }
      return sendError(reply, error)
    }
  })

  // Detaches: the payment or the deposit stays, in its screen; a payment of works or of an invoice is the movement
  // itself, it goes
  app.post('/mouvements/:id/delier', async (request, reply) => {
    const id = idParam(request)
    const raw = body(request)
    if (raw.payment_id) {
      await db.query('UPDATE payment SET bank_transaction_id = NULL WHERE id = $1 AND bank_transaction_id = $2', [Number(raw.payment_id), id])
    } else if (raw.works_invoice_payment_id) {
      await db.query('DELETE FROM works_invoice_payment WHERE id = $1 AND bank_transaction_id = $2', [Number(raw.works_invoice_payment_id), id])
    } else if (raw.works_invoice_id) {
      await db.query('DELETE FROM works_invoice_payment WHERE works_invoice_id = $1 AND bank_transaction_id = $2', [Number(raw.works_invoice_id), id])
    } else if (raw.invoice_payment_id) {
      await db.query('DELETE FROM invoice_payment WHERE id = $1 AND bank_transaction_id = $2', [Number(raw.invoice_payment_id), id])
    } else if (raw.deposit_payment_id) {
      await db.query('UPDATE deposit_payment SET bank_transaction_id = NULL WHERE id = $1 AND bank_transaction_id = $2', [Number(raw.deposit_payment_id), id])
    }
    return (await loadMouvement(id)) ?? reply.code(404).send({ message: 'Mouvement introuvable' })
  })
}

export default releveRoutes

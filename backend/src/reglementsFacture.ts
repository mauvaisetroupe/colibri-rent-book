import Big from 'big.js'
import type { Pool, PoolClient } from 'pg'

import { AVEC_FACTURE, categorieDeFacture } from './categories.js'
import { COUVERT_SQL, categoriserSiVide, verifierMouvement } from './couverture.js'
import { InputError } from './http.js'

// Payments of invoices of charges by bank movements (ADR 0022): a validated invoice, or a draft whose total is known
// (an invoice still to find, typed from the transfer, ADR 0022), a debit « energie », « eau » or
// « impots » (or without category, given that of the invoice), an amount; a credit refunding the invoice (monthly
// payments above the yearly invoice) is a negative payment. Linked from the movement (Banque) or from the invoice; when
// an invoice is replaced, its payments go to the one replacing it.

/** SQL: what remains to pay of the invoice « f » (its total less its payments). */
export const RESTE_FACTURE_SQL = `(coalesce(f.total_incl_tax, 0)
  - (SELECT coalesce(sum(rf.amount), 0) FROM invoice_payment rf WHERE rf.invoice_id = f.id))`

/**
 * SQL: the number of the invoice « f » as it may be read in a bank label: its last group of at least five digits
 * (« 2030-XY-00-12345 » → « 12345 »), null when it has none.
 */
export const NUMERO_LISIBLE_SQL = `substring(f.number from '(\\d{5,})\\D*$')`

/** A debit may pay up to this much more than the invoice (a balance rounded by the supplier): shown as a gap. */
export const ECART_REGLEMENT = '1.00'

export class IntrouvableError extends Error {}

/**
 * A payment of the invoice by the movement: for a debit, what remains of the movement, no more than what remains of the
 * invoice (a debit paying two invoices is linked to both); for a credit, a refund: what remains of it, as a negative
 * payment (the invoice then has that much more to pay, the monthly payments that exceeded it). A second link of the same
 * pair adds to the first.
 */
export async function reglerFacture(db: Pool | PoolClient, factureId: number, mouvementId: number) {
  const { rows: [f] } = await db.query<{ status: string, energy: string, remaining: string, total_incl_tax: string | null }>(
    `SELECT f.status, f.energy, f.total_incl_tax::text, ${RESTE_FACTURE_SQL}::text AS remaining FROM invoice f WHERE f.id = $1`,
    [factureId])
  if (!f) {
    throw new IntrouvableError('Facture introuvable')
  }
  if (f.status === 'replaced') {
    throw new InputError('Facture remplacée : régler celle qui la remplace')
  }
  // A draft counts in no statement: linking it only says what the transfer pays; its total must be known
  if (f.total_incl_tax === null) {
    throw new InputError('Saisir d\'abord le total imprimé du brouillon (ce qu\'il reste à payer est inconnu)')
  }
  const { rows: [m] } = await db.query<{ amount: string, covered: string }>(
    `SELECT m.amount::text, ${COUVERT_SQL}::text AS covered FROM bank_transaction m WHERE m.id = $1`, [mouvementId])
  if (!m) {
    throw new IntrouvableError('Mouvement introuvable')
  }
  const resteMouvement = new Big(m.amount).abs().minus(m.covered)
  const credit = new Big(m.amount).gt(0)
  if (credit && !resteMouvement.gt(0)) {
    throw new InputError('Ce mouvement est déjà rattaché en entier')
  }
  // A debit pays what remains of the invoice; all of what remains of it when that is at most ECART_REGLEMENT more (the
  // gap is shown on the invoice and in the checks)
  const amount = credit ? resteMouvement.times(-1)
    : resteMouvement.minus(f.remaining).lte(ECART_REGLEMENT) ? resteMouvement : new Big(f.remaining)
  if (!credit && !amount.gt(0)) {
    throw new InputError(new Big(f.remaining).gt(0) ? 'Ce mouvement est déjà rattaché en entier' : 'Cette facture est déjà réglée en entier')
  }
  await verifierMouvement(db, mouvementId, {
    categories: AVEC_FACTURE, signe: credit ? 1 : -1, amount, detail: 'invoice_payment', exclure: null,
  })
  await db.query(
    `INSERT INTO invoice_payment (invoice_id, bank_transaction_id, amount) VALUES ($1, $2, $3)
     ON CONFLICT (invoice_id, bank_transaction_id) DO UPDATE SET amount = invoice_payment.amount + excluded.amount`,
    [factureId, mouvementId, amount.toString()])
  await categoriserSiVide(db, mouvementId, categorieDeFacture(f.energy))
}

/** The payments of a replaced invoice go to the one replacing it (in the transaction of the replacement). */
export async function transfererReglements(client: PoolClient, ancienne: number, nouvelle: number) {
  await client.query(
    `INSERT INTO invoice_payment (invoice_id, bank_transaction_id, amount)
     SELECT $2, bank_transaction_id, amount FROM invoice_payment WHERE invoice_id = $1
     ON CONFLICT (invoice_id, bank_transaction_id) DO UPDATE SET amount = invoice_payment.amount + excluded.amount`,
    [ancienne, nouvelle])
  await client.query('DELETE FROM invoice_payment WHERE invoice_id = $1', [ancienne])
}

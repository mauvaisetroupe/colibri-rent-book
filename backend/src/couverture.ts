import Big from 'big.js'
import type { Pool, PoolClient } from 'pg'

import type { Categorie } from './categories.js'
import { InputError } from './http.js'

// What the detail of a bank movement covers (ADR 0018, 0019, 0022): the payments of tenants (a refund is negative), the
// payments of works invoices and of invoices of charges, the deposits paid or refunded. Linked on their side (mouvement_id); together they never
// exceed the amount of the movement; until they cover it, the movement is « incomplet ».

export type Detail = 'payment' | 'works_invoice_payment' | 'invoice_payment' | 'deposit_payment'

/** SQL: the amount covered by the detail of the movement « m », as a positive number. */
export const COUVERT_SQL = `(
  abs((SELECT coalesce(sum(p.rent + p.charge_advance + p.charge_adjustment), 0) FROM payment p WHERE p.bank_transaction_id = m.id))
  + (SELECT coalesce(sum(rt.amount), 0) FROM works_invoice_payment rt WHERE rt.bank_transaction_id = m.id)
  + abs((SELECT coalesce(sum(rf.amount), 0) FROM invoice_payment rf WHERE rf.bank_transaction_id = m.id))
  + abs((SELECT coalesce(sum(vd.amount), 0) FROM deposit_payment vd WHERE vd.bank_transaction_id = m.id)))`

/**
 * A row of detail linked to a movement: the movement exists, is of one of the categories given (or has none yet), of
 * the sign expected, and the detail stays within its amount. « exclure »: the row being changed, not counted twice.
 */
export async function verifierMouvement(db: Pool | PoolClient, mouvementId: number, o: {
  categories: Categorie[], signe: 1 | -1, amount: Big, detail: Detail, exclure: number | null
}) {
  const { rows: [m] } = await db.query<{ amount: string, category: string | null, covered: string }>(
    `SELECT m.amount::text, m.category, (
       abs((SELECT coalesce(sum(rent + charge_advance + charge_adjustment), 0) FROM payment
            WHERE bank_transaction_id = m.id AND NOT ($2 = 'paiement' AND id = $3)))
       + (SELECT coalesce(sum(amount), 0) FROM works_invoice_payment
          WHERE bank_transaction_id = m.id AND NOT ($2 = 'works_invoice_payment' AND id = $3))
       + abs((SELECT coalesce(sum(amount), 0) FROM invoice_payment
              WHERE bank_transaction_id = m.id AND NOT ($2 = 'invoice_payment' AND id = $3)))
       + abs((SELECT coalesce(sum(amount), 0) FROM deposit_payment
              WHERE bank_transaction_id = m.id AND NOT ($2 = 'deposit_payment' AND id = $3))))::text AS covered
     FROM bank_transaction m WHERE m.id = $1`,
    [mouvementId, o.detail, o.exclure ?? 0],
  )
  if (!m) {
    throw new InputError('Mouvement bancaire introuvable')
  }
  if (m.category && !(o.categories as string[]).includes(m.category)) {
    throw new InputError('Ce mouvement a une autre catégorie : la retirer d\'abord')
  }
  const amount = new Big(m.amount)
  if (amount.gt(0) !== (o.signe > 0)) {
    throw new InputError(o.detail === 'works_invoice_payment' ? 'Des travaux se rattachent à un débit du relevé'
      : o.detail === 'invoice_payment' ? 'Une facture se règle par un débit, ou se rembourse par un crédit'
      : o.signe > 0 ? 'Un versement reçu se rattache à un crédit du relevé'
        : 'Un débit du relevé ne porte qu\'un remboursement au locataire (montant négatif)')
  }
  const total = new Big(m.covered).plus(o.amount.abs())
  if (total.gt(amount.abs())) {
    throw new InputError(`Le détail rattaché (${total.toFixed(2)}) dépasserait le montant du mouvement (${amount.abs().toFixed(2)})`)
  }
}

/** A detail linked to a movement without category gives it its category. */
export const categoriserSiVide = (db: Pool | PoolClient, mouvementId: number | null, category: Categorie) => (mouvementId
  ? db.query('UPDATE bank_transaction SET category = $2 WHERE id = $1 AND category IS NULL', [mouvementId, category])
  : Promise.resolve())

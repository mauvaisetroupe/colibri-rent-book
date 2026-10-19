import Big from 'big.js'
import type { Pool, PoolClient } from 'pg'

import type { Categorie } from './categories.js'
import { InputError } from './http.js'

// What the detail of a bank movement covers (ADR 0018, 0019): the payments of tenants (a refund is negative), the
// payments of works invoices, the deposits paid or refunded. Linked on their side (mouvement_id); together they never
// exceed the amount of the movement; until they cover it, the movement is « incomplet ».

export type Detail = 'paiement' | 'reglement_travaux' | 'versement_depot'

/** SQL: the amount covered by the detail of the movement « m », as a positive number. */
export const COUVERT_SQL = `(
  abs((SELECT coalesce(sum(p.loyer + p.provision + p.regularisation), 0) FROM paiement p WHERE p.mouvement_id = m.id))
  + (SELECT coalesce(sum(rt.montant), 0) FROM reglement_travaux rt WHERE rt.mouvement_id = m.id)
  + abs((SELECT coalesce(sum(vd.montant), 0) FROM versement_depot vd WHERE vd.mouvement_id = m.id)))`

/**
 * A row of detail linked to a movement: the movement exists, is of one of the categories given (or has none yet), of
 * the sign expected, and the detail stays within its amount. « exclure »: the row being changed, not counted twice.
 */
export async function verifierMouvement(db: Pool | PoolClient, mouvementId: number, o: {
  categories: Categorie[], signe: 1 | -1, montant: Big, detail: Detail, exclure: number | null
}) {
  const { rows: [m] } = await db.query<{ montant: string, categorie: string | null, couvert: string }>(
    `SELECT m.montant::text, m.categorie, (
       abs((SELECT coalesce(sum(loyer + provision + regularisation), 0) FROM paiement
            WHERE mouvement_id = m.id AND NOT ($2 = 'paiement' AND id = $3)))
       + (SELECT coalesce(sum(montant), 0) FROM reglement_travaux
          WHERE mouvement_id = m.id AND NOT ($2 = 'reglement_travaux' AND id = $3))
       + abs((SELECT coalesce(sum(montant), 0) FROM versement_depot
              WHERE mouvement_id = m.id AND NOT ($2 = 'versement_depot' AND id = $3))))::text AS couvert
     FROM mouvement m WHERE m.id = $1`,
    [mouvementId, o.detail, o.exclure ?? 0],
  )
  if (!m) {
    throw new InputError('Mouvement bancaire introuvable')
  }
  if (m.categorie && !(o.categories as string[]).includes(m.categorie)) {
    throw new InputError('Ce mouvement a une autre catégorie : la retirer d\'abord')
  }
  const montant = new Big(m.montant)
  if (montant.gt(0) !== (o.signe > 0)) {
    throw new InputError(o.detail === 'reglement_travaux' ? 'Des travaux se rattachent à un débit du relevé'
      : o.signe > 0 ? 'Un versement reçu se rattache à un crédit du relevé'
        : 'Un débit du relevé ne porte qu\'un remboursement au locataire (montant négatif)')
  }
  const total = new Big(m.couvert).plus(o.montant.abs())
  if (total.gt(montant.abs())) {
    throw new InputError(`Le détail rattaché (${total.toFixed(2)}) dépasserait le montant du mouvement (${montant.abs().toFixed(2)})`)
  }
}

/** A detail linked to a movement without category gives it its category. */
export const categoriserSiVide = (db: Pool | PoolClient, mouvementId: number | null, categorie: Categorie) => (mouvementId
  ? db.query('UPDATE mouvement SET categorie = $2 WHERE id = $1 AND categorie IS NULL', [mouvementId, categorie])
  : Promise.resolve())

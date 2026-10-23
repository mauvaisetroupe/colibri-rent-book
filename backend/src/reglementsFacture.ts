import Big from 'big.js'
import type { Pool, PoolClient } from 'pg'

import { AVEC_FACTURE, categorieDeFacture } from './categories.js'
import { COUVERT_SQL, categoriserSiVide, verifierMouvement } from './couverture.js'
import { InputError } from './http.js'

// Payments of invoices of charges by bank movements (ADR 0022): a validated invoice, a debit « energie », « eau » or
// « impots » (or without category, given that of the invoice), an amount; a credit refunding the invoice (monthly
// payments above the yearly invoice) is a negative payment. Linked from the movement (Banque) or from the invoice; when
// an invoice is replaced, its payments go to the one replacing it.

/** SQL: what remains to pay of the invoice « f » (its total less its payments). */
export const RESTE_FACTURE_SQL = `(coalesce(f.montant_ttc, 0)
  - (SELECT coalesce(sum(rf.montant), 0) FROM reglement_facture rf WHERE rf.facture_id = f.id))`

/**
 * SQL: the number of the invoice « f » as it may be read in a bank label: its last group of at least five digits
 * (« 2030-XY-00-12345 » → « 12345 »), null when it has none.
 */
export const NUMERO_LISIBLE_SQL = `substring(f.numero from '(\\d{5,})\\D*$')`

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
  const { rows: [f] } = await db.query<{ statut: string, energie: string, reste: string }>(
    `SELECT f.statut, f.energie, ${RESTE_FACTURE_SQL}::text AS reste FROM facture f WHERE f.id = $1`, [factureId])
  if (!f) {
    throw new IntrouvableError('Facture introuvable')
  }
  if (f.statut !== 'validee') {
    throw new InputError(f.statut === 'remplacee' ? 'Facture remplacée : régler celle qui la remplace'
      : 'Seule une facture validée se règle')
  }
  const { rows: [m] } = await db.query<{ montant: string, couvert: string }>(
    `SELECT m.montant::text, ${COUVERT_SQL}::text AS couvert FROM mouvement m WHERE m.id = $1`, [mouvementId])
  if (!m) {
    throw new IntrouvableError('Mouvement introuvable')
  }
  const resteMouvement = new Big(m.montant).abs().minus(m.couvert)
  const credit = new Big(m.montant).gt(0)
  if (credit && !resteMouvement.gt(0)) {
    throw new InputError('Ce mouvement est déjà rattaché en entier')
  }
  // A debit pays what remains of the invoice; all of what remains of it when that is at most ECART_REGLEMENT more (the
  // gap is shown on the invoice and in the checks)
  const montant = credit ? resteMouvement.times(-1)
    : resteMouvement.minus(f.reste).lte(ECART_REGLEMENT) ? resteMouvement : new Big(f.reste)
  if (!credit && !montant.gt(0)) {
    throw new InputError(new Big(f.reste).gt(0) ? 'Ce mouvement est déjà rattaché en entier' : 'Cette facture est déjà réglée en entier')
  }
  await verifierMouvement(db, mouvementId, {
    categories: AVEC_FACTURE, signe: credit ? 1 : -1, montant, detail: 'reglement_facture', exclure: null,
  })
  await db.query(
    `INSERT INTO reglement_facture (facture_id, mouvement_id, montant) VALUES ($1, $2, $3)
     ON CONFLICT (facture_id, mouvement_id) DO UPDATE SET montant = reglement_facture.montant + excluded.montant`,
    [factureId, mouvementId, montant.toString()])
  await categoriserSiVide(db, mouvementId, categorieDeFacture(f.energie))
}

/** The payments of a replaced invoice go to the one replacing it (in the transaction of the replacement). */
export async function transfererReglements(client: PoolClient, ancienne: number, nouvelle: number) {
  await client.query(
    `INSERT INTO reglement_facture (facture_id, mouvement_id, montant)
     SELECT $2, mouvement_id, montant FROM reglement_facture WHERE facture_id = $1
     ON CONFLICT (facture_id, mouvement_id) DO UPDATE SET montant = reglement_facture.montant + excluded.montant`,
    [ancienne, nouvelle])
  await client.query('DELETE FROM reglement_facture WHERE facture_id = $1', [ancienne])
}

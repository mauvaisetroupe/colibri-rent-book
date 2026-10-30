import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Pool, PoolClient } from 'pg'

import type { Annexe } from './justificatifPdf.js'

// Invoices joined to a supporting document (ADR 0024): never as received, only their version in images, redacted in
// the browser and verified by eye. A sent regularisation keeps the versions it joined (regularisation.annexes_envoyees).

/** What becomes of an invoice in the annexes, from its supplier, its PDF and its current version in images. */
export type EtatAnnexe = 'confidentiel' | 'sans_pdf' | 'a_faire' | 'a_verifier' | 'verifiee'

/** SQL of the state of the annex of invoice `f` (supplier `fo`). */
export const ETAT_ANNEXE_SQL = `CASE
  WHEN fo.confidentiel THEN 'confidentiel'
  WHEN f.fichier_pdf IS NULL THEN 'sans_pdf'
  ELSE coalesce((SELECT CASE WHEN a.source_pdf <> f.fichier_pdf THEN 'a_faire'
                             WHEN a.verifiee_le IS NULL THEN 'a_verifier'
                             ELSE 'verifiee' END
                 FROM facture_annexe a WHERE a.id = f.annexe_id), 'a_faire')
END`

/** Invoice id → id of its current verified version in images, for the invoices that have one (frozen at sending). */
export async function annexesVerifiees(db: Pool | PoolClient, factureIds: number[]): Promise<Record<string, number>> {
  const { rows } = await db.query<{ id: number, annexe_id: number }>(
    `SELECT f.id, f.annexe_id FROM facture f JOIN fournisseur fo ON fo.id = f.fournisseur_id
     WHERE f.id = ANY($1) AND ${ETAT_ANNEXE_SQL} = 'verifiee'`,
    [factureIds],
  )
  return Object.fromEntries(rows.map((r) => [String(r.id), r.annexe_id]))
}

/** State of the annex of each invoice, with what names it (« EDF n° 123 »). */
export async function etatsAnnexes(db: Pool, factureIds: number[]) {
  const { rows } = await db.query<{ facture_id: number, fournisseur: string, numero: string, etat: EtatAnnexe }>(
    `SELECT f.id AS facture_id, fo.nom AS fournisseur, f.numero, ${ETAT_ANNEXE_SQL} AS etat
     FROM facture f JOIN fournisseur fo ON fo.id = f.fournisseur_id WHERE f.id = ANY($1) ORDER BY f.id`,
    [factureIds],
  )
  return rows
}

/**
 * The PDFs joined for these invoices. `envoyees`: the versions joined when the regularisation was sent (an invoice
 * not in it was not joined then); null: not sent, or sent before ADR 0024, the current verified versions.
 */
export async function annexesJointes(
  db: Pool, storageDir: string, factureIds: number[], envoyees: Record<string, number> | null,
): Promise<Annexe[]> {
  const { rows } = await db.query<{ id: number, etat: EtatAnnexe, courante: string | null }>(
    `SELECT f.id, ${ETAT_ANNEXE_SQL} AS etat, a.fichier_pdf AS courante
     FROM facture f JOIN fournisseur fo ON fo.id = f.fournisseur_id LEFT JOIN facture_annexe a ON a.id = f.annexe_id
     WHERE f.id = ANY($1)`,
    [factureIds],
  )
  const ids = envoyees ? Object.values(envoyees) : []
  const { rows: figees } = await db.query<{ id: number, fichier_pdf: string }>(
    'SELECT id, fichier_pdf FROM facture_annexe WHERE id = ANY($1)', [ids])
  const fichiers = new Map(figees.map((a) => [a.id, a.fichier_pdf]))

  return Promise.all(rows.map(async (f): Promise<Annexe> => {
    if (f.etat === 'confidentiel' || f.etat === 'sans_pdf') {
      return { facture_id: f.id, pdf: null, raison: f.etat }
    }
    const envoyee = envoyees?.[String(f.id)]
    const fichier = envoyees
      ? (envoyee === undefined ? null : fichiers.get(envoyee) ?? null)
      : (f.etat === 'verifiee' ? f.courante : null)
    if (!fichier) {
      return { facture_id: f.id, pdf: null, raison: 'non_verifiee' }
    }
    const pdf = await readFile(join(storageDir, fichier)).catch(() => null)
    return { facture_id: f.id, pdf, raison: pdf ? null : 'illisible' }
  }))
}

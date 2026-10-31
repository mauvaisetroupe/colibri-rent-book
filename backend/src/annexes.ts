import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Pool, PoolClient } from 'pg'

import { InputError } from './http.js'
import type { Annexe } from './justificatifPdf.js'

// Invoices joined to a supporting document (ADR 0024): never as received, only their version in images, redacted in
// the browser and verified by eye. A sent regularisation keeps the versions it joined (regularisation.annexes_envoyees).

/** What becomes of an invoice in the annexes, from its supplier, its PDF and its current version in images. */
export type EtatAnnexe = 'confidential' | 'no_pdf' | 'to_make' | 'to_check' | 'checked'

/** A zone drawn by hand on a scanned page (ADR 0025): page from 1, bounds in fractions of the page from its top-left. */
export type ZoneSaisie = { page: number, x0: number, y0: number, x1: number, y1: number }

/** The zones of a supplier or of an invoice, as sent: a list of rectangles inside the page; an InputError else. */
export function zonesSaisies(valeur: unknown): ZoneSaisie[] {
  if (!Array.isArray(valeur)) {
    throw new InputError('« zones » : une liste attendue')
  }
  return valeur.map((z: Record<string, unknown> | null, i) => {
    const { page, x0, y0, x1, y1 } = z ?? {}
    const bornes = [x0, y0, x1, y1]
    if (!Number.isInteger(page) || (page as number) < 1 || !bornes.every((v) => typeof v === 'number' && v >= 0 && v <= 1)
      || (x0 as number) >= (x1 as number) || (y0 as number) >= (y1 as number)) {
      throw new InputError(`Zone ${i + 1} invalide : page à partir de 1, bornes de 0 à 1, x0 < x1 et y0 < y1`)
    }
    return { page, x0, y0, x1, y1 } as ZoneSaisie
  })
}

/** SQL of the state of the annex of invoice `f` (supplier `fo`). */
export const ETAT_ANNEXE_SQL = `CASE
  WHEN fo.confidential THEN 'confidential'
  WHEN f.pdf_file IS NULL THEN 'no_pdf'
  ELSE coalesce((SELECT CASE WHEN a.source_pdf <> f.pdf_file THEN 'to_make'
                             WHEN a.checked_at IS NULL THEN 'to_check'
                             ELSE 'checked' END
                 FROM invoice_tenant_copy a WHERE a.id = f.tenant_copy_id), 'to_make')
END`

/** Invoice id → id of its current verified version in images, for the invoices that have one (frozen at sending). */
export async function annexesVerifiees(db: Pool | PoolClient, factureIds: number[]): Promise<Record<string, number>> {
  const { rows } = await db.query<{ id: number, tenant_copy_id: number }>(
    `SELECT f.id, f.tenant_copy_id FROM invoice f JOIN supplier fo ON fo.id = f.supplier_id
     WHERE f.id = ANY($1) AND ${ETAT_ANNEXE_SQL} = 'checked'`,
    [factureIds],
  )
  return Object.fromEntries(rows.map((r) => [String(r.id), r.tenant_copy_id]))
}

/** State of the annex of each invoice, with what names it (« EDF n° 123 »). */
export async function etatsAnnexes(db: Pool, factureIds: number[]) {
  const { rows } = await db.query<{ invoice_id: number, supplier: string, number: string, state: EtatAnnexe }>(
    `SELECT f.id AS invoice_id, fo.name AS supplier, f.number, ${ETAT_ANNEXE_SQL} AS state
     FROM invoice f JOIN supplier fo ON fo.id = f.supplier_id WHERE f.id = ANY($1) ORDER BY f.id`,
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
  const { rows } = await db.query<{ id: number, state: EtatAnnexe, current: string | null }>(
    `SELECT f.id, ${ETAT_ANNEXE_SQL} AS state, a.pdf_file AS current
     FROM invoice f JOIN supplier fo ON fo.id = f.supplier_id LEFT JOIN invoice_tenant_copy a ON a.id = f.tenant_copy_id
     WHERE f.id = ANY($1)`,
    [factureIds],
  )
  const ids = envoyees ? Object.values(envoyees) : []
  const { rows: frozen } = await db.query<{ id: number, pdf_file: string }>(
    'SELECT id, pdf_file FROM invoice_tenant_copy WHERE id = ANY($1)', [ids])
  const fichiers = new Map(frozen.map((a) => [a.id, a.pdf_file]))

  return Promise.all(rows.map(async (f): Promise<Annexe> => {
    if (f.state === 'confidential' || f.state === 'no_pdf') {
      return { invoice_id: f.id, pdf: null, raison: f.state }
    }
    const sent = envoyees?.[String(f.id)]
    const fichier = envoyees
      ? (sent === undefined ? null : fichiers.get(sent) ?? null)
      : (f.state === 'checked' ? f.current : null)
    if (!fichier) {
      return { invoice_id: f.id, pdf: null, raison: 'unchecked' }
    }
    const pdf = await readFile(join(storageDir, fichier)).catch(() => null)
    return { invoice_id: f.id, pdf, raison: pdf ? null : 'unreadable' }
  }))
}

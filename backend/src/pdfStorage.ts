import { createHash } from 'node:crypto'
import { access, copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { Pool } from 'pg'

// PDFs archived on disk (STORAGE_DIR), named by the SHA-256 of their content: the same PDF is stored once per kind.
// One folder per kind (ADR 0018); the columns hold the path relative to the storage: « factures/<sha>.pdf ».

export type Dossier = 'factures' | 'releves' | 'travaux' | 'assemblees'

// Every column that refers to an archived PDF
const REFERENCES = `
  SELECT fichier_pdf AS chemin FROM facture WHERE fichier_pdf IS NOT NULL
  UNION ALL SELECT fichier_pdf FROM travaux WHERE fichier_pdf IS NOT NULL
  UNION ALL SELECT pv_signe FROM assemblee WHERE pv_signe IS NOT NULL
  UNION ALL SELECT fichier_pdf FROM releve_bancaire WHERE fichier_pdf IS NOT NULL`

export const isPdf = (content: Buffer) => content.subarray(0, 5).toString('latin1') === '%PDF-'

const present = (path: string) => access(path).then(() => true, () => false)

export async function storePdf(storageDir: string, content: Buffer, dossier: Dossier) {
  const fileName = `${dossier}/${createHash('sha256').update(content).digest('hex')}.pdf`
  const path = join(storageDir, fileName)
  await mkdir(dirname(path), { recursive: true })
  // Same name, same content: a file already there (restored from a backup, possibly read-only) is kept as it is
  if (!(await present(path))) {
    await writeFile(path, content)
  }
  return { fileName, path }
}

/** Deletes an archived PDF that nothing refers to any more. */
export async function removeIfUnused(db: Pool, storageDir: string, fileName: string) {
  const { rowCount } = await db.query(`SELECT 1 FROM (${REFERENCES}) r WHERE chemin = $1`, [fileName])
  if (!rowCount) {
    await rm(join(storageDir, fileName), { force: true })
  }
}

/**
 * The PDFs of a storage written before the folders (migration 014: the columns now say « factures/<sha>.pdf », the
 * file is still at the root): each one is copied into the folder of every kind that refers to it, then the root file
 * is deleted. Run at start-up; does nothing once the storage is in order.
 */
export async function rangerStockage(db: Pool, storageDir: string): Promise<number> {
  const { rows } = await db.query<{ chemin: string }>(
    `SELECT DISTINCT chemin FROM (${REFERENCES}) r WHERE chemin LIKE '%/%'`)
  let copies = 0
  for (const { chemin } of rows) {
    const cible = join(storageDir, chemin)
    const ancien = join(storageDir, basename(chemin))
    if (!(await present(cible)) && (await present(ancien))) {
      await mkdir(dirname(cible), { recursive: true })
      await copyFile(ancien, cible)
      copies++
    }
  }
  // A root file now in the folder(s) of the kinds that refer to it is no longer needed
  const racine = await readdir(storageDir).catch(() => [] as string[])
  for (const nom of racine.filter((n) => n.endsWith('.pdf'))) {
    const dans = rows.filter(({ chemin }) => basename(chemin) === nom)
    if (dans.length && (await Promise.all(dans.map(({ chemin }) => present(join(storageDir, chemin))))).every(Boolean)) {
      await rm(join(storageDir, nom), { force: true })
    }
  }
  return copies
}

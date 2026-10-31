import { createHash } from 'node:crypto'
import { access, copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { Pool } from 'pg'

// PDFs archived on disk (STORAGE_DIR), named by the SHA-256 of their content: the same PDF is stored once per kind.
// One folder per kind (ADR 0018); the columns hold the path relative to the storage: « factures/<sha>.pdf ».

// Folders of the storage, as they are on disk (the paths stored in the database begin with them)
export type Dossier = 'factures' | 'annexes' | 'releves' | 'travaux' | 'assemblees'

// Every column that refers to an archived PDF
const REFERENCES = `
  SELECT pdf_file AS path FROM invoice WHERE pdf_file IS NOT NULL
  UNION ALL SELECT pdf_file FROM invoice_tenant_copy
  UNION ALL SELECT pdf_file FROM works_invoice WHERE pdf_file IS NOT NULL
  UNION ALL SELECT signed_minutes FROM general_meeting WHERE signed_minutes IS NOT NULL
  UNION ALL SELECT pdf_file FROM bank_statement WHERE pdf_file IS NOT NULL`

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
  const { rowCount } = await db.query(`SELECT 1 FROM (${REFERENCES}) r WHERE path = $1`, [fileName])
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
  const { rows } = await db.query<{ path: string }>(
    `SELECT DISTINCT path FROM (${REFERENCES}) r WHERE path LIKE '%/%'`)
  let copies = 0
  for (const { path } of rows) {
    const cible = join(storageDir, path)
    const ancien = join(storageDir, basename(path))
    if (!(await present(cible)) && (await present(ancien))) {
      await mkdir(dirname(cible), { recursive: true })
      await copyFile(ancien, cible)
      copies++
    }
  }
  // A root file now in the folder(s) of the kinds that refer to it is no longer needed
  const racine = await readdir(storageDir).catch(() => [] as string[])
  for (const name of racine.filter((n) => n.endsWith('.pdf'))) {
    const dans = rows.filter(({ path }) => basename(path) === name)
    if (dans.length && (await Promise.all(dans.map(({ path }) => present(join(storageDir, path))))).every(Boolean)) {
      await rm(join(storageDir, name), { force: true })
    }
  }
  return copies
}

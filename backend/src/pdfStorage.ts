import { createHash } from 'node:crypto'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Pool } from 'pg'

// Invoice PDFs archived on disk (STORAGE_DIR), named by the SHA-256 of their content: the same PDF is stored once.
// facture.fichier_pdf holds the file name only.

export const isPdf = (content: Buffer) => content.subarray(0, 5).toString('latin1') === '%PDF-'

export async function storePdf(storageDir: string, content: Buffer) {
  const fileName = `${createHash('sha256').update(content).digest('hex')}.pdf`
  const path = join(storageDir, fileName)
  await mkdir(storageDir, { recursive: true })
  // Same name, same content: a file already there (restored from a backup, possibly read-only) is kept as it is
  const present = await access(path).then(() => true, () => false)
  if (!present) {
    await writeFile(path, content)
  }
  return { fileName, path }
}

/** Deletes an archived PDF that no invoice refers to any more. */
export async function removeIfUnused(db: Pool, storageDir: string, fileName: string) {
  const { rowCount } = await db.query('SELECT 1 FROM facture WHERE fichier_pdf = $1', [fileName])
  if (!rowCount) {
    await rm(join(storageDir, fileName), { force: true })
  }
}

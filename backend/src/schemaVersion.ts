import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import type { Pool } from 'pg'

// Schema version checked at start (ADR 0026). The migrations are applied by the migration image (Flyway) before the
// API starts; the API only checks that the database has reached the version it was built with.

// backend/migrations, from src/ in development and dist/ in production (the image copies it)
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url))

// V002__name.sql (versioned) or B002__name.sql (baseline migration); not R__ (repeatable, no version)
const MIGRATION_FILE = /^[VB](\d+)__.+\.sql$/

export class SchemaVersionError extends Error {}

/** The highest migration of the repository: the version this API needs. */
export async function expectedSchemaVersion(dir = MIGRATIONS_DIR) {
  const versions = (await readdir(dir))
    .map((name) => MIGRATION_FILE.exec(name))
    .filter((match) => match !== null)
    .map((match) => Number(match[1]))
  if (!versions.length) {
    throw new SchemaVersionError(`Aucune migration dans ${dir}`)
  }
  return Math.max(...versions)
}

/**
 * Reads the history of Flyway (flyway_schema_history). Throws when the migrations never ran, when one failed, or when
 * the database is older than expected. A newer database is accepted with a warning: going back to the previous image
 * after a compatible migration.
 */
export async function checkSchemaVersion(db: Pool, expected: number) {
  const { rows: [history] } = await db.query<{ exists: boolean }>(
    'SELECT to_regclass(\'flyway_schema_history\') IS NOT NULL AS exists')
  if (!history?.exists) {
    throw new SchemaVersionError('La base n\'a pas d\'historique des migrations (flyway_schema_history) : lancer '
      + 'l\'image de migration avant l\'API (docs/exploitation.md)')
  }
  const { rows } = await db.query<{ version: string, success: boolean }>(
    'SELECT version, success FROM flyway_schema_history WHERE version IS NOT NULL')
  const failed = rows.filter((row) => !row.success).map((row) => row.version)
  if (failed.length) {
    throw new SchemaVersionError(`Migration ${failed.join(', ')} en échec : la corriger avec l'image de migration `
      + 'avant de démarrer l\'API')
  }
  const current = Math.max(0, ...rows.map((row) => Number(row.version)))
  if (current < expected) {
    throw new SchemaVersionError(`Le schéma de la base est en version ${current}, cette API demande ${expected} : `
      + 'lancer d\'abord l\'image de migration de la même version')
  }
  return {
    current,
    warning: current > expected
      ? `Le schéma de la base (version ${current}) est plus récent que cette API (${expected})`
      : undefined,
  }
}

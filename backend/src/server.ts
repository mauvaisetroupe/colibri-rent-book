import { fileURLToPath } from 'node:url'

import { buildApp } from './app.js'
import { pool } from './db.js'
import { rangerStockage } from './pdfStorage.js'

// Default: backend/storage/pdf (gitignored), from src/ in development and dist/ in production
const storageDir = process.env.STORAGE_DIR ?? fileURLToPath(new URL('../storage/pdf', import.meta.url))

// Production (container, ADR 0011): the built frontend is served by the API
const frontendDir = process.env.FRONTEND_DIR || undefined

// Authentication by passkey (ADR 0020), bound to the address of the application. Required in production: without it,
// the API would be open to anyone who reaches it
const origin = process.env.COLIBRI_ORIGIN?.replace(/\/$/, '') || undefined
if (!origin && process.env.NODE_ENV === 'production') {
  console.error('COLIBRI_ORIGIN manquant (adresse de l\'application, ex. https://colibri.example.org) : authentification obligatoire en production')
  process.exit(1)
}

const app = await buildApp({ db: pool, storageDir, frontendDir, auth: origin ? { origin } : undefined }, { logger: true })
if (!origin) {
  app.log.warn('COLIBRI_ORIGIN absent : pas d\'authentification (développement seulement)')
}

// PDFs of a storage written before the folders by kind (migration 014): moved into their folder, once
const ranges = await rangerStockage(pool, storageDir)
if (ranges) {
  app.log.info(`${ranges} PDF rangés dans leur dossier (factures/, travaux/…)`)
}

try {
  await app.listen({
    host: process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? 3000),
  })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}

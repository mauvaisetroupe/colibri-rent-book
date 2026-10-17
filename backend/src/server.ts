import { fileURLToPath } from 'node:url'

import { buildApp } from './app.js'
import { pool } from './db.js'

// Default: backend/storage/pdf (gitignored), from src/ in development and dist/ in production
const storageDir = process.env.STORAGE_DIR ?? fileURLToPath(new URL('../storage/pdf', import.meta.url))

// Production (container, ADR 0011): the built frontend is served by the API
const frontendDir = process.env.FRONTEND_DIR || undefined

const app = await buildApp({ db: pool, storageDir, frontendDir }, { logger: true })

try {
  await app.listen({
    host: process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? 3000),
  })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}

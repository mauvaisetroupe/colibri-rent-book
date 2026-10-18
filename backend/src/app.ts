import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyServerOptions } from 'fastify'
import type { Pool } from 'pg'


import assembleeRoutes from './routes/assemblees.js'
import controleRoutes from './routes/controle.js'
import decompteRoutes from './routes/decompte.js'
import extracteurRoutes from './routes/extracteurs.js'
import fiscalRoutes from './routes/fiscal.js'
import fournisseurRoutes from './routes/fournisseurs.js'
import facturesRoutes from './routes/factures.js'
import healthRoutes from './routes/health.js'
import immeubleRoutes from './routes/immeubles.js'
import paiementRoutes from './routes/paiements.js'
import regularisationRoutes from './routes/regularisations.js'
import releveRoutes from './routes/releves.js'
import sejourRoutes from './routes/sejours.js'
import travauxRoutes from './routes/travaux.js'

export type AppOptions = {
  db: Pool
  // Folder of the archived invoice PDFs
  storageDir: string
  // Built frontend (frontend/dist), served by the API in production (ADR 0011); absent in development (Vite)
  frontendDir?: string
}

/** Builds the application on a given pool and storage folder, so that tests can use their own. */
export async function buildApp({ db, storageDir, frontendDir }: AppOptions, options: FastifyServerOptions = {}) {
  const app = Fastify(options)

  await app.register(healthRoutes, { prefix: '/api', db })
  await app.register(immeubleRoutes, { prefix: '/api', db })
  await app.register(facturesRoutes, { prefix: '/api', db, storageDir })
  await app.register(controleRoutes, { prefix: '/api' })
  await app.register(extracteurRoutes, { prefix: '/api', db })
  await app.register(fournisseurRoutes, { prefix: '/api', db })
  await app.register(sejourRoutes, { prefix: '/api', db })
  await app.register(decompteRoutes, { prefix: '/api', db })
  await app.register(regularisationRoutes, { prefix: '/api', db, storageDir })
  await app.register(paiementRoutes, { prefix: '/api', db })
  await app.register(fiscalRoutes, { prefix: '/api', db })
  await app.register(travauxRoutes, { prefix: '/api', db, storageDir })
  await app.register(assembleeRoutes, { prefix: '/api', db, storageDir })
  await app.register(releveRoutes, { prefix: '/api', db, storageDir })

  if (frontendDir) {
    // Hashed assets kept a year by the browser; index.html never, so that a deployment shows at once
    await app.register(fastifyStatic, {
      root: frontendDir,
      wildcard: false,
      cacheControl: false,
      setHeaders: (res, path) => {
        res.setHeader('cache-control', path.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable')
      },
    })
    // Addresses of the application (/regularisations/12…) are routes of the Vue router: index.html for them,
    // a JSON 404 for an unknown API route
    app.setNotFoundHandler((request, reply) =>
      (request.url.startsWith('/api/') || !['GET', 'HEAD'].includes(request.method)
        ? reply.code(404).send({ message: 'Introuvable' })
        : reply.type('text/html').header('cache-control', 'no-cache').sendFile('index.html')))
  }

  return app
}

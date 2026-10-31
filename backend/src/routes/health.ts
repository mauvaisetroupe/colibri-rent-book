import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'

// The version of colibri-rent-book running (APP_VERSION, set in the image by the CI: X.Y.Z or the commit), « dev »
// outside the image
const version = process.env.APP_VERSION || 'dev'

const healthRoutes: FastifyPluginAsync<{ db: Pool }> = async (app, { db }) => {
  app.get('/health', async () => {
    return { status: 'ok', version }
  })

  app.get('/health/db', async () => {
    const result = await db.query<{ now: Date, version: string }>(
      'SELECT now(), current_setting(\'server_version\') AS version',
    )
    return { status: 'ok', database: result.rows[0] }
  })
}

export default healthRoutes

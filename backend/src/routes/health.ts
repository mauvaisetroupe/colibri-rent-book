import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'

const healthRoutes: FastifyPluginAsync<{ db: Pool }> = async (app, { db }) => {
  app.get('/health', async () => {
    return { status: 'ok' }
  })

  app.get('/health/db', async () => {
    const result = await db.query<{ now: Date, version: string }>(
      'SELECT now(), current_setting(\'server_version\') AS version',
    )
    return { status: 'ok', database: result.rows[0] }
  })
}

export default healthRoutes

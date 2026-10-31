// A single-use link (15 minutes) to register a passkey (ADR 0020), made on the server: the first one of an account
// (created with its name if it does not exist), or a recovery when every device is lost. In the container:
//   docker compose exec api node dist/cli/lien.js <email> [nom]
// In development: npm run lien -- <email> [nom]   (COLIBRI_ORIGIN, e.g. http://localhost:5173)
import { creerLien } from '../auth.js'
import { pool } from '../db.js'

const [email, ...name] = process.argv.slice(2)
const origin = process.env.COLIBRI_ORIGIN?.replace(/\/$/, '')
if (!email || !origin) {
  console.error('Usage : lien <email> [nom]   (COLIBRI_ORIGIN : adresse de l\'application)')
  process.exit(1)
}
try {
  const { rows: [u] } = await pool.query<{ id: number, name: string, created: boolean }>(
    `INSERT INTO app_user (email, name) VALUES (lower($1), $2)
     ON CONFLICT (email) DO UPDATE SET email = excluded.email RETURNING id, name, (xmax = 0) AS created`,
    [email, name.join(' ') || email])
  const lien = await creerLien(pool, u!.id, origin)
  console.log(`${u!.created ? 'Compte créé' : 'Compte existant'} : ${u!.name} <${email.toLowerCase()}>`)
  const time = new Date(lien.expires_at).toLocaleTimeString('fr-FR', { timeZone: process.env.TZ || 'Europe/Paris', hour: '2-digit', minute: '2-digit' })
  console.log(`Lien d'enregistrement d'une passkey, à usage unique, valable jusqu'à ${time} (15 minutes) :`)
  console.log(lien.url)
} finally {
  await pool.end()
}

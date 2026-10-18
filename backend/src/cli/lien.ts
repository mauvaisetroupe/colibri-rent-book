// A single-use link (15 minutes) to register a passkey (ADR 0020), made on the server: the first one of an account
// (created with its name if it does not exist), or a recovery when every device is lost. In the container:
//   docker compose exec api node dist/cli/lien.js <email> [nom]
// In development: npm run lien -- <email> [nom]   (COLIBRI_ORIGIN, e.g. http://localhost:5173)
import { creerLien } from '../auth.js'
import { pool } from '../db.js'

const [email, ...nom] = process.argv.slice(2)
const origin = process.env.COLIBRI_ORIGIN?.replace(/\/$/, '')
if (!email || !origin) {
  console.error('Usage : lien <email> [nom]   (COLIBRI_ORIGIN : adresse de l\'application)')
  process.exit(1)
}
try {
  const { rows: [u] } = await pool.query<{ id: number, nom: string, cree: boolean }>(
    `INSERT INTO utilisateur (email, nom) VALUES (lower($1), $2)
     ON CONFLICT (email) DO UPDATE SET email = excluded.email RETURNING id, nom, (xmax = 0) AS cree`,
    [email, nom.join(' ') || email])
  const lien = await creerLien(pool, u!.id, origin)
  console.log(`${u!.cree ? 'Compte créé' : 'Compte existant'} : ${u!.nom} <${email.toLowerCase()}>`)
  const heure = new Date(lien.expire_le).toLocaleTimeString('fr-FR', { timeZone: process.env.TZ || 'Europe/Paris', hour: '2-digit', minute: '2-digit' })
  console.log(`Lien d'enregistrement d'une passkey, à usage unique, valable jusqu'à ${heure} (15 minutes) :`)
  console.log(lien.url)
} finally {
  await pool.end()
}

// An API token for a script (ADR 0020), made on the server for an existing account; shown once, only its digest is
// kept (revoked in Réglages › Mon compte). In the container:
//   docker compose exec api node dist/cli/jeton.js <email> <nom du jeton>
import { creerJeton } from '../auth.js'
import { pool } from '../db.js'

const [email, ...name] = process.argv.slice(2)
if (!email || !name.length) {
  console.error('Usage : jeton <email> <nom du jeton>')
  process.exit(1)
}
try {
  const { rows: [u] } = await pool.query<{ id: number }>('SELECT id FROM app_user WHERE email = lower($1)', [email])
  if (!u) {
    console.error(`Aucun compte ${email}`)
    process.exit(1)
  }
  const { jeton } = await creerJeton(pool, u.id, name.join(' '))
  console.log(`Jeton « ${name.join(' ')} » (à garder, il ne sera plus affiché) :`)
  console.log(jeton)
} finally {
  await pool.end()
}

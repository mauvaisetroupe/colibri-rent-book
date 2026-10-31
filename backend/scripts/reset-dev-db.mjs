// npm run db:local:reset: recreates the development database (empty volume, then the migration image), keeping the accounts with their passkeys and API tokens (ADR 0020), so that one still signs in
// afterwards. Sessions and registration links are not kept. Through Docker only: the same on macOS, Linux and Windows.
import { spawnSync } from 'node:child_process'

const compose = ['compose', '-f', 'docker-compose.dev.yml']
const docker = (args, input) => {
  const r = spawnSync('docker', args, { input, encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'] })
  if (r.error) {
    throw r.error
  }
  return r
}

// 1. The accounts, if the database runs and has them (pg_dump orders the rows for the foreign keys)
const dump = docker([...compose, 'exec', '-T', 'dev-db', 'pg_dump', '-U', 'colibri', '-d', 'colibri', '--data-only',
  '-t', 'app_user', '-t', 'passkey', '-t', 'api_token'])
const comptes = dump.status === 0 ? dump.stdout : null
console.log(comptes ? 'Comptes, passkeys et jetons d\'API sauvés' : 'Aucun compte à garder (base arrêtée ou sans comptes)')

// 2. A new database
for (const args of [[...compose, 'rm', '-sfv', 'dev-db'], ['volume', 'rm', '-f', 'colibri_dev-db-data'],
  [...compose, 'up', '-d', '--wait', 'dev-db', 'adminer'], [...compose, 'run', '--rm', '--build', 'dev-migrations']]) {
  const r = docker(args)
  process.stdout.write(r.stdout)
  if (r.status !== 0) {
    process.exit(r.status ?? 1)
  }
}

// 3. The accounts back
if (comptes) {
  const r = docker([...compose, 'exec', '-T', 'dev-db', 'psql', '-U', 'colibri', '-d', 'colibri', '-v', 'ON_ERROR_STOP=1', '-q'], comptes)
  if (r.status !== 0) {
    console.error('Comptes non restaurés : « npm run lien -- <email> » pour une nouvelle passkey')
    process.exit(r.status ?? 1)
  }
  console.log('Comptes, passkeys et jetons d\'API restaurés')
}

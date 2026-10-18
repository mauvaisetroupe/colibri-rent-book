import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import type pg from 'pg'

import { buildApp } from './app.js'
import { creerJeton, creerLien, empreinte, secret } from './auth.js'
import { createTestPool, resetDatabase, skipWithoutDatabase } from './test/database.js'

// Authentication (ADR 0020): every API route closed without a session or a token, except the health check and what
// connecting needs; tokens and sessions checked by their digest; a change with the cookie from another origin refused;
// links single-use; the last passkey of an account kept. (The WebAuthn ceremony itself is the library's.)

describe('authentication', { skip: skipWithoutDatabase }, () => {
  const origin = 'https://colibri.example.org'
  let pool: pg.Pool
  let app: Awaited<ReturnType<typeof buildApp>>
  let storageDir: string
  let utilisateur: number

  async function session() {
    const valeur = secret()
    await pool.query(`INSERT INTO session (empreinte, utilisateur_id, expire_le) VALUES ($1, $2, now() + interval '1 day')`,
      [empreinte(valeur), utilisateur])
    return { cookie: `colibri_session=${valeur}` }
  }

  before(async () => {
    pool = createTestPool()
    await resetDatabase(pool)
    storageDir = await mkdtemp(join(tmpdir(), 'crb-pdf-'))
    app = await buildApp({ db: pool, storageDir, auth: { origin } })
    utilisateur = (await pool.query<{ id: number }>(
      'INSERT INTO utilisateur (email, nom) VALUES (\'alice@example.org\', \'Alice\') RETURNING id')).rows[0]!.id
  })

  after(async () => {
    await app.close()
    await pool.end()
    await rm(storageDir, { recursive: true, force: true })
  })

  test('without a session, the API is closed but the health check and connecting', async () => {
    assert.equal((await app.inject('/api/immeubles')).statusCode, 401)
    assert.equal((await app.inject({ method: 'POST', url: '/api/paiements', payload: {} })).statusCode, 401)
    assert.equal((await app.inject('/api/health')).statusCode, 200)
    assert.equal((await app.inject('/api/auth/session')).statusCode, 401)
    const options = await app.inject({ method: 'POST', url: '/api/auth/connexion/options' })
    assert.equal(options.statusCode, 200)
    assert.equal(options.json().options.rpId, 'colibri.example.org')
  })

  test('a session opens the API; an expired one or a wrong cookie does not', async () => {
    const headers = await session()
    assert.equal((await app.inject({ url: '/api/immeubles', headers })).statusCode, 200)
    assert.equal((await app.inject({ url: '/api/auth/session', headers })).json().utilisateur.email, 'alice@example.org')
    assert.equal((await app.inject({ url: '/api/immeubles', headers: { cookie: 'colibri_session=faux' } })).statusCode, 401)
    await pool.query('UPDATE session SET expire_le = now() - interval \'1 minute\'')
    assert.equal((await app.inject({ url: '/api/immeubles', headers })).statusCode, 401)
  })

  test('a change with the cookie from another origin is refused', async () => {
    const { cookie } = await session()
    const ailleurs = await app.inject({ method: 'POST', url: '/api/auth/jetons', headers: { cookie, origin: 'https://evil.example' }, payload: { nom: 'x' } })
    assert.equal(ailleurs.statusCode, 403)
    const ici = await app.inject({ method: 'POST', url: '/api/auth/jetons', headers: { cookie, origin }, payload: { nom: 'script' } })
    assert.equal(ici.statusCode, 201)
    assert.match(ici.json().jeton, /^colibri_/)
  })

  test('an API token opens the API until it is revoked', async () => {
    const { id, jeton } = await creerJeton(pool, utilisateur, 'rapprochement')
    const headers = { authorization: `Bearer ${jeton}` }
    assert.equal((await app.inject({ url: '/api/immeubles', headers })).statusCode, 200)
    assert.equal((await app.inject({ url: '/api/immeubles', headers: { authorization: 'Bearer faux' } })).statusCode, 401)
    const revoque = await app.inject({ method: 'DELETE', url: `/api/auth/jetons/${id}`, headers: await session() })
    assert.equal(revoque.statusCode, 204)
    assert.equal((await app.inject({ url: '/api/immeubles', headers })).statusCode, 401)
  })

  test('a registration link is single-use and expires; registering for oneself needs a session', async () => {
    const { url } = await creerLien(pool, utilisateur, origin)
    assert.ok(url.startsWith(`${origin}/enregistrer?jeton=`))
    const jeton = new URL(url).searchParams.get('jeton')
    const options = await app.inject({ method: 'POST', url: '/api/auth/enregistrement/options', payload: { jeton } })
    assert.equal(options.statusCode, 200, options.body)
    assert.equal(options.json().utilisateur.email, 'alice@example.org')
    assert.equal(options.json().options.authenticatorSelection.residentKey, 'required')
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/enregistrement/options', payload: { jeton: 'faux' } })).statusCode, 400)
    await pool.query('UPDATE lien_enregistrement SET utilise_le = now()')
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/enregistrement/options', payload: { jeton } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/enregistrement/options', payload: {} })).statusCode, 401)
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/enregistrement/options', headers: await session(), payload: {} })).statusCode, 200)
    // A link for another device, made once connected
    const lien = await app.inject({ method: 'POST', url: '/api/auth/liens', headers: await session() })
    assert.match(lien.json().url, /\/enregistrer\?jeton=/)
  })

  test('the last passkey of an account is kept', async () => {
    const headers = await session()
    await pool.query(`INSERT INTO passkey (id, utilisateur_id, cle_publique, appareil) VALUES ('p1', $1, '\\x00', 'Mac'), ('p2', $1, '\\x00', 'iPhone')`, [utilisateur])
    assert.deepEqual((await app.inject({ url: '/api/auth/passkeys', headers })).json().map((p: { appareil: string }) => p.appareil), ['Mac', 'iPhone'])
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/auth/passkeys/p1', headers })).statusCode, 204)
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/auth/passkeys/p2', headers })).statusCode, 400)
  })

  test('logging out ends the session', async () => {
    const headers = await session()
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/deconnexion', headers })).statusCode, 204)
    assert.equal((await app.inject({ url: '/api/immeubles', headers })).statusCode, 401)
  })
})

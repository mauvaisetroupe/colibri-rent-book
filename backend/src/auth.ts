import { createHash, randomBytes } from 'node:crypto'

import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server'
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'

import { body, idParam, InputError, requiredText, sendError } from './http.js'

// Authentication (ADR 0020), in the application: by passkey (WebAuthn) only, no password. A session is a random
// cookie (HttpOnly, SameSite=Strict, Secure over https), kept in the database (revocable), 30 days from the last use;
// a script uses an API token (Authorization: Bearer). A passkey is registered from a single-use link (15 minutes): the
// first one (link made on the server, cli/lien.ts), another device (link made once connected: a QR code for a phone),
// or a recovery. Only SHA-256 digests of the cookies, links and tokens are stored.

export type AuthOptions = {
  // Address of the application as the browser sees it (https://colibri.example.org; http://localhost:5173 in
  // development): the passkeys are bound to its host name
  origin: string
}

export type Utilisateur = { id: number, email: string, nom: string }

declare module 'fastify' {
  interface FastifyRequest {
    utilisateur?: Utilisateur
  }
}

const COOKIE = 'colibri_session'
const DUREE_SESSION_JOURS = 30
const DUREE_LIEN_MINUTES = 15

export const secret = () => randomBytes(32).toString('base64url')
export const empreinte = (valeur: string) => createHash('sha256').update(valeur).digest('hex')

/** A single-use link to register a passkey for this account, valid 15 minutes. */
export async function creerLien(db: Pool, utilisateurId: number, origin: string) {
  const jeton = secret()
  const { rows: [l] } = await db.query<{ expire_le: string }>(
    `INSERT INTO lien_enregistrement (empreinte, utilisateur_id, expire_le) VALUES ($1, $2, now() + $3 * interval '1 minute')
     RETURNING expire_le::text`, [empreinte(jeton), utilisateurId, DUREE_LIEN_MINUTES])
  return { url: `${origin}/enregistrer?jeton=${jeton}`, expire_le: l!.expire_le }
}

/** An API token for scripts: shown once, only its digest is kept. */
export async function creerJeton(db: Pool, utilisateurId: number, nom: string) {
  const jeton = `colibri_${secret()}`
  const { rows: [j] } = await db.query<{ id: number }>(
    'INSERT INTO jeton_api (nom, empreinte, utilisateur_id) VALUES ($1, $2, $3) RETURNING id', [nom, empreinte(jeton), utilisateurId])
  return { id: j!.id, jeton }
}

function lireCookie(request: FastifyRequest, nom: string) {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [cle, ...valeur] = part.trim().split('=')
    if (cle === nom) {
      return decodeURIComponent(valeur.join('='))
    }
  }
  return null
}

// What is open without a session: the health check, connecting, registering from a link
const PUBLIQUES = ['/api/health', '/api/auth/session', '/api/auth/connexion', '/api/auth/enregistrement']

/** Every /api route requires a session or an API token (the frontend's files are open: the login page is one of them). */
export function proteger(app: FastifyInstance, db: Pool, { origin }: AuthOptions) {
  app.addHook('onRequest', async (request, reply) => {
    const chemin = request.url.split('?')[0]!
    if (!chemin.startsWith('/api/')) {
      return
    }
    const utilisateur = await identifier(db, request)
    if (utilisateur) {
      request.utilisateur = utilisateur
      // A change made with the cookie comes from the application itself (SameSite=Strict, and its origin checked)
      const viaCookie = !request.headers.authorization
      if (viaCookie && !['GET', 'HEAD'].includes(request.method) && request.headers.origin && request.headers.origin !== origin) {
        return reply.code(403).send({ message: 'Origine refusée' })
      }
      return
    }
    if (!PUBLIQUES.some((p) => chemin === p || chemin.startsWith(`${p}/`))) {
      return reply.code(401).send({ message: 'Connexion requise' })
    }
  })
}

async function identifier(db: Pool, request: FastifyRequest): Promise<Utilisateur | null> {
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '')?.[1]
  if (bearer) {
    const { rows: [u] } = await db.query<Utilisateur>(
      `UPDATE jeton_api j SET utilise_le = now() FROM utilisateur u
       WHERE j.empreinte = $1 AND j.revoque_le IS NULL AND u.id = j.utilisateur_id RETURNING u.id, u.email, u.nom`, [empreinte(bearer)])
    return u ?? null
  }
  const cookie = lireCookie(request, COOKIE)
  if (!cookie) {
    return null
  }
  // 30 days from the last use
  const { rows: [u] } = await db.query<Utilisateur>(
    `UPDATE session s SET expire_le = now() + $2 * interval '1 day' FROM utilisateur u
     WHERE s.empreinte = $1 AND s.expire_le > now() AND u.id = s.utilisateur_id RETURNING u.id, u.email, u.nom`,
    [empreinte(cookie), DUREE_SESSION_JOURS])
  return u ?? null
}

// ---------------------------------------------------------------- routes

// A challenge waits for its answer two minutes, in memory (one API process)
type Defi = { challenge: string, utilisateurId: number | null, lien: string | null, expire: number }

export const authRoutes: FastifyPluginAsync<{ db: Pool } & AuthOptions> = async (app, { db, origin }) => {
  const rpID = new URL(origin).hostname
  const securise = origin.startsWith('https://')
  const defis = new Map<string, Defi>()
  const garder = (d: Omit<Defi, 'expire'>) => {
    const now = Date.now()
    for (const [k, v] of defis) {
      if (v.expire < now) {
        defis.delete(k)
      }
    }
    const id = secret()
    defis.set(id, { ...d, expire: now + 120_000 })
    return id
  }
  const reprendre = (id: unknown) => {
    const d = typeof id === 'string' ? defis.get(id) : undefined
    defis.delete(String(id))
    if (!d || d.expire < Date.now()) {
      throw new InputError('Demande expirée : recommencer')
    }
    return d
  }

  async function ouvrirSession(reply: FastifyReply, utilisateurId: number) {
    const valeur = secret()
    await db.query(
      `INSERT INTO session (empreinte, utilisateur_id, expire_le) VALUES ($1, $2, now() + $3 * interval '1 day')`,
      [empreinte(valeur), utilisateurId, DUREE_SESSION_JOURS])
    reply.header('set-cookie', `${COOKIE}=${valeur}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${DUREE_SESSION_JOURS * 86400}${securise ? '; Secure' : ''}`)
  }

  const connecte = (request: FastifyRequest) => {
    if (!request.utilisateur) {
      throw Object.assign(new Error('Connexion requise'), { statusCode: 401 })
    }
    return request.utilisateur
  }

  /** The account a link registers a passkey for (valid, not used yet). */
  async function compteDuLien(jeton: unknown) {
    if (typeof jeton !== 'string' || !jeton) {
      return null
    }
    const { rows: [l] } = await db.query<{ utilisateur_id: number }>(
      'SELECT utilisateur_id FROM lien_enregistrement WHERE empreinte = $1 AND utilise_le IS NULL AND expire_le > now()',
      [empreinte(jeton)])
    if (!l) {
      throw new InputError('Lien invalide, déjà utilisé ou expiré : en demander un nouveau')
    }
    return l.utilisateur_id
  }

  const erreur = (reply: FastifyReply, error: unknown) =>
    ((error as { statusCode?: number }).statusCode === 401
      ? reply.code(401).send({ message: 'Connexion requise' })
      : sendError(reply, error))

  // Who is connected (401: nobody)
  app.get('/auth/session', async (request, reply) =>
    (request.utilisateur ? { utilisateur: request.utilisateur } : reply.code(401).send({ message: 'Connexion requise' })))

  // ---------------------------------------------------------------- connecting

  app.post('/auth/connexion/options', async () => {
    // Any passkey of this site (discoverable): the browser offers those it holds
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' })
    return { id: garder({ challenge: options.challenge, utilisateurId: null, lien: null }), options }
  })

  app.post('/auth/connexion', async (request, reply) => {
    try {
      const raw = body(request)
      const defi = reprendre(raw.id)
      const reponse = raw.reponse as Parameters<typeof verifyAuthenticationResponse>[0]['response']
      const { rows: [p] } = await db.query<{ id: string, utilisateur_id: number, cle_publique: Buffer, compteur: string, transports: string[] | null }>(
        'SELECT id, utilisateur_id, cle_publique, compteur::text, transports FROM passkey WHERE id = $1', [reponse?.id])
      if (!p) {
        throw new InputError('Passkey inconnue : elle a peut-être été supprimée')
      }
      const { verified, authenticationInfo } = await verifyAuthenticationResponse({
        response: reponse, expectedChallenge: defi.challenge, expectedOrigin: origin, expectedRPID: rpID,
        credential: { id: p.id, publicKey: new Uint8Array(p.cle_publique), counter: Number(p.compteur), transports: (p.transports ?? undefined) as never },
      })
      if (!verified) {
        throw new InputError('Passkey refusée')
      }
      await db.query('UPDATE passkey SET compteur = $2, utilisee_le = now() WHERE id = $1', [p.id, authenticationInfo.newCounter])
      await ouvrirSession(reply, p.utilisateur_id)
      return { ok: true }
    } catch (error) {
      return erreur(reply, error)
    }
  })

  app.post('/auth/deconnexion', async (request, reply) => {
    const cookie = lireCookie(request, COOKIE)
    if (cookie) {
      await db.query('DELETE FROM session WHERE empreinte = $1', [empreinte(cookie)])
    }
    return reply.header('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${securise ? '; Secure' : ''}`).code(204).send()
  })

  // ---------------------------------------------------------------- registering a passkey

  // From a link (« jeton »: first passkey, another device, recovery), or for the account connected (this device)
  app.post('/auth/enregistrement/options', async (request, reply) => {
    try {
      const raw = body(request)
      const lien = typeof raw.jeton === 'string' && raw.jeton ? raw.jeton : null
      const utilisateurId = lien ? await compteDuLien(lien) : connecte(request).id
      const { rows: [u] } = await db.query<Utilisateur>('SELECT id, email, nom FROM utilisateur WHERE id = $1', [utilisateurId])
      const { rows: existantes } = await db.query<{ id: string, transports: string[] | null }>(
        'SELECT id, transports FROM passkey WHERE utilisateur_id = $1', [utilisateurId])
      const options = await generateRegistrationOptions({
        rpName: 'Colibri', rpID, userName: u!.email, userDisplayName: u!.nom,
        userID: new TextEncoder().encode(`colibri-${u!.id}`),
        attestationType: 'none',
        excludeCredentials: existantes.map((e) => ({ id: e.id, transports: e.transports ?? undefined })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      })
      return { id: garder({ challenge: options.challenge, utilisateurId: u!.id, lien }), options, utilisateur: u }
    } catch (error) {
      return erreur(reply, error)
    }
  })

  app.post('/auth/enregistrement', async (request, reply) => {
    try {
      const raw = body(request)
      const defi = reprendre(raw.id)
      const appareil = requiredText(raw.appareil, 'Nom de l\'appareil')
      const { verified, registrationInfo } = await verifyRegistrationResponse({
        response: raw.reponse as Parameters<typeof verifyRegistrationResponse>[0]['response'],
        expectedChallenge: defi.challenge, expectedOrigin: origin, expectedRPID: rpID,
      })
      if (!verified) {
        throw new InputError('Passkey refusée')
      }
      const c = registrationInfo.credential
      await db.query(
        `INSERT INTO passkey (id, utilisateur_id, cle_publique, compteur, transports, appareil) VALUES ($1, $2, $3, $4, $5, $6)`,
        [c.id, defi.utilisateurId, Buffer.from(c.publicKey), c.counter, c.transports ?? null, appareil])
      if (defi.lien) {
        // The link is used: it opens a session on this device
        await db.query('UPDATE lien_enregistrement SET utilise_le = now() WHERE empreinte = $1', [empreinte(defi.lien)])
        await ouvrirSession(reply, defi.utilisateurId!)
      }
      return { ok: true }
    } catch (error) {
      return erreur(reply, error)
    }
  })

  // ---------------------------------------------------------------- the account: its passkeys, links, API tokens

  app.get('/auth/passkeys', async (request, reply) => {
    try {
      const { rows } = await db.query(
        `SELECT id, appareil, cree_le::text, utilisee_le::text FROM passkey WHERE utilisateur_id = $1 ORDER BY cree_le`,
        [connecte(request).id])
      return rows
    } catch (error) {
      return erreur(reply, error)
    }
  })

  // The last passkey of an account stays (else nobody could connect but by a link made on the server)
  app.delete('/auth/passkeys/:id', async (request, reply) => {
    try {
      const u = connecte(request)
      const { rows: [n] } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM passkey WHERE utilisateur_id = $1', [u.id])
      if (n!.n <= 1) {
        throw new InputError('C\'est votre dernière passkey : en ajouter une autre avant de la supprimer')
      }
      const { rowCount } = await db.query('DELETE FROM passkey WHERE id = $1 AND utilisateur_id = $2',
        [(request.params as { id: string }).id, u.id])
      return rowCount ? reply.code(204).send() : reply.code(404).send({ message: 'Passkey introuvable' })
    } catch (error) {
      return erreur(reply, error)
    }
  })

  // A link to register a passkey on another device (a phone: shown as a QR code)
  app.post('/auth/liens', async (request, reply) => {
    try {
      return await creerLien(db, connecte(request).id, origin)
    } catch (error) {
      return erreur(reply, error)
    }
  })

  app.get('/auth/jetons', async (request, reply) => {
    try {
      const { rows } = await db.query(
        `SELECT id, nom, cree_le::text, utilise_le::text, revoque_le::text FROM jeton_api WHERE utilisateur_id = $1 ORDER BY cree_le DESC`,
        [connecte(request).id])
      return rows
    } catch (error) {
      return erreur(reply, error)
    }
  })

  app.post('/auth/jetons', async (request, reply) => {
    try {
      return reply.code(201).send(await creerJeton(db, connecte(request).id, requiredText(body(request).nom, 'Nom du jeton')))
    } catch (error) {
      return erreur(reply, error)
    }
  })

  app.delete('/auth/jetons/:id', async (request, reply) => {
    try {
      const { rowCount } = await db.query('UPDATE jeton_api SET revoque_le = now() WHERE id = $1 AND utilisateur_id = $2 AND revoque_le IS NULL',
        [idParam(request), connecte(request).id])
      return rowCount ? reply.code(204).send() : reply.code(404).send({ message: 'Jeton introuvable' })
    } catch (error) {
      return erreur(reply, error)
    }
  })
}

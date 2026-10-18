import { createReadStream } from 'node:fs'
import { join } from 'node:path'

import multipart from '@fastify/multipart'
import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'

import { loadAssemblee, loadSociete, modeleAnnuel, type Associe } from '../assemblees.js'
import {
  body, idParam, InputError, optionalDecimal, optionalText, requiredDate, requiredId, requiredText, sendError,
} from '../http.js'
import { isPdf, removeIfUnused, storePdf } from '../pdfStorage.js'
import { pvPdf } from '../pvPdf.js'

// The company, its partners, its general meetings and their minutes (ADR 0016). A meeting is changed while it is a
// draft; closing numbers it in the register and freezes it (the database refuses any later change but the signed
// minutes).

const TYPES = ['ordinaire', 'extraordinaire']
const PRESENCES = ['present', 'represente', 'absent']

const parts = (value: unknown, name: string) => {
  const n = Number(value ?? 0)
  if (!Number.isInteger(n) || n < 0) {
    throw new InputError(`${name} : nombre entier de parts attendu`)
  }
  return n
}

const assembleeRoutes: FastifyPluginAsync<{ db: Pool, storageDir: string }> = async (app, { db, storageDir }) => {
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } })

  const associes = async () => (await db.query<Associe>(
    'SELECT id, nom, parts, gerant, adresse, note FROM associe ORDER BY nom',
  )).rows

  // ---------------------------------------------------------------- company and partners

  app.get('/societe', async () => ({ societe: await loadSociete(db), associes: await associes() }))

  app.put('/societe', async (request, reply) => {
    try {
      const raw = body(request)
      await db.query(
        `INSERT INTO societe (id, denomination, forme, capital, siege, rcs) VALUES (1, $1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET denomination = $1, forme = $2, capital = $3, siege = $4, rcs = $5`,
        [requiredText(raw.denomination, 'Dénomination'), optionalText(raw.forme) ?? 'SCI',
          optionalDecimal(raw.capital, 'Capital'), optionalText(raw.siege), optionalText(raw.rcs)],
      )
      return { societe: await loadSociete(db), associes: await associes() }
    } catch (error) {
      return sendError(reply, error)
    }
  })

  const readAssocie = (raw: Record<string, unknown>) => {
    const n = parts(raw.parts, 'Parts')
    if (n === 0) {
      throw new InputError('Parts : au moins une')
    }
    return [requiredText(raw.nom, 'Nom'), n, raw.gerant === true, optionalText(raw.adresse), optionalText(raw.note)]
  }

  app.post('/associes', async (request, reply) => {
    try {
      const { rows: [a] } = await db.query(
        'INSERT INTO associe (nom, parts, gerant, adresse, note) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        readAssocie(body(request)),
      )
      return reply.code(201).send(a)
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.put('/associes/:id', async (request, reply) => {
    try {
      const { rows: [a] } = await db.query(
        'UPDATE associe SET nom = $2, parts = $3, gerant = $4, adresse = $5, note = $6 WHERE id = $1 RETURNING *',
        [idParam(request), ...readAssocie(body(request))],
      )
      return a ?? reply.code(404).send({ message: 'Associé introuvable' })
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.delete('/associes/:id', async (request, reply) => {
    try {
      // Present in a closed meeting: the register keeps him (the delete of his presence is refused)
      await db.query('DELETE FROM presence WHERE associe_id = $1', [idParam(request)])
      const { rowCount } = await db.query('DELETE FROM associe WHERE id = $1', [idParam(request)])
      return rowCount ? reply.code(204).send() : reply.code(404).send({ message: 'Associé introuvable' })
    } catch (error) {
      if (String((error as Error).message).includes('Assemblée close')) {
        return reply.code(409).send({ message: 'Cet associé figure dans une assemblée close du registre : il est gardé' })
      }
      return sendError(reply, error)
    }
  })

  // ---------------------------------------------------------------- meetings

  app.get('/assemblees', async () => {
    const { rows } = await db.query(
      `SELECT id, numero, type, date::text, statut, pv_signe IS NOT NULL AS pv_signe,
              coalesce((instantane -> 'assemblee' -> 'resolutions')::jsonb, '[]'::jsonb) AS figees,
              (SELECT count(*)::int FROM resolution r WHERE r.assemblee_id = a.id) AS nb_resolutions
       FROM assemblee a ORDER BY date DESC, id DESC`,
    )
    return rows.map(({ figees, ...a }) => ({ ...a, nb_resolutions: a.statut === 'close' ? figees.length : a.nb_resolutions }))
  })

  app.get('/assemblees/:id', async (request, reply) =>
    (await loadAssemblee(db, idParam(request))) ?? reply.code(404).send({ message: 'Assemblée introuvable' }))

  // A new draft: every partner present; with modele=annuelle, the agenda and resolutions of the annual meeting
  app.post('/assemblees', async (request, reply) => {
    try {
      const raw = body(request)
      const type = String(raw.type ?? 'ordinaire')
      if (!TYPES.includes(type)) {
        throw new InputError('Type : ordinaire ou extraordinaire')
      }
      const date = requiredDate(raw.date, 'Date')
      const liste = await associes()
      const modele = raw.modele === 'annuelle'
        ? modeleAnnuel(raw.exercice ? requiredId(raw.exercice, 'Exercice') : Number(date.slice(0, 4)) - 1, liste)
        : { ordre_du_jour: '', resolutions: [] }
      const gerant = liste.find((a) => a.gerant)
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        const { rows: [a] } = await client.query<{ id: number }>(
          `INSERT INTO assemblee (type, date, lieu, ordre_du_jour, president) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [type, date, optionalText(raw.lieu), modele.ordre_du_jour, gerant?.nom ?? null],
        )
        for (const associe of liste) {
          await client.query('INSERT INTO presence (assemblee_id, associe_id) VALUES ($1, $2)', [a!.id, associe.id])
        }
        for (const r of modele.resolutions) {
          await client.query(
            `INSERT INTO resolution (assemblee_id, ordre, titre, texte, pour, contre, abstention)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [a!.id, r.ordre, r.titre, r.texte, r.pour, r.contre, r.abstention],
          )
        }
        await client.query('COMMIT')
        return reply.code(201).send(await loadAssemblee(db, a!.id))
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    } catch (error) {
      return sendError(reply, error)
    }
  })

  // The whole draft: header, presences, resolutions
  app.put('/assemblees/:id', async (request, reply) => {
    const id = idParam(request)
    const client = await db.connect()
    try {
      const raw = body(request)
      const type = String(raw.type ?? '')
      if (!TYPES.includes(type)) {
        throw new InputError('Type : ordinaire ou extraordinaire')
      }
      const presences = Array.isArray(raw.presences) ? raw.presences as Record<string, unknown>[] : []
      const resolutions = Array.isArray(raw.resolutions) ? raw.resolutions as Record<string, unknown>[] : []
      for (const p of presences) {
        if (!PRESENCES.includes(String(p.presence))) {
          throw new InputError('Présence : présent, représenté ou absent')
        }
      }
      await client.query('BEGIN')
      const { rows: [current] } = await client.query<{ statut: string }>(
        'SELECT statut FROM assemblee WHERE id = $1 FOR UPDATE', [id])
      if (!current) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ message: 'Assemblée introuvable' })
      }
      if (current.statut === 'close') {
        await client.query('ROLLBACK')
        return reply.code(409).send({ message: 'Assemblée close : elle n\'est plus modifiable' })
      }
      await client.query(
        `UPDATE assemblee SET type = $2, date = $3, heure = $4, lieu = $5, ordre_du_jour = $6, president = $7,
                              observations = $8 WHERE id = $1`,
        [id, type, requiredDate(raw.date, 'Date'), optionalText(raw.heure), optionalText(raw.lieu),
          String(raw.ordre_du_jour ?? ''), optionalText(raw.president), optionalText(raw.observations)],
      )
      for (const p of presences) {
        await client.query(
          `UPDATE presence SET presence = $3, represente_par = $4 WHERE assemblee_id = $1 AND associe_id = $2`,
          [id, requiredId(p.associe_id, 'Associé'), p.presence, p.presence === 'represente' ? optionalText(p.represente_par) : null],
        )
      }
      await client.query('DELETE FROM resolution WHERE assemblee_id = $1', [id])
      for (const [i, r] of resolutions.entries()) {
        await client.query(
          `INSERT INTO resolution (assemblee_id, ordre, titre, texte, pour, contre, abstention)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, i + 1, requiredText(r.titre, `Résolution ${i + 1}, titre`), String(r.texte ?? ''),
            parts(r.pour, 'Pour'), parts(r.contre, 'Contre'), parts(r.abstention, 'Abstention')],
        )
      }
      await client.query('COMMIT')
      return loadAssemblee(db, id)
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      return sendError(reply, error)
    } finally {
      client.release()
    }
  })

  // Only a draft is deleted (the database refuses it for a closed meeting)
  app.delete('/assemblees/:id', async (request, reply) => {
    const { rows: [a] } = await db.query<{ statut: string }>('SELECT statut FROM assemblee WHERE id = $1', [idParam(request)])
    if (!a) {
      return reply.code(404).send({ message: 'Assemblée introuvable' })
    }
    if (a.statut === 'close') {
      return reply.code(409).send({ message: 'Assemblée close : elle reste dans le registre' })
    }
    await db.query('DELETE FROM assemblee WHERE id = $1', [idParam(request)])
    return reply.code(204).send()
  })

  // Closing: the next number of the register, the minutes frozen as they are
  app.post('/assemblees/:id/cloture', async (request, reply) => {
    const id = idParam(request)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      // One closing at a time: the numbers of the register follow each other without a gap
      await client.query('LOCK TABLE assemblee IN SHARE ROW EXCLUSIVE MODE')
      const a = await loadAssemblee(client, id)
      if (!a) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ message: 'Assemblée introuvable' })
      }
      if (a.statut === 'close') {
        await client.query('ROLLBACK')
        return reply.code(409).send({ message: 'Assemblée déjà close' })
      }
      if (!a.resolutions.length) {
        await client.query('ROLLBACK')
        return reply.code(422).send({ message: 'Aucune résolution : rien à consigner au registre' })
      }
      // A text of the model left to complete, such as [montant]
      const aCompleter = a.resolutions.find((r) => /\[[^\]]*\]/.test(`${r.titre} ${r.texte}`))
      if (aCompleter) {
        await client.query('ROLLBACK')
        return reply.code(422).send({ message: `Résolution n° ${aCompleter.ordre} : texte à compléter (${/\[[^\]]*\]/.exec(`${aCompleter.titre} ${aCompleter.texte}`)![0]})` })
      }
      const { rows: [suivant] } = await client.query<{ numero: number }>(
        'SELECT coalesce(max(numero), 0) + 1 AS numero FROM assemblee')
      const numero = suivant!.numero
      const fige = { ...a, numero, statut: 'close' as const, close_le: new Date().toISOString() }
      await client.query(
        `UPDATE assemblee SET statut = 'close', numero = $2, close_le = $3, instantane = $4 WHERE id = $1`,
        [id, numero, fige.close_le, JSON.stringify({ assemblee: fige, societe: await loadSociete(client) })],
      )
      await client.query('COMMIT')
      return loadAssemblee(db, id)
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  })

  // The minutes: from the frozen meeting once closed, else a project from the draft
  app.get('/assemblees/:id/pv', async (request, reply) => {
    const id = idParam(request)
    const a = await loadAssemblee(db, id)
    if (!a) {
      return reply.code(404).send({ message: 'Assemblée introuvable' })
    }
    const { rows: [row] } = await db.query<{ instantane: { societe: Awaited<ReturnType<typeof loadSociete>> } | null }>(
      'SELECT instantane FROM assemblee WHERE id = $1', [id])
    const societe = row?.instantane ? row.instantane.societe : await loadSociete(db)
    const nom = a.numero ? `pv-${a.numero}-${a.date}` : `projet-pv-${a.date}`
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${nom}.pdf"`)
      .send(await pvPdf(a, societe))
  })

  // The signed minutes (scanned), attached to a closed meeting: the document of the register
  app.post('/assemblees/:id/pv-signe', async (request, reply) => {
    const id = idParam(request)
    const { rows: [a] } = await db.query<{ statut: string, pv_signe: string | null }>(
      'SELECT statut, pv_signe FROM assemblee WHERE id = $1', [id])
    if (!a) {
      return reply.code(404).send({ message: 'Assemblée introuvable' })
    }
    if (a.statut !== 'close') {
      return reply.code(409).send({ message: 'Le procès-verbal signé se joint à une assemblée close' })
    }
    const file = await request.file()
    if (!file) {
      return reply.code(400).send({ message: 'Aucun fichier reçu' })
    }
    const content = await file.toBuffer()
    if (!isPdf(content)) {
      return reply.code(415).send({ message: `${file.filename} n'est pas un PDF` })
    }
    const { fileName } = await storePdf(storageDir, content, 'assemblees')
    await db.query('UPDATE assemblee SET pv_signe = $2 WHERE id = $1', [id, fileName])
    if (a.pv_signe && a.pv_signe !== fileName) {
      await removeIfUnused(db, storageDir, a.pv_signe)
    }
    return loadAssemblee(db, id)
  })

  app.get('/assemblees/:id/pv-signe', async (request, reply) => {
    const { rows: [a] } = await db.query<{ pv_signe: string | null }>(
      'SELECT pv_signe FROM assemblee WHERE id = $1', [idParam(request)])
    if (!a?.pv_signe) {
      return reply.code(404).send({ message: 'Pas de procès-verbal signé' })
    }
    return reply.type('application/pdf').header('content-disposition', 'inline')
      .send(createReadStream(join(storageDir, a.pv_signe)))
  })
}

export default assembleeRoutes

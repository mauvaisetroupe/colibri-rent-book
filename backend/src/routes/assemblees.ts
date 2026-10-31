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

const TYPES = ['ordinary', 'extraordinary']
const PRESENCES = ['present', 'represented', 'absent']

const shares = (value: unknown, name: string) => {
  const n = Number(value ?? 0)
  if (!Number.isInteger(n) || n < 0) {
    throw new InputError(`${name} : nombre entier de parts attendu`)
  }
  return n
}

const assembleeRoutes: FastifyPluginAsync<{ db: Pool, storageDir: string }> = async (app, { db, storageDir }) => {
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } })

  const partners = async () => (await db.query<Associe>(
    'SELECT id, name, shares, manager, address, note FROM partner ORDER BY name',
  )).rows

  // ---------------------------------------------------------------- company and partners

  app.get('/societe', async () => ({ company: await loadSociete(db), partners: await partners() }))

  app.put('/societe', async (request, reply) => {
    try {
      const raw = body(request)
      await db.query(
        `INSERT INTO company (id, name, legal_form, capital, registered_office, rcs) VALUES (1, $1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET name = $1, legal_form = $2, capital = $3, registered_office = $4, rcs = $5`,
        [requiredText(raw.name, 'Dénomination'), optionalText(raw.legal_form) ?? 'SCI',
          optionalDecimal(raw.capital, 'Capital'), optionalText(raw.registered_office), optionalText(raw.rcs)],
      )
      return { company: await loadSociete(db), partners: await partners() }
    } catch (error) {
      return sendError(reply, error)
    }
  })

  const readAssocie = (raw: Record<string, unknown>) => {
    const n = shares(raw.shares, 'Parts')
    if (n === 0) {
      throw new InputError('Parts : au moins une')
    }
    return [requiredText(raw.name, 'Nom'), n, raw.manager === true, optionalText(raw.address), optionalText(raw.note)]
  }

  app.post('/associes', async (request, reply) => {
    try {
      const { rows: [a] } = await db.query(
        'INSERT INTO partner (name, shares, manager, address, note) VALUES ($1, $2, $3, $4, $5) RETURNING *',
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
        'UPDATE partner SET name = $2, shares = $3, manager = $4, address = $5, note = $6 WHERE id = $1 RETURNING *',
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
      await db.query('DELETE FROM attendance WHERE partner_id = $1', [idParam(request)])
      const { rowCount } = await db.query('DELETE FROM partner WHERE id = $1', [idParam(request)])
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
      `SELECT id, number, type, date::text, status, signed_minutes IS NOT NULL AS signed_minutes,
              coalesce((snapshot -> 'assemblee' -> 'resolutions')::jsonb, '[]'::jsonb) AS frozen,
              (SELECT count(*)::int FROM resolution r WHERE r.general_meeting_id = a.id) AS resolution_count
       FROM general_meeting a ORDER BY date DESC, id DESC`,
    )
    return rows.map(({ frozen, ...a }) => ({ ...a, resolution_count: a.status === 'closed' ? frozen.length : a.resolution_count }))
  })

  app.get('/assemblees/:id', async (request, reply) =>
    (await loadAssemblee(db, idParam(request))) ?? reply.code(404).send({ message: 'Assemblée introuvable' }))

  // A new draft: every partner present; with modele=annuelle, the agenda and resolutions of the annual meeting
  app.post('/assemblees', async (request, reply) => {
    try {
      const raw = body(request)
      const type = String(raw.type ?? 'ordinary')
      if (!TYPES.includes(type)) {
        throw new InputError('Type : ordinaire ou extraordinaire')
      }
      const date = requiredDate(raw.date, 'Date')
      const liste = await partners()
      const modele = raw.modele === 'annuelle'
        ? modeleAnnuel(raw.period ? requiredId(raw.period, 'Exercice') : Number(date.slice(0, 4)) - 1, liste)
        : { agenda: '', resolutions: [] }
      const manager = liste.find((a) => a.manager)
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        const { rows: [a] } = await client.query<{ id: number }>(
          `INSERT INTO general_meeting (type, date, place, agenda, chair) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [type, date, optionalText(raw.place), modele.agenda, manager?.name ?? null],
        )
        for (const partner of liste) {
          await client.query('INSERT INTO attendance (general_meeting_id, partner_id) VALUES ($1, $2)', [a!.id, partner.id])
        }
        for (const r of modele.resolutions) {
          await client.query(
            `INSERT INTO resolution (general_meeting_id, position, title, text, votes_for, votes_against, abstentions)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [a!.id, r.position, r.title, r.text, r.votes_for, r.votes_against, r.abstentions],
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
      const attendances = Array.isArray(raw.attendances) ? raw.attendances as Record<string, unknown>[] : []
      const resolutions = Array.isArray(raw.resolutions) ? raw.resolutions as Record<string, unknown>[] : []
      for (const p of attendances) {
        if (!PRESENCES.includes(String(p.status))) {
          throw new InputError('Présence : présent, représenté ou absent')
        }
      }
      await client.query('BEGIN')
      const { rows: [current] } = await client.query<{ status: string }>(
        'SELECT status FROM general_meeting WHERE id = $1 FOR UPDATE', [id])
      if (!current) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ message: 'Assemblée introuvable' })
      }
      if (current.status === 'closed') {
        await client.query('ROLLBACK')
        return reply.code(409).send({ message: 'Assemblée close : elle n\'est plus modifiable' })
      }
      await client.query(
        `UPDATE general_meeting SET type = $2, date = $3, time = $4, place = $5, agenda = $6, chair = $7,
                              remarks = $8 WHERE id = $1`,
        [id, type, requiredDate(raw.date, 'Date'), optionalText(raw.time), optionalText(raw.place),
          String(raw.agenda ?? ''), optionalText(raw.chair), optionalText(raw.remarks)],
      )
      for (const p of attendances) {
        await client.query(
          `UPDATE attendance SET status = $3, represented_by = $4 WHERE general_meeting_id = $1 AND partner_id = $2`,
          [id, requiredId(p.partner_id, 'Associé'), p.status, p.status === 'represented' ? optionalText(p.represented_by) : null],
        )
      }
      await client.query('DELETE FROM resolution WHERE general_meeting_id = $1', [id])
      for (const [i, r] of resolutions.entries()) {
        await client.query(
          `INSERT INTO resolution (general_meeting_id, position, title, text, votes_for, votes_against, abstentions)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, i + 1, requiredText(r.title, `Résolution ${i + 1}, titre`), String(r.text ?? ''),
            shares(r.votes_for, 'Pour'), shares(r.votes_against, 'Contre'), shares(r.abstentions, 'Abstention')],
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
    const { rows: [a] } = await db.query<{ status: string }>('SELECT status FROM general_meeting WHERE id = $1', [idParam(request)])
    if (!a) {
      return reply.code(404).send({ message: 'Assemblée introuvable' })
    }
    if (a.status === 'closed') {
      return reply.code(409).send({ message: 'Assemblée close : elle reste dans le registre' })
    }
    await db.query('DELETE FROM general_meeting WHERE id = $1', [idParam(request)])
    return reply.code(204).send()
  })

  // Closing: the next number of the register, the minutes frozen as they are
  app.post('/assemblees/:id/cloture', async (request, reply) => {
    const id = idParam(request)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      // One closing at a time: the numbers of the register follow each other without a gap
      await client.query('LOCK TABLE general_meeting IN SHARE ROW EXCLUSIVE MODE')
      const a = await loadAssemblee(client, id)
      if (!a) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ message: 'Assemblée introuvable' })
      }
      if (a.status === 'closed') {
        await client.query('ROLLBACK')
        return reply.code(409).send({ message: 'Assemblée déjà close' })
      }
      if (!a.resolutions.length) {
        await client.query('ROLLBACK')
        return reply.code(422).send({ message: 'Aucune résolution : rien à consigner au registre' })
      }
      // A text of the model left to complete, such as [montant]
      const aCompleter = a.resolutions.find((r) => /\[[^\]]*\]/.test(`${r.title} ${r.text}`))
      if (aCompleter) {
        await client.query('ROLLBACK')
        return reply.code(422).send({ message: `Résolution n° ${aCompleter.position} : texte à compléter (${/\[[^\]]*\]/.exec(`${aCompleter.title} ${aCompleter.text}`)![0]})` })
      }
      const { rows: [suivant] } = await client.query<{ number: number }>(
        'SELECT coalesce(max(number), 0) + 1 AS number FROM general_meeting')
      const number = suivant!.number
      const fige = { ...a, number, status: 'closed' as const, closed_at: new Date().toISOString() }
      await client.query(
        `UPDATE general_meeting SET status = 'closed', number = $2, closed_at = $3, snapshot = $4 WHERE id = $1`,
        [id, number, fige.closed_at, JSON.stringify({ general_meeting: fige, company: await loadSociete(client) })],
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
    const { rows: [row] } = await db.query<{ snapshot: { company: Awaited<ReturnType<typeof loadSociete>> } | null }>(
      'SELECT snapshot FROM general_meeting WHERE id = $1', [id])
    const company = row?.snapshot ? row.snapshot.company : await loadSociete(db)
    const name = a.number ? `pv-${a.number}-${a.date}` : `projet-pv-${a.date}`
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${name}.pdf"`)
      .send(await pvPdf(a, company))
  })

  // The signed minutes (scanned), attached to a closed meeting: the document of the register
  app.post('/assemblees/:id/pv-signe', async (request, reply) => {
    const id = idParam(request)
    const { rows: [a] } = await db.query<{ status: string, signed_minutes: string | null }>(
      'SELECT status, signed_minutes FROM general_meeting WHERE id = $1', [id])
    if (!a) {
      return reply.code(404).send({ message: 'Assemblée introuvable' })
    }
    if (a.status !== 'closed') {
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
    await db.query('UPDATE general_meeting SET signed_minutes = $2 WHERE id = $1', [id, fileName])
    if (a.signed_minutes && a.signed_minutes !== fileName) {
      await removeIfUnused(db, storageDir, a.signed_minutes)
    }
    return loadAssemblee(db, id)
  })

  app.get('/assemblees/:id/pv-signe', async (request, reply) => {
    const { rows: [a] } = await db.query<{ signed_minutes: string | null }>(
      'SELECT signed_minutes FROM general_meeting WHERE id = $1', [idParam(request)])
    if (!a?.signed_minutes) {
      return reply.code(404).send({ message: 'Pas de procès-verbal signé' })
    }
    return reply.type('application/pdf').header('content-disposition', 'inline')
      .send(createReadStream(join(storageDir, a.signed_minutes)))
  })
}

export default assembleeRoutes

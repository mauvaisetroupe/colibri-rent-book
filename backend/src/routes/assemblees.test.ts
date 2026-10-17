import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { promisify } from 'node:util'

import { PDFDocument } from 'pdf-lib'
import type pg from 'pg'

import { buildApp } from '../app.js'
import { createTestPool, resetDatabase, skipWithoutDatabase } from '../test/database.js'

// General meetings of a made-up company (ADR 0016): annual model, votes, closing numbered in the register and frozen,
// minutes in PDF, signed minutes attached.

const run = promisify(execFile)
const pdftotext = async (pdf: Buffer) => {
  const dir = await mkdtemp(join(tmpdir(), 'crb-pv-'))
  try {
    await writeFile(join(dir, 'pv.pdf'), pdf)
    return (await run('pdftotext', ['-layout', join(dir, 'pv.pdf'), '-'])).stdout.replace(/\s+/g, ' ')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
const hasPdftotext = await run('pdftotext', ['-v']).then(() => true, () => false)

describe('general meetings', { skip: skipWithoutDatabase }, () => {
  let pool: pg.Pool
  let app: Awaited<ReturnType<typeof buildApp>>
  let storageDir: string
  let associes: { id: number, nom: string }[]

  before(async () => {
    pool = createTestPool()
    await resetDatabase(pool)
    storageDir = await mkdtemp(join(tmpdir(), 'crb-pdf-'))
    app = await buildApp({ db: pool, storageDir })
    await app.inject({
      method: 'PUT', url: '/api/societe',
      payload: { denomination: 'SCI Exemple', forme: 'SCI', capital: '1000', siege: '1 rue de l\'Exemple, 75000 Paris', rcs: 'RCS Paris 000 000 000' },
    })
    for (const a of [{ nom: 'Alice Martin', parts: 50, gerant: true }, { nom: 'Bruno Martin', parts: 50, gerant: false }]) {
      assert.equal((await app.inject({ method: 'POST', url: '/api/associes', payload: a })).statusCode, 201)
    }
    associes = (await app.inject('/api/societe')).json().associes
  })

  after(async () => {
    await app.close()
    await pool.end()
    await rm(storageDir, { recursive: true, force: true })
  })

  const nouvelle = async (date: string) =>
    (await app.inject({ method: 'POST', url: '/api/assemblees', payload: { type: 'ordinaire', date, modele: 'annuelle', lieu: 'au siège' } })).json()

  test('the annual meeting is proposed: agenda, four resolutions, all partners present and in favour', async () => {
    const a = await nouvelle('2026-06-15')
    assert.equal(a.statut, 'brouillon')
    assert.equal(a.president, 'Alice Martin')
    assert.deepEqual([a.parts_total, a.parts_presentes], [100, 100])
    assert.match(a.ordre_du_jour, /1\. Approbation des comptes de l'exercice 2025/)
    assert.equal(a.resolutions.length, 4)
    assert.ok(a.resolutions.every((r: { unanimite: boolean }) => r.unanimite))
    assert.match(a.resolutions[1].texte, /Alice Martin : 50 parts sur 100 \(50 %\)/)
  })

  test('a draft is changed: an absent partner, a rejected resolution', async () => {
    const [{ id }] = (await app.inject('/api/assemblees')).json()
    const a = (await app.inject(`/api/assemblees/${id}`)).json()
    const changed = await app.inject({
      method: 'PUT', url: `/api/assemblees/${id}`,
      payload: {
        ...a,
        presences: a.presences.map((p: { associe_id: number }) => ({
          ...p, presence: p.associe_id === associes[1]!.id ? 'represente' : 'present', represente_par: 'Alice Martin',
        })),
        resolutions: [
          a.resolutions[0],
          { ...a.resolutions[1], texte: a.resolutions[1].texte.replace('[montant]', '12 345,67') },
          a.resolutions[2],
          { titre: 'Résolution soumise au vote', texte: 'Texte.', pour: 50, contre: 50, abstention: 0 },
        ],
      },
    })
    assert.equal(changed.statusCode, 200, changed.body)
    const r = changed.json().resolutions
    assert.deepEqual(r.map((x: { adoptee: boolean }) => x.adoptee), [true, true, true, false])
    assert.equal(changed.json().presences.find((p: { associe_id: number }) => p.associe_id === associes[1]!.id).represente_par, 'Alice Martin')
  })

  test('closing numbers the register and freezes the meeting', async () => {
    const [{ id }] = (await app.inject('/api/assemblees')).json()
    const close = await app.inject({ method: 'POST', url: `/api/assemblees/${id}/cloture` })
    assert.equal(close.statusCode, 200, close.body)
    assert.deepEqual([close.json().numero, close.json().statut], [1, 'close'])

    assert.equal((await app.inject({ method: 'PUT', url: `/api/assemblees/${id}`, payload: close.json() })).statusCode, 409)
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/assemblees/${id}` })).statusCode, 409)
    await assert.rejects(pool.query('UPDATE assemblee SET lieu = \'ailleurs\' WHERE id = $1', [id]), /n'est plus modifiée/)
    await assert.rejects(pool.query('DELETE FROM resolution WHERE assemblee_id = $1', [id]), /ne changent plus/)
    // A partner of the register is kept
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/associes/${associes[1]!.id}` })).statusCode, 409)
    // Renaming the company afterwards does not change the minutes frozen
    await app.inject({ method: 'PUT', url: '/api/societe', payload: { denomination: 'SCI Renommée' } })

    // The model leaves the result to complete: closing is refused until it is
    const second = await nouvelle('2027-06-15')
    const refus = await app.inject({ method: 'POST', url: `/api/assemblees/${second.id}/cloture` })
    assert.equal(refus.statusCode, 422)
    assert.match(refus.json().message, /Résolution n° 2 : texte à compléter \(\[montant\]\)/)
    await app.inject({
      method: 'PUT', url: `/api/assemblees/${second.id}`,
      payload: { ...second, resolutions: second.resolutions.map((r: { texte: string }) => ({ ...r, texte: r.texte.replace('[montant]', '0') })) },
    })
    assert.equal((await app.inject({ method: 'POST', url: `/api/assemblees/${second.id}/cloture` })).json().numero, 2)
  })

  test('the minutes in PDF: frozen once closed, a project for a draft', { skip: !hasPdftotext && 'pdftotext missing' }, async () => {
    const liste = (await app.inject('/api/assemblees')).json()
    const close = liste.find((a: { numero: number }) => a.numero === 1)
    const pv = await app.inject(`/api/assemblees/${close.id}/pv`)
    assert.equal(pv.headers['content-type'], 'application/pdf')
    const texte = await pdftotext(pv.rawPayload)
    assert.match(texte, /SCI Exemple/)
    assert.match(texte, /procès-verbal n° 1/)
    assert.match(texte, /Bruno Martin 50 50 % représenté par Alice Martin/)
    assert.match(texte, /adoptée à l'unanimité/)
    assert.match(texte, /s'élève à 12 345,67 €/)
    assert.match(texte, /Cette résolution est rejetée \(pour : 50 parts, contre : 50/)

    const brouillon = await nouvelle('2028-06-15')
    assert.match(await pdftotext((await app.inject(`/api/assemblees/${brouillon.id}/pv`)).rawPayload), /Projet – assemblée non close/)
  })

  test('the signed minutes are attached to a closed meeting only', async () => {
    const liste = (await app.inject('/api/assemblees')).json()
    const close = liste.find((a: { numero: number }) => a.numero === 1)
    const brouillon = liste.find((a: { statut: string }) => a.statut === 'brouillon')
    const pdf = await PDFDocument.create()
    pdf.addPage()
    const content = Buffer.from(await pdf.save())
    const envoyer = (id: number) => app.inject({
      method: 'POST', url: `/api/assemblees/${id}/pv-signe`,
      payload: Buffer.concat([
        Buffer.from('--b\r\nContent-Disposition: form-data; name="file"; filename="pv.pdf"\r\nContent-Type: application/pdf\r\n\r\n'),
        content, Buffer.from('\r\n--b--\r\n'),
      ]),
      headers: { 'content-type': 'multipart/form-data; boundary=b' },
    })
    assert.equal((await envoyer(brouillon.id)).statusCode, 409)
    assert.equal((await envoyer(close.id)).json().pv_signe, true)
    assert.deepEqual((await app.inject(`/api/assemblees/${close.id}/pv-signe`)).rawPayload, content)
  })
})

import type { Pool, PoolClient } from 'pg'

// General meetings of the company (ADR 0016): what a meeting is made of, its quorum and the outcome of each resolution,
// the resolutions proposed for the annual meeting, and the snapshot frozen at closing (what the minutes print).

export type Societe = {
  name: string
  legal_form: string
  capital: string | null
  registered_office: string | null
  rcs: string | null
}

export type Associe = { id: number, name: string, shares: number, manager: boolean, address: string | null, note: string | null }

export type Presence = {
  partner_id: number
  name: string
  shares: number
  manager: boolean
  status: 'present' | 'represented' | 'absent'
  represented_by: string | null
}

export type Resolution = {
  position: number
  title: string
  text: string
  votes_for: number
  votes_against: number
  abstentions: number
  // Computed: adopted when « pour » is more than half the parts present or represented (simple majority)
  adoptee: boolean
  unanimite: boolean
}

export type Assemblee = {
  id: number
  number: number | null
  type: 'ordinary' | 'extraordinary'
  date: string
  time: string | null
  place: string | null
  agenda: string
  chair: string | null
  remarks: string | null
  status: 'draft' | 'closed'
  closed_at: string | null
  signed_minutes: boolean
  // Parts of the company, and those present or represented (quorum)
  total_shares: number
  shares_present: number
  attendances: Presence[]
  resolutions: Resolution[]
}

/** What a closed meeting keeps: the meeting as it was, the company and its partners of that day. */
export type Instantane = { general_meeting: Assemblee, company: Societe | null }

type Db = Pool | PoolClient

export async function loadSociete(db: Db): Promise<Societe | null> {
  const { rows: [s] } = await db.query<Societe>(
    'SELECT name, legal_form, capital::text, registered_office, rcs FROM company WHERE id = 1',
  )
  return s ?? null
}

export const resultat = (r: Omit<Resolution, 'adoptee' | 'unanimite'>, partsPresentes: number) => ({
  ...r,
  adoptee: r.votes_for * 2 > partsPresentes,
  unanimite: partsPresentes > 0 && r.votes_for === partsPresentes,
})

/** A meeting, live from the tables (a draft), or as frozen at its closing. */
export async function loadAssemblee(db: Db, id: number): Promise<Assemblee | null> {
  const { rows: [a] } = await db.query<Omit<Assemblee, 'total_shares' | 'shares_present' | 'attendances' | 'resolutions'>
    & { snapshot: Instantane | null }>(
    `SELECT id, number, type, date::text, time, place, agenda, chair, remarks, status,
            closed_at::text, signed_minutes IS NOT NULL AS signed_minutes, snapshot
     FROM general_meeting WHERE id = $1`,
    [id],
  )
  if (!a) {
    return null
  }
  if (a.snapshot) {
    // The register: what was frozen, with the signed minutes attached since
    return { ...a.snapshot.general_meeting, signed_minutes: a.signed_minutes }
  }
  const { rows: attendances } = await db.query<Presence>(
    `SELECT p.partner_id, s.name, s.shares, s.manager, p.status, p.represented_by
     FROM attendance p JOIN partner s ON s.id = p.partner_id WHERE p.general_meeting_id = $1 ORDER BY s.name`,
    [id],
  )
  const { rows: [shares] } = await db.query<{ total: number }>('SELECT coalesce(sum(shares), 0)::int AS total FROM partner')
  const total = shares?.total ?? 0
  const partsPresentes = attendances.filter((p) => p.status !== 'absent').reduce((n, p) => n + p.shares, 0)
  const { rows } = await db.query<Omit<Resolution, 'adoptee' | 'unanimite'>>(
    'SELECT position, title, text, votes_for, votes_against, abstentions FROM resolution WHERE general_meeting_id = $1 ORDER BY position, id',
    [id],
  )
  const { snapshot: _, ...general_meeting } = a
  return {
    ...general_meeting,
    total_shares: total,
    shares_present: partsPresentes,
    attendances,
    resolutions: rows.map((r) => resultat(r, partsPresentes)),
  }
}

/** The usual agenda and resolutions of the annual meeting for a year, all partners present and in favour. */
export function modeleAnnuel(period: number, partners: Associe[]) {
  const total = partners.reduce((n, a) => n + a.shares, 0)
  const apportionment = partners
    .map((a) => `- ${a.name} : ${a.shares} parts sur ${total} (${Math.round((a.shares / total) * 10000) / 100} %)`)
    .join('\n')
  const resolutions = [
    {
      title: `Approbation des comptes de l'exercice ${period}`,
      text: `L'assemblée générale, après avoir entendu la lecture du rapport de la gérance, approuve les comptes de
l'exercice clos le 31 décembre ${period}, tels qu'ils lui ont été présentés.`,
    },
    {
      title: 'Affectation et répartition du résultat',
      text: `L'assemblée générale constate que le résultat de l'exercice ${period} s'élève à [montant] € et décide de le
répartir entre les associés au prorata de leurs parts :
${apportionment}`,
    },
    {
      title: 'Quitus à la gérance',
      text: `L'assemblée générale donne quitus entier et sans réserve à la gérance pour sa gestion au cours de l'exercice
${period}.`,
    },
    {
      title: 'Pouvoirs pour les formalités',
      text: `L'assemblée générale confère tous pouvoirs au porteur d'un original, d'une copie ou d'un extrait du présent
procès-verbal pour accomplir toutes les formalités nécessaires.`,
    },
  ].map((r, i) => ({ position: i + 1, ...r, text: r.text.replace(/\n(?!-)/g, ' '), votes_for: total, votes_against: 0, abstentions: 0 }))
  return {
    agenda: resolutions.map((r) => `${r.position}. ${r.title}`).join('\n'),
    resolutions,
  }
}

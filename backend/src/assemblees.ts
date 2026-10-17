import type { Pool, PoolClient } from 'pg'

// General meetings of the company (ADR 0016): what a meeting is made of, its quorum and the outcome of each resolution,
// the resolutions proposed for the annual meeting, and the snapshot frozen at closing (what the minutes print).

export type Societe = {
  denomination: string
  forme: string
  capital: string | null
  siege: string | null
  rcs: string | null
}

export type Associe = { id: number, nom: string, parts: number, gerant: boolean, adresse: string | null, note: string | null }

export type Presence = {
  associe_id: number
  nom: string
  parts: number
  gerant: boolean
  presence: 'present' | 'represente' | 'absent'
  represente_par: string | null
}

export type Resolution = {
  ordre: number
  titre: string
  texte: string
  pour: number
  contre: number
  abstention: number
  // Computed: adopted when « pour » is more than half the parts present or represented (simple majority)
  adoptee: boolean
  unanimite: boolean
}

export type Assemblee = {
  id: number
  numero: number | null
  type: 'ordinaire' | 'extraordinaire'
  date: string
  heure: string | null
  lieu: string | null
  ordre_du_jour: string
  president: string | null
  observations: string | null
  statut: 'brouillon' | 'close'
  close_le: string | null
  pv_signe: boolean
  // Parts of the company, and those present or represented (quorum)
  parts_total: number
  parts_presentes: number
  presences: Presence[]
  resolutions: Resolution[]
}

/** What a closed meeting keeps: the meeting as it was, the company and its partners of that day. */
export type Instantane = { assemblee: Assemblee, societe: Societe | null }

type Db = Pool | PoolClient

export async function loadSociete(db: Db): Promise<Societe | null> {
  const { rows: [s] } = await db.query<Societe>(
    'SELECT denomination, forme, capital::text, siege, rcs FROM societe WHERE id = 1',
  )
  return s ?? null
}

export const resultat = (r: Omit<Resolution, 'adoptee' | 'unanimite'>, partsPresentes: number) => ({
  ...r,
  adoptee: r.pour * 2 > partsPresentes,
  unanimite: partsPresentes > 0 && r.pour === partsPresentes,
})

/** A meeting, live from the tables (a draft), or as frozen at its closing. */
export async function loadAssemblee(db: Db, id: number): Promise<Assemblee | null> {
  const { rows: [a] } = await db.query<Omit<Assemblee, 'parts_total' | 'parts_presentes' | 'presences' | 'resolutions'>
    & { instantane: Instantane | null }>(
    `SELECT id, numero, type, date::text, heure, lieu, ordre_du_jour, president, observations, statut,
            close_le::text, pv_signe IS NOT NULL AS pv_signe, instantane
     FROM assemblee WHERE id = $1`,
    [id],
  )
  if (!a) {
    return null
  }
  if (a.instantane) {
    // The register: what was frozen, with the signed minutes attached since
    return { ...a.instantane.assemblee, pv_signe: a.pv_signe }
  }
  const { rows: presences } = await db.query<Presence>(
    `SELECT p.associe_id, s.nom, s.parts, s.gerant, p.presence, p.represente_par
     FROM presence p JOIN associe s ON s.id = p.associe_id WHERE p.assemblee_id = $1 ORDER BY s.nom`,
    [id],
  )
  const { rows: [parts] } = await db.query<{ total: number }>('SELECT coalesce(sum(parts), 0)::int AS total FROM associe')
  const total = parts?.total ?? 0
  const partsPresentes = presences.filter((p) => p.presence !== 'absent').reduce((n, p) => n + p.parts, 0)
  const { rows } = await db.query<Omit<Resolution, 'adoptee' | 'unanimite'>>(
    'SELECT ordre, titre, texte, pour, contre, abstention FROM resolution WHERE assemblee_id = $1 ORDER BY ordre, id',
    [id],
  )
  const { instantane: _, ...assemblee } = a
  return {
    ...assemblee,
    parts_total: total,
    parts_presentes: partsPresentes,
    presences,
    resolutions: rows.map((r) => resultat(r, partsPresentes)),
  }
}

/** The usual agenda and resolutions of the annual meeting for a year, all partners present and in favour. */
export function modeleAnnuel(exercice: number, associes: Associe[]) {
  const total = associes.reduce((n, a) => n + a.parts, 0)
  const repartition = associes
    .map((a) => `- ${a.nom} : ${a.parts} parts sur ${total} (${Math.round((a.parts / total) * 10000) / 100} %)`)
    .join('\n')
  const resolutions = [
    {
      titre: `Approbation des comptes de l'exercice ${exercice}`,
      texte: `L'assemblée générale, après avoir entendu la lecture du rapport de la gérance, approuve les comptes de
l'exercice clos le 31 décembre ${exercice}, tels qu'ils lui ont été présentés.`,
    },
    {
      titre: 'Affectation et répartition du résultat',
      texte: `L'assemblée générale constate que le résultat de l'exercice ${exercice} s'élève à [montant] € et décide de le
répartir entre les associés au prorata de leurs parts :
${repartition}`,
    },
    {
      titre: 'Quitus à la gérance',
      texte: `L'assemblée générale donne quitus entier et sans réserve à la gérance pour sa gestion au cours de l'exercice
${exercice}.`,
    },
    {
      titre: 'Pouvoirs pour les formalités',
      texte: `L'assemblée générale confère tous pouvoirs au porteur d'un original, d'une copie ou d'un extrait du présent
procès-verbal pour accomplir toutes les formalités nécessaires.`,
    },
  ].map((r, i) => ({ ordre: i + 1, ...r, texte: r.texte.replace(/\n(?!-)/g, ' '), pour: total, contre: 0, abstention: 0 }))
  return {
    ordre_du_jour: resolutions.map((r) => `${r.ordre}. ${r.titre}`).join('\n'),
    resolutions,
  }
}

import type { Pool } from 'pg'

import { inclusiveBounds } from './periods.js'
import { frenchDate } from './format.js'

// Reading the statements computed by the SQL engine (repartition, decompte, synthese: never re-implemented here)
// and the checks around them: periods not covered by validated invoices, overlaps, drafts, provisions (SPEC R1, R9).

export type Exercice = { immeuble: number, debut: string, fin: string }

const AMOUNTS = [
  'gaz_consommation', 'gaz_autres', 'electricite_consommation', 'electricite_autres', 'eau', 'ordures_menageres',
  'total', 'provisions', 'solde',
] as const

export type DecompteRow = {
  sejour_id: number
  locataire: string
  lot: string
  tantiemes: number
  present_du: string | null
  present_au: string | null
  jours: number
} & Record<typeof AMOUNTS[number], string>

export type SyntheseRow = { energie: string, factures: string, locataires: string, proprietaire: string }

/** Statement per stay and summary per energy. Amounts are unrounded numeric text: rounding is for display only. */
export async function loadDecompte(db: Pool, { immeuble, debut, fin }: Exercice) {
  const { rows: sejours } = await db.query<DecompteRow>(
    `SELECT sejour_id, locataire, lot, tantiemes, ${inclusiveBounds('present', 'present_du', 'present_au')}, jours,
            ${AMOUNTS.map((a) => `${a}::text`).join(', ')}
     FROM decompte($1, $2, $3)`,
    [immeuble, debut, fin],
  )
  const { rows: synthese } = await db.query<SyntheseRow>(
    `SELECT energie, factures::text, locataires::text, proprietaire::text FROM synthese($1, $2, $3)`,
    [immeuble, debut, fin],
  )
  return { sejours, synthese }
}

export type DetailFilter = {
  // A stay id, 'proprietaire' for the vacancy share, or undefined for everything
  sejour?: number | 'proprietaire'
  energie?: string
  // Gas and electricity only: consumption or the other lines, as in the statement columns
  groupe?: 'consommation' | 'autres'
}

/** Line-by-line detail of the allocation (function repartition). */
export async function loadDetail(db: Pool, { immeuble, debut, fin }: Exercice, filter: DetailFilter = {}) {
  // repartition() gives one owner row per invoice line, most of them at zero when no lot was vacant
  const conditions: string[] = ['NOT (r.sejour_id IS NULL AND r.montant = 0)']
  const params: unknown[] = [immeuble, debut, fin]
  if (filter.sejour === 'proprietaire') {
    conditions.push('r.sejour_id IS NULL')
  } else if (filter.sejour !== undefined) {
    params.push(filter.sejour)
    conditions.push(`r.sejour_id = $${params.length}`)
  }
  if (filter.energie) {
    params.push(filter.energie)
    conditions.push(`r.energie = $${params.length}::energie`)
  }
  if (filter.groupe) {
    conditions.push(filter.groupe === 'consommation' ? 'r.categorie = \'consommation\'' : 'r.categorie <> \'consommation\'')
  }
  const { rows } = await db.query(
    `SELECT r.ligne_id, r.facture_id, fo.nom AS fournisseur, f.numero, f.date_facture::text, r.energie, r.categorie,
            l.libelle, ${inclusiveBounds('l.periode')}, nb_jours(l.periode) AS jours_ligne, l.montant_ttc::text AS montant_ligne,
            r.sejour_id, lo.nom AS locataire, lt.code AS lot, r.jours, r.montant::text
     FROM repartition($1, $2, $3) r
     JOIN ligne_facture l ON l.id = r.ligne_id
     JOIN facture f ON f.id = r.facture_id
     JOIN fournisseur fo ON fo.id = f.fournisseur_id
     LEFT JOIN sejour s ON s.id = r.sejour_id
     LEFT JOIN locataire lo ON lo.id = s.locataire_id
     LEFT JOIN lot lt ON lt.id = s.lot_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY r.energie, lower(l.periode), f.numero, l.ordre, lt.code NULLS LAST`,
    params,
  )
  return rows
}

// Lines that tell whether a period is covered: consumption for gas and electricity (subscriptions are billed in
// advance, taxes overlap by design), every recoverable line for the other energies.
const COVERING_LINES = `
  SELECT l.id, f.id AS facture_id, f.energie, f.numero, fo.nom AS fournisseur, l.libelle, l.periode
  FROM ligne_facture l
  JOIN facture f ON f.id = l.facture_id
  JOIN fournisseur fo ON fo.id = f.fournisseur_id
  WHERE f.immeuble_id = $1 AND f.statut = 'validee' AND l.affectation = 'recuperable'
    AND (f.energie NOT IN ('gaz', 'electricite') OR l.categorie = 'consommation')
    AND l.periode && daterange($2::date, $3::date, '[]')`

export type Plage = { debut: string, fin: string }

/**
 * For each energy billed to the building: the parts of the exercise covered by validated invoices and the gaps,
 * the covering lines that overlap each other (counted twice), and the drafts that touch the exercise.
 */
export async function loadCouverture(db: Pool, { immeuble, debut, fin }: Exercice) {
  const params = [immeuble, debut, fin]
  const { rows: plages } = await db.query<{ energie: string, type: 'couvert' | 'trou' } & Plage>(
    `WITH exo AS (SELECT daterange($2::date, $3::date, '[]') AS r),
     energies AS (SELECT DISTINCT energie FROM facture WHERE immeuble_id = $1),
     lig AS (${COVERING_LINES}),
     agg AS (
       SELECT e.energie, coalesce(range_agg(lig.periode * exo.r), '{}'::datemultirange) AS couvert
       FROM energies e CROSS JOIN exo LEFT JOIN lig ON lig.energie = e.energie
       GROUP BY e.energie
     )
     SELECT agg.energie, 'couvert' AS type, ${inclusiveBounds('p')} FROM agg CROSS JOIN unnest(agg.couvert) p
     UNION ALL
     SELECT agg.energie, 'trou', ${inclusiveBounds('p')}
     FROM agg CROSS JOIN exo CROSS JOIN unnest(datemultirange(exo.r) - agg.couvert) p
     ORDER BY 1, 3`,
    params,
  )

  const energies = new Map<string, { energie: string, couvert: Plage[], trous: Plage[] }>()
  for (const { energie, type, debut: d, fin: f } of plages) {
    const entry = energies.get(energie) ?? { energie, couvert: [], trous: [] }
    entry[type === 'couvert' ? 'couvert' : 'trous'].push({ debut: d, fin: f })
    energies.set(energie, entry)
  }
  // An energy without any covering line in the exercise still shows a single gap
  const { rows: billed } = await db.query<{ energie: string }>(
    'SELECT DISTINCT energie FROM facture WHERE immeuble_id = $1 ORDER BY energie',
    [immeuble],
  )
  for (const { energie } of billed) {
    if (!energies.has(energie)) {
      energies.set(energie, { energie, couvert: [], trous: [{ debut, fin }] })
    }
  }

  const { rows: chevauchements } = await db.query(
    `WITH lig AS (${COVERING_LINES})
     SELECT a.energie, ${inclusiveBounds('a.periode * b.periode * daterange($2::date, $3::date, \'[]\')')},
            json_build_object('facture_id', a.facture_id, 'fournisseur', a.fournisseur, 'numero', a.numero,
              'libelle', a.libelle, 'debut', lower(a.periode), 'fin', upper(a.periode) - 1) AS ligne_a,
            json_build_object('facture_id', b.facture_id, 'fournisseur', b.fournisseur, 'numero', b.numero,
              'libelle', b.libelle, 'debut', lower(b.periode), 'fin', upper(b.periode) - 1) AS ligne_b
     FROM lig a JOIN lig b ON a.energie = b.energie AND a.id < b.id AND a.periode && b.periode
     WHERE NOT isempty(a.periode * b.periode * daterange($2::date, $3::date, '[]'))
     ORDER BY a.energie, lower(a.periode * b.periode)`,
    params,
  )

  const { rows: brouillons } = await db.query(
    `SELECT f.id, fo.nom AS fournisseur, f.numero, f.energie, f.date_facture::text
     FROM facture f JOIN fournisseur fo ON fo.id = f.fournisseur_id
     WHERE f.immeuble_id = $1 AND f.statut = 'a_verifier'
       AND EXISTS (SELECT 1 FROM ligne_facture l WHERE l.facture_id = f.id AND l.periode && daterange($2::date, $3::date, '[]'))
     ORDER BY f.date_facture`,
    params,
  )

  return { energies: [...energies.values()], chevauchements, brouillons }
}

const NOMS_ENERGIES: Record<string, string> = {
  gaz: 'Gaz', electricite: 'Électricité', eau: 'Eau', ordures_menageres: 'Ordures ménagères', autre: 'Autre',
}


/** Warnings shown above a statement: what could make it wrong or incomplete. */
export async function avertissements(
  db: Pool,
  exercice: Exercice,
  sejours: DecompteRow[],
  couverture: Awaited<ReturnType<typeof loadCouverture>>,
): Promise<string[]> {
  const result: string[] = []
  const { debut, fin } = exercice

  if (!debut.endsWith('-01-01') || !fin.endsWith('-12-31')) {
    result.push('Les provisions sont saisies par année civile (R9) : un exercice qui ne va pas du 1er janvier au '
      + '31 décembre compte les provisions des années entières.')
  }
  for (const b of couverture.brouillons) {
    result.push(`Facture ${b.fournisseur} n° ${b.numero} encore en brouillon : elle n'est pas comptée.`)
  }
  for (const e of couverture.energies) {
    for (const trou of e.trous) {
      result.push(`${NOMS_ENERGIES[e.energie] ?? e.energie} : aucune facture validée du ${frenchDate(trou.debut)} `
        + `au ${frenchDate(trou.fin)}.`)
    }
  }
  if (couverture.chevauchements.length) {
    result.push(`${couverture.chevauchements.length} chevauchement(s) entre factures : une période est peut-être `
      + 'comptée deux fois (voir Contrôles).')
  }

  // Provisions are entered per stay and calendar year: a present stay without any amount for a year is suspicious
  const presents = sejours.filter((s) => s.jours > 0)
  if (presents.length) {
    const { rows } = await db.query<{ sejour_id: number, annee: number }>(
      `SELECT s.id AS sejour_id, y.annee
       FROM sejour s
       CROSS JOIN generate_series(extract(year FROM $2::date)::int, extract(year FROM $3::date)::int) AS y(annee)
       WHERE s.id = ANY($1)
         AND s.periode && daterange(make_date(y.annee, 1, 1), make_date(y.annee, 12, 31), '[]')
         AND s.periode && daterange($2::date, $3::date, '[]')
         AND NOT EXISTS (SELECT 1 FROM v_provision p WHERE p.sejour_id = s.id AND p.annee = y.annee)
       ORDER BY y.annee`,
      [presents.map((s) => s.sejour_id), debut, fin],
    )
    for (const { sejour_id, annee } of rows) {
      const sejour = presents.find((s) => s.sejour_id === sejour_id)
      result.push(`Aucune provision saisie pour ${sejour?.locataire} (${sejour?.lot}) en ${annee}.`)
    }
  }
  return result
}

import Big from 'big.js'
import type { Pool } from 'pg'

import { loadDecompte, loadDetail, type Exercice } from './statements.js'

// Supporting document of a tenant's statement (SPEC § 8). The amounts are those of the statement row (decompte),
// unrounded; this object is also what a regularisation freezes (ADR 0007).

export const RUBRIQUES = [
  { colonne: 'gaz_consommation', libelle: 'Gaz – consommation', energie: 'gaz', consommation: true },
  { colonne: 'gaz_autres', libelle: 'Gaz – abonnement, taxes, locations', energie: 'gaz', consommation: false },
  { colonne: 'electricite_consommation', libelle: 'Électricité des communs – consommation', energie: 'electricite', consommation: true },
  { colonne: 'electricite_autres', libelle: 'Électricité des communs – abonnement, taxes', energie: 'electricite', consommation: false },
  { colonne: 'eau', libelle: 'Eau', energie: 'eau', consommation: null },
  { colonne: 'ordures_menageres', libelle: 'Taxe d\'enlèvement des ordures ménagères', energie: 'ordures_menageres', consommation: null },
] as const

export type Justificatif = {
  immeuble: { nom: string, adresse: string | null, total_tantiemes: number }
  exercice: { debut: string, fin: string }
  sejour: {
    id: number
    locataire: string
    lot: string
    designation: string | null
    tantiemes: number
    present_du: string | null
    present_au: string | null
    jours: number
    jours_exercice: number
  }
  rubriques: { libelle: string, depenses_immeuble: string, quote_part: string }[]
  total: string
  provisions: string
  solde: string
  factures: {
    facture_id: number
    fournisseur: string
    numero: string
    date_facture: string
    energie: string
    debut: string
    fin: string
    montant_facture: string
    quote_part: string
  }[]
  genere_le: string
}

export class SejourHorsExercice extends Error {}

export async function buildJustificatif(db: Pool, exercice: Exercice, sejourId: number): Promise<Justificatif> {
  const { immeuble, debut, fin } = exercice
  const { sejours } = await loadDecompte(db, exercice)
  const row = sejours.find((s) => s.sejour_id === sejourId)
  if (!row) {
    throw new SejourHorsExercice('Ce séjour ne figure pas dans le décompte de cet exercice')
  }

  const { rows: [info] } = await db.query<{
    nom: string, adresse: string | null, total_tantiemes: number, designation: string | null, jours_exercice: number,
  }>(
    `SELECT i.nom, i.adresse, (SELECT sum(tantiemes)::int FROM lot WHERE immeuble_id = i.id) AS total_tantiemes,
            lt.designation, ($3::date - $2::date + 1) AS jours_exercice
     FROM sejour s JOIN lot lt ON lt.id = s.lot_id JOIN immeuble i ON i.id = lt.immeuble_id
     WHERE s.id = $1 AND i.id = $4`,
    [sejourId, debut, fin, immeuble],
  )
  if (!info) {
    throw new SejourHorsExercice('Séjour inconnu pour cet immeuble')
  }

  // Building expenses of the exercise per heading: every share, tenants and owner (vacancy) together
  const { rows: depenses } = await db.query<{ energie: string, consommation: boolean, montant: string }>(
    `SELECT energie, categorie = 'consommation' AS consommation, sum(montant)::text AS montant
     FROM repartition($1, $2, $3) GROUP BY 1, 2`,
    [immeuble, debut, fin],
  )
  const depense = (energie: string, consommation: boolean | null) => depenses
    .filter((d) => d.energie === energie && (consommation === null || d.consommation === consommation))
    .reduce((sum, d) => sum.plus(d.montant), new Big(0))
    .toString()

  // Invoices behind the tenant's share, with the span of the lines retained and the share of each invoice
  const detail = await loadDetail(db, exercice, { sejour: sejourId })
  const parFacture = new Map<number, Justificatif['factures'][number]>()
  for (const line of detail) {
    // Days actually retained for the tenant: the line period within the presence (itself within the exercise)
    const d = {
      ...line,
      debut: row.present_du && row.present_du > line.debut ? row.present_du : line.debut,
      fin: row.present_au && row.present_au < line.fin ? row.present_au : line.fin,
    }
    const f = parFacture.get(d.facture_id)
    if (f) {
      f.debut = d.debut < f.debut ? d.debut : f.debut
      f.fin = d.fin > f.fin ? d.fin : f.fin
      f.quote_part = new Big(f.quote_part).plus(d.montant).toString()
    } else {
      parFacture.set(d.facture_id, {
        facture_id: d.facture_id, fournisseur: d.fournisseur, numero: d.numero, date_facture: d.date_facture,
        energie: d.energie, debut: d.debut, fin: d.fin, montant_facture: '', quote_part: new Big(d.montant).toString(),
      })
    }
  }
  if (parFacture.size) {
    const { rows } = await db.query<{ id: number, montant_ttc: string }>(
      'SELECT id, montant_ttc::text FROM facture WHERE id = ANY($1)',
      [[...parFacture.keys()]],
    )
    for (const r of rows) {
      parFacture.get(r.id)!.montant_facture = r.montant_ttc
    }
  }
  const ordreEnergie = RUBRIQUES.map((r) => r.energie as string)
  const factures = [...parFacture.values()].sort((a, b) =>
    ordreEnergie.indexOf(a.energie) - ordreEnergie.indexOf(b.energie) || a.debut.localeCompare(b.debut))

  return {
    immeuble: { nom: info.nom, adresse: info.adresse, total_tantiemes: info.total_tantiemes },
    exercice: { debut, fin },
    sejour: {
      id: sejourId,
      locataire: row.locataire,
      lot: row.lot,
      designation: info.designation,
      tantiemes: row.tantiemes,
      present_du: row.present_du,
      present_au: row.present_au,
      jours: row.jours,
      jours_exercice: info.jours_exercice,
    },
    rubriques: RUBRIQUES.map((r) => ({
      libelle: r.libelle,
      depenses_immeuble: depense(r.energie, r.consommation),
      quote_part: row[r.colonne],
    })),
    total: row.total,
    provisions: row.provisions,
    solde: row.solde,
    factures,
    genere_le: new Date().toISOString().slice(0, 10),
  }
}


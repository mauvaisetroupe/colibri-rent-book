-- =====================================================================
-- Moteur de répartition
--   part = TTC × jours(ligne ∩ séjour ∩ exercice) ÷ jours(ligne) × tantièmes du lot ÷ total tantièmes
--   la part des jours sans locataire reste au propriétaire (sejour_id NULL)
-- Les bornes p_debut / p_fin de l'exercice sont INCLUSES.
-- =====================================================================

CREATE OR REPLACE FUNCTION nb_jours(r daterange) RETURNS int
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN isempty(r) THEN 0 ELSE upper(r) - lower(r) END $$;

-- Détail : une ligne par (ligne de facture, séjour), plus une ligne « propriétaire » par ligne de facture.
CREATE OR REPLACE FUNCTION repartition(p_immeuble int, p_debut date, p_fin date)
RETURNS TABLE (ligne_id int, facture_id int, energie energie, categorie categorie_ligne,
               sejour_id int, jours int, montant numeric)
LANGUAGE sql STABLE AS $$
WITH exo AS (SELECT daterange(p_debut, p_fin + 1) AS r),
tot AS (SELECT sum(tantiemes)::numeric AS t FROM lot WHERE immeuble_id = p_immeuble),
lig AS (
  SELECT l.id, l.facture_id, f.energie, l.categorie, l.montant_ttc,
         nb_jours(l.periode) AS n, l.periode * exo.r AS pe
  FROM ligne_facture l
  JOIN facture f ON f.id = l.facture_id AND f.immeuble_id = p_immeuble
  CROSS JOIN exo
  WHERE l.recuperable AND l.periode && exo.r
),
parts AS (
  SELECT lig.id, lig.facture_id, lig.energie, lig.categorie, s.id AS sejour_id,
         nb_jours(lig.pe * s.periode) AS jours,
         lig.montant_ttc * nb_jours(lig.pe * s.periode) / lig.n * lt.tantiemes / tot.t AS montant
  FROM lig
  JOIN sejour s ON s.periode && lig.pe
  JOIN lot lt ON lt.id = s.lot_id AND lt.immeuble_id = p_immeuble
  CROSS JOIN tot
)
SELECT id, facture_id, energie, categorie, sejour_id, jours, montant FROM parts
UNION ALL
SELECT lig.id, lig.facture_id, lig.energie, lig.categorie, NULL, nb_jours(lig.pe),
       lig.montant_ttc * nb_jours(lig.pe) / lig.n
         - coalesce((SELECT sum(p.montant) FROM parts p WHERE p.id = lig.id), 0)
FROM lig
$$;

-- Décompte par séjour, mêmes colonnes que la feuille « Décompte » du classeur.
CREATE OR REPLACE FUNCTION decompte(p_immeuble int, p_debut date, p_fin date)
RETURNS TABLE (sejour_id int, locataire text, lot text, tantiemes int, present daterange, jours int,
               gaz_consommation numeric, gaz_autres numeric,
               electricite_consommation numeric, electricite_autres numeric,
               eau numeric, ordures_menageres numeric,
               total numeric, provisions numeric, solde numeric)
LANGUAGE sql STABLE AS $$
WITH r AS (SELECT * FROM repartition(p_immeuble, p_debut, p_fin) WHERE sejour_id IS NOT NULL),
agg AS (
  SELECT r.sejour_id,
    coalesce(sum(montant) FILTER (WHERE energie = 'gaz' AND categorie = 'consommation'), 0)          AS gc,
    coalesce(sum(montant) FILTER (WHERE energie = 'gaz' AND categorie <> 'consommation'), 0)         AS ga,
    coalesce(sum(montant) FILTER (WHERE energie = 'electricite' AND categorie = 'consommation'), 0)  AS ec,
    coalesce(sum(montant) FILTER (WHERE energie = 'electricite' AND categorie <> 'consommation'), 0) AS ea,
    coalesce(sum(montant) FILTER (WHERE energie = 'eau'), 0)                                         AS eau,
    coalesce(sum(montant) FILTER (WHERE energie = 'ordures_menageres'), 0)                           AS om
  FROM r GROUP BY r.sejour_id
),
prov AS (
  SELECT pa.sejour_id, sum(pa.montant) AS m FROM provision_annuelle pa
  WHERE pa.annee BETWEEN extract(year FROM p_debut) AND extract(year FROM p_fin)
  GROUP BY pa.sejour_id
)
SELECT s.id, lo.nom, lt.code, lt.tantiemes,
       s.periode * daterange(p_debut, p_fin + 1),
       nb_jours(s.periode * daterange(p_debut, p_fin + 1)),
       coalesce(a.gc, 0), coalesce(a.ga, 0), coalesce(a.ec, 0), coalesce(a.ea, 0),
       coalesce(a.eau, 0), coalesce(a.om, 0),
       coalesce(a.gc + a.ga + a.ec + a.ea + a.eau + a.om, 0),
       coalesce(p.m, 0),
       coalesce(a.gc + a.ga + a.ec + a.ea + a.eau + a.om, 0) - coalesce(p.m, 0)
FROM sejour s
JOIN lot lt ON lt.id = s.lot_id AND lt.immeuble_id = p_immeuble
JOIN locataire lo ON lo.id = s.locataire_id
LEFT JOIN agg a ON a.sejour_id = s.id
LEFT JOIN prov p ON p.sejour_id = s.id
WHERE s.periode && daterange(p_debut, p_fin + 1) OR p.m IS NOT NULL
ORDER BY lt.code, lower(s.periode)
$$;

-- Synthèse par énergie : total des factures de l'exercice, part des locataires, part du propriétaire (vacance).
CREATE OR REPLACE FUNCTION synthese(p_immeuble int, p_debut date, p_fin date)
RETURNS TABLE (energie energie, factures numeric, locataires numeric, proprietaire numeric)
LANGUAGE sql STABLE AS $$
SELECT energie,
       sum(montant),
       coalesce(sum(montant) FILTER (WHERE sejour_id IS NOT NULL), 0),
       coalesce(sum(montant) FILTER (WHERE sejour_id IS NULL), 0)
FROM repartition(p_immeuble, p_debut, p_fin)
GROUP BY energie ORDER BY energie
$$;

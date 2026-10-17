-- ADR 0003: only validated invoices enter the allocation (drafts stay out of every statement).
BEGIN;

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
  JOIN facture f ON f.id = l.facture_id AND f.immeuble_id = p_immeuble AND f.statut = 'validee'
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

COMMIT;

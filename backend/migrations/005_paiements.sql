-- ADR 0008: payments received (monthly rent and provision, regularisation payments), provisions computed from
-- them, security deposit kept for charges.
BEGIN;

-- Payments received from tenants (ADR 0008): rent and provision of a month, and/or an amount toward a
-- regularisation (negative: refund paid by the owner). One row per payment received (a bank transfer, a cheque).
CREATE TABLE paiement (
  id                 serial PRIMARY KEY,
  sejour_id          int  NOT NULL REFERENCES sejour(id),
  date_paiement      date NOT NULL,
  mois               date CHECK (mois IS NULL OR extract(day FROM mois) = 1),  -- month of rent covered (1st day)
  loyer              numeric(12,2) NOT NULL DEFAULT 0,
  provision          numeric(12,2) NOT NULL DEFAULT 0,                         -- provision sur charges
  regularisation_id  int REFERENCES regularisation(id),
  regularisation     numeric(12,2) NOT NULL DEFAULT 0,
  mode               text CHECK (mode IN ('virement', 'prelevement', 'cheque', 'especes', 'autre')),
  note               text,
  CHECK (mois IS NOT NULL OR (loyer = 0 AND provision = 0)),
  CHECK (regularisation_id IS NOT NULL OR regularisation = 0)
);
CREATE INDEX ON paiement (sejour_id, mois);
CREATE INDEX ON paiement (regularisation_id);

-- Provisions per stay and calendar year (SPEC R9): the sum of the monthly payments when the year has any,
-- otherwise the yearly total entered by hand (history before monthly payments).
CREATE VIEW v_provision AS
WITH payees AS (
  SELECT sejour_id, extract(year FROM mois)::int AS annee, sum(provision) AS montant
  FROM paiement WHERE mois IS NOT NULL GROUP BY 1, 2
)
SELECT p.sejour_id, p.annee, p.montant, 'paiements'::text AS source FROM payees p
UNION ALL
SELECT a.sejour_id, a.annee, a.montant, 'saisie' FROM provision_annuelle a
WHERE NOT EXISTS (SELECT 1 FROM payees p WHERE p.sejour_id = a.sejour_id AND p.annee = a.annee);

-- Amount paid toward a regularisation, including the payments made on the ones it replaces (corrective chain)
CREATE FUNCTION regularisation_verse(p_id int) RETURNS numeric
LANGUAGE sql STABLE AS $$
WITH RECURSIVE chaine AS (
  SELECT id, remplace_id FROM regularisation WHERE id = p_id
  UNION ALL
  SELECT r.id, r.remplace_id FROM regularisation r JOIN chaine c ON r.id = c.remplace_id
)
SELECT coalesce(sum(p.regularisation), 0) FROM paiement p WHERE p.regularisation_id IN (SELECT id FROM chaine)
$$;

-- Security deposit received at entry, and the part kept for unpaid charges at exit (SPEC § 9)
ALTER TABLE sejour
  ADD COLUMN depot_garantie numeric(12,2),
  ADD COLUMN depot_retenu_charges numeric(12,2);

-- Amounts already received on regularisations become payments; the column is now computed (regularisation_verse)
INSERT INTO paiement (sejour_id, date_paiement, regularisation_id, regularisation, note)
SELECT sejour_id, coalesce(date_solde, date_envoi, current_date), id, montant_recu, 'Reprise du montant reçu'
FROM regularisation WHERE montant_recu <> 0;
ALTER TABLE regularisation DROP COLUMN montant_recu;

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
  SELECT pa.sejour_id, sum(pa.montant) AS m FROM v_provision pa
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

COMMIT;

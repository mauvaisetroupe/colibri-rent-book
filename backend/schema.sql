-- Full current schema of Colibri (PostgreSQL >= 14). Creates a fresh database.
-- Built from migrations 001 to 005: any new migration must also be reported here (see migrations/README.md).

-- =====================================================================
-- Gestion des charges locatives – schéma PostgreSQL (≥ 14)
-- Conventions :
--   * toutes les périodes sont des daterange semi-ouverts '[debut, fin+1)'
--     (une ligne « du 01/01 au 31/01 » est stockée '[2025-01-01,2025-02-01)')
--   * montants : numeric, jamais de float ; on arrondit uniquement à l'affichage
--   * un séjour en cours a une borne supérieure infinie (upper(periode) IS NULL)
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE energie AS ENUM ('gaz', 'electricite', 'eau', 'ordures_menageres', 'autre');
CREATE TYPE categorie_ligne AS ENUM ('consommation', 'abonnement', 'taxe', 'prestation', 'penalite', 'autre');
CREATE TYPE statut_facture AS ENUM ('a_verifier', 'validee');
-- ADR 0013 : récupérable (réparti), à la charge du propriétaire (pénalités, taxe foncière hors TEOM : synthèse fiscale),
-- hors immeuble (concerne un autre bien : ni réparti, ni dans la synthèse fiscale de l'immeuble)
CREATE TYPE affectation_ligne AS ENUM ('recuperable', 'proprietaire', 'hors_immeuble');
-- Decision of the owner on a sent regularisation (ADR 0010); its state (draft, waiting, settled) is computed
CREATE TYPE decision_regul AS ENUM ('abandonnee', 'irrecouvrable');

-- ---------------------------------------------------------------- référentiel
CREATE TABLE immeuble (
  id          serial PRIMARY KEY,
  code        text NOT NULL UNIQUE,              -- court et unique : 'IMM1', 'MAISON'…
  nom         text NOT NULL,
  adresse     text
);

CREATE TABLE lot (
  id          serial PRIMARY KEY,
  immeuble_id int  NOT NULL REFERENCES immeuble(id),
  code        text NOT NULL,                     -- 'Lot 1'
  designation text,
  surface_m2  numeric(7,2),
  tantiemes   int  NOT NULL CHECK (tantiemes > 0),
  UNIQUE (immeuble_id, code)
);

CREATE TABLE locataire (
  id          serial PRIMARY KEY,
  nom         text NOT NULL UNIQUE,
  email       text,
  telephone   text,
  note        text
);

-- Un séjour = un locataire dans un lot sur une période (entrée → sortie incluses).
CREATE TABLE sejour (
  id           serial PRIMARY KEY,
  lot_id       int  NOT NULL REFERENCES lot(id),
  locataire_id int  NOT NULL REFERENCES locataire(id),
  periode      daterange NOT NULL CHECK (NOT isempty(periode) AND lower(periode) IS NOT NULL),
  note         text,
  depot_garantie        numeric(12,2),        -- dépôt de garantie reçu (ADR 0008)
  depot_retenu_charges  numeric(12,2),        -- part conservée au départ pour des charges impayées (SPEC § 9)
  -- deux séjours ne peuvent pas se chevaucher sur le même lot
  EXCLUDE USING gist (lot_id WITH =, periode WITH &&)
);

-- ---------------------------------------------------------------- factures
CREATE TABLE fournisseur (
  id   serial PRIMARY KEY,
  nom  text NOT NULL UNIQUE,                     -- 'EDF', 'ENGIE', 'SEAFF', 'DGFiP (taxe foncière)'
  -- ADR 0014 : factures jamais jointes au justificatif (données fiscales, autres biens), « consultable sur demande »
  confidentiel boolean NOT NULL DEFAULT false
);

-- ADR 0013 : extracteurs de factures, code TypeScript écrit dans l'application et exécuté dans le navigateur ;
-- jamais modifiés ni supprimés : corriger un extracteur, c'est créer la version suivante.
CREATE TABLE extracteur (
  id             serial PRIMARY KEY,
  fournisseur_id int  NOT NULL REFERENCES fournisseur(id),
  version        int  NOT NULL CHECK (version > 0),
  energie        energie NOT NULL,
  reglages       jsonb NOT NULL,                  -- regroupement des morceaux en lignes, toujours écrit
  source         text NOT NULL,                   -- TypeScript, tel qu'édité
  code           text NOT NULL,                   -- JavaScript produit, celui qui s'exécute
  moteur         int  NOT NULL,                   -- version du contrat (pdf.js, aides)
  note           text,
  cree_le        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fournisseur_id, version)
);

CREATE FUNCTION extracteur_fige() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Un extracteur n''est jamais modifié ni supprimé : créer une nouvelle version (ADR 0013)';
END $$;

CREATE TRIGGER extracteur_fige BEFORE UPDATE OR DELETE ON extracteur
  FOR EACH ROW EXECUTE FUNCTION extracteur_fige();

CREATE TABLE facture (
  id             serial PRIMARY KEY,
  immeuble_id    int  NOT NULL REFERENCES immeuble(id),
  fournisseur_id int  NOT NULL REFERENCES fournisseur(id),
  energie        energie NOT NULL,
  numero         text NOT NULL,
  date_facture   date,
  montant_ttc    numeric(12,2),                   -- total imprimé (contrôle) ; vide sur un brouillon s'il est à saisir
  fichier_pdf    text,                            -- chemin du PDF archivé
  statut         statut_facture NOT NULL DEFAULT 'a_verifier',
  note           text,
  extracteur_id  int REFERENCES extracteur(id),   -- version qui a lu la facture (vide : saisie à la main)
  UNIQUE (fournisseur_id, numero),
  CONSTRAINT facture_validee_totale CHECK (statut <> 'validee' OR montant_ttc IS NOT NULL)
);

CREATE TABLE ligne_facture (
  id           serial PRIMARY KEY,
  facture_id   int  NOT NULL REFERENCES facture(id) ON DELETE CASCADE,
  ordre        int  NOT NULL DEFAULT 0,
  categorie    categorie_ligne NOT NULL,
  libelle      text NOT NULL,
  periode      daterange NOT NULL CHECK (NOT isempty(periode) AND NOT lower_inf(periode) AND NOT upper_inf(periode)),
  kwh          numeric(12,3),
  montant_ht   numeric(12,3),
  taux_tva     numeric(5,4),                      -- 0.2000, 0.0550
  montant_ttc  numeric(12,3) NOT NULL,            -- montant réparti (3 décimales : certaines lignes ENGIE en ont 3)
  affectation  affectation_ligne NOT NULL DEFAULT 'recuperable',
  note         text
);
CREATE INDEX ON ligne_facture USING gist (periode);

-- Contrôle : somme des lignes vs total imprimé (tolérance 0,05 € pour les arrondis de TVA du fournisseur)
CREATE VIEW v_controle_facture AS
SELECT f.id, f.numero, f.energie, f.montant_ttc,
       coalesce(sum(l.montant_ttc), 0)                       AS total_lignes,
       f.montant_ttc - coalesce(sum(l.montant_ttc), 0)       AS ecart,
       abs(f.montant_ttc - coalesce(sum(l.montant_ttc), 0)) <= 0.05 AS ok
FROM facture f LEFT JOIN ligne_facture l ON l.facture_id = f.id
GROUP BY f.id;

-- ---------------------------------------------------------------- argent des locataires
-- Provisions versées, par séjour et par année civile (comme le classeur).
-- Phase 4 : remplacer/compléter par une table des paiements reçus (loyer + charges, date, mode).
CREATE TABLE provision_annuelle (
  id         serial PRIMARY KEY,
  sejour_id  int NOT NULL REFERENCES sejour(id),
  annee      int NOT NULL,
  montant    numeric(12,2) NOT NULL,
  note       text,
  UNIQUE (sejour_id, annee)
);

-- Régularisations envoyées et leur suivi (sert aussi au calcul des pertes fiscales).
CREATE TABLE regularisation (
  id             serial PRIMARY KEY,
  sejour_id      int  NOT NULL REFERENCES sejour(id),
  exercice       daterange NOT NULL,
  montant_du     numeric(12,2) NOT NULL,          -- quote-part de charges
  provisions     numeric(12,2) NOT NULL,
  solde          numeric(12,2) GENERATED ALWAYS AS (montant_du - provisions) STORED,
  date_envoi     date,                               -- NULL : brouillon (état calculé, ADR 0010)
  decision       decision_regul,                     -- charge abandonnée ou irrécouvrable, choisie par le propriétaire
  remplace_id    int REFERENCES regularisation(id),  -- rectificatif d'une régularisation précédente
  note           text,
  instantane     jsonb,                              -- ce qui a été envoyé, figé (NULL : saisie manuelle), ADR 0007
  cree_le        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT regularisation_decision_envoyee CHECK (decision IS NULL OR date_envoi IS NOT NULL)
);

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

-- Rent and provision called each month from a given month on, until the next row of the stay (ADR 0009: revision of
-- the rent, new provision after a regularisation). A month of presence that is not complete is called pro rata of its
-- days.
CREATE TABLE echeance (
  id          serial PRIMARY KEY,
  sejour_id   int  NOT NULL REFERENCES sejour(id) ON DELETE CASCADE,
  a_partir_du date NOT NULL CHECK (extract(day FROM a_partir_du) = 1),  -- first month concerned (1st day)
  loyer       numeric(12,2) NOT NULL CHECK (loyer >= 0),
  provision   numeric(12,2) NOT NULL CHECK (provision >= 0),           -- provision sur charges
  note        text,
  UNIQUE (sejour_id, a_partir_du)
);

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

-- State of a regularisation (ADR 0010): brouillon (not sent), soldee (paid within 1 euro, corrective chain included:
-- the legacy workbook rounds), en_attente (sent, still to be paid or refunded)
CREATE FUNCTION regularisation_etat(p_id int) RETURNS text
LANGUAGE sql STABLE AS $$
SELECT CASE WHEN r.date_envoi IS NULL THEN 'brouillon'
            WHEN abs(r.solde - regularisation_verse(r.id)) < 1 THEN 'soldee'
            ELSE 'en_attente' END
FROM regularisation r WHERE r.id = p_id
$$;

-- Date of the last payment of a settled regularisation (corrective chain included), else null
CREATE FUNCTION regularisation_date_solde(p_id int) RETURNS date
LANGUAGE sql STABLE AS $$
WITH RECURSIVE chaine AS (
  SELECT id, remplace_id FROM regularisation WHERE id = p_id
  UNION ALL
  SELECT r.id, r.remplace_id FROM regularisation r JOIN chaine c ON r.id = c.remplace_id
)
SELECT CASE WHEN regularisation_etat(p_id) = 'soldee'
            THEN (SELECT max(p.date_paiement) FROM paiement p WHERE p.regularisation_id IN (SELECT id FROM chaine)) END
$$;

-- ---------------------------------------------------------------- compteurs d'eau (phase ultérieure)
-- ADR 0015 : travaux payés par le propriétaire, pour la déclaration seulement (jamais répartis) ; déductibles
-- (2044, ligne 224) selon leur nature : entretien et amélioration oui, construction et agrandissement non.
CREATE TYPE nature_travaux AS ENUM ('entretien', 'amelioration', 'construction');

CREATE TABLE travaux (
  id             serial PRIMARY KEY,
  immeuble_id    int  NOT NULL REFERENCES immeuble(id),
  lot_id         int  REFERENCES lot(id),                -- vide : travaux de l'immeuble ou des parties communes
  fournisseur    text NOT NULL,
  description    text NOT NULL,
  nature         nature_travaux NOT NULL,
  date_facture   date NOT NULL,
  date_paiement  date,                                   -- année fiscale ; vide tant que la facture n'est pas payée
  montant_ttc    numeric(12,2) NOT NULL,
  fichier_pdf    text,                                   -- PDF archivé, même stockage que les factures
  note           text
);
CREATE INDEX ON travaux (immeuble_id, date_paiement);

-- ADR 0016 : la société (SCI), ses associés et leurs parts, ses assemblées générales et leurs procès-verbaux ;
-- une assemblée close est numérotée dans le registre et figée.
CREATE TABLE societe (
  id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  denomination  text NOT NULL,
  forme         text NOT NULL DEFAULT 'SCI',
  capital       numeric(14,2),
  siege         text,
  rcs           text
);

CREATE TABLE associe (
  id       serial PRIMARY KEY,
  nom      text NOT NULL,
  parts    int  NOT NULL CHECK (parts > 0),
  gerant   boolean NOT NULL DEFAULT false,
  adresse  text,
  note     text
);

CREATE TYPE type_assemblee AS ENUM ('ordinaire', 'extraordinaire');
CREATE TYPE statut_assemblee AS ENUM ('brouillon', 'close');
CREATE TYPE presence_associe AS ENUM ('present', 'represente', 'absent');

CREATE TABLE assemblee (
  id             serial PRIMARY KEY,
  numero         int UNIQUE,
  type           type_assemblee NOT NULL,
  date           date NOT NULL,
  heure          text,
  lieu           text,
  ordre_du_jour  text NOT NULL DEFAULT '',
  president      text,
  observations   text,
  statut         statut_assemblee NOT NULL DEFAULT 'brouillon',
  close_le       timestamptz,
  instantane     jsonb,
  pv_signe       text,
  CONSTRAINT assemblee_close CHECK (statut = 'brouillon' OR (numero IS NOT NULL AND instantane IS NOT NULL))
);

CREATE TABLE presence (
  assemblee_id    int NOT NULL REFERENCES assemblee(id) ON DELETE CASCADE,
  associe_id      int NOT NULL REFERENCES associe(id),
  presence        presence_associe NOT NULL DEFAULT 'present',
  represente_par  text,
  PRIMARY KEY (assemblee_id, associe_id)
);

CREATE TABLE resolution (
  id            serial PRIMARY KEY,
  assemblee_id  int NOT NULL REFERENCES assemblee(id) ON DELETE CASCADE,
  ordre         int NOT NULL,
  titre         text NOT NULL,
  texte         text NOT NULL DEFAULT '',
  pour          int  NOT NULL DEFAULT 0 CHECK (pour >= 0),
  contre        int  NOT NULL DEFAULT 0 CHECK (contre >= 0),
  abstention    int  NOT NULL DEFAULT 0 CHECK (abstention >= 0)
);

-- A closed meeting: only its signed minutes may still be attached or replaced
CREATE FUNCTION assemblee_close_figee() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Assemblée close : elle n''est jamais supprimée (registre, ADR 0016)';
  END IF;
  IF (to_jsonb(NEW) - 'pv_signe') <> (to_jsonb(OLD) - 'pv_signe') THEN
    RAISE EXCEPTION 'Assemblée close : elle n''est plus modifiée (registre, ADR 0016)';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER assemblee_close_figee BEFORE UPDATE OR DELETE ON assemblee
  FOR EACH ROW WHEN (OLD.statut = 'close') EXECUTE FUNCTION assemblee_close_figee();

-- Presences and resolutions of a closed meeting are frozen with it
CREATE FUNCTION assemblee_detail_fige() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM assemblee WHERE id = coalesce(NEW.assemblee_id, OLD.assemblee_id) AND statut = 'close') THEN
    RAISE EXCEPTION 'Assemblée close : ses présences et résolutions ne changent plus (registre, ADR 0016)';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;

CREATE TRIGGER presence_figee BEFORE INSERT OR UPDATE OR DELETE ON presence
  FOR EACH ROW EXECUTE FUNCTION assemblee_detail_fige();
CREATE TRIGGER resolution_figee BEFORE INSERT OR UPDATE OR DELETE ON resolution
  FOR EACH ROW EXECUTE FUNCTION assemblee_detail_fige();

CREATE TABLE compteur (
  id          serial PRIMARY KEY,
  immeuble_id int NOT NULL REFERENCES immeuble(id),
  lot_id      int REFERENCES lot(id),              -- NULL = compteur général
  libelle     text NOT NULL,                       -- 'F4 froid', 'général'…
  fluide      text NOT NULL CHECK (fluide IN ('eau_froide', 'eau_chaude', 'general'))
);

CREATE TABLE releve (
  id           serial PRIMARY KEY,
  compteur_id  int NOT NULL REFERENCES compteur(id),
  date_releve  date NOT NULL,
  index_m3     numeric(10,3) NOT NULL,
  UNIQUE (compteur_id, date_releve)
);

-- ---------------------------------------------------------------- journal
CREATE TABLE evenement (
  id           serial PRIMARY KEY,
  immeuble_id  int REFERENCES immeuble(id),
  sejour_id    int REFERENCES sejour(id),
  date_evt     date NOT NULL,
  type         text NOT NULL,                     -- 'entree', 'sortie', 'preavis', 'edl', 'courrier'…
  description  text
);

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
  JOIN facture f ON f.id = l.facture_id AND f.immeuble_id = p_immeuble AND f.statut = 'validee'
  CROSS JOIN exo
  WHERE l.affectation = 'recuperable' AND l.periode && exo.r
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

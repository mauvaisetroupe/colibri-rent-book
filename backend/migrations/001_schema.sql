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
CREATE TYPE statut_regul AS ENUM ('brouillon', 'envoyee', 'payee', 'etalee', 'abandonnee', 'irrecouvrable');

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
  -- deux séjours ne peuvent pas se chevaucher sur le même lot
  EXCLUDE USING gist (lot_id WITH =, periode WITH &&)
);

-- ---------------------------------------------------------------- factures
CREATE TABLE fournisseur (
  id   serial PRIMARY KEY,
  nom  text NOT NULL UNIQUE                      -- 'EDF', 'ENGIE', 'SEAFF', 'DGFiP (taxe foncière)'
);

CREATE TABLE facture (
  id             serial PRIMARY KEY,
  immeuble_id    int  NOT NULL REFERENCES immeuble(id),
  fournisseur_id int  NOT NULL REFERENCES fournisseur(id),
  energie        energie NOT NULL,
  numero         text NOT NULL,
  date_facture   date,
  montant_ttc    numeric(12,2) NOT NULL,          -- total imprimé sur la facture (contrôle)
  fichier_pdf    text,                            -- chemin du PDF archivé
  statut         statut_facture NOT NULL DEFAULT 'a_verifier',
  note           text,
  UNIQUE (fournisseur_id, numero)
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
  recuperable  boolean NOT NULL DEFAULT true,     -- false : pénalités, frais propres au bailleur…
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
  statut         statut_regul NOT NULL DEFAULT 'brouillon',
  date_envoi     date,
  montant_recu   numeric(12,2) NOT NULL DEFAULT 0,
  date_solde     date,
  remplace_id    int REFERENCES regularisation(id),  -- rectificatif d'une régularisation précédente
  note           text
);

-- ---------------------------------------------------------------- compteurs d'eau (phase ultérieure)
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

-- ADR 0018: bank statements read by extractors (like invoices), their movements, and what each movement became
-- (payment of a tenant, works…). PDFs stored by kind in sub-folders of the storage (factures/, releves/, travaux/,
-- assemblees/): the columns hold the path relative to the storage; the server moves the files at start-up.
BEGIN;

-- Extractors of invoices or of bank statements; the energy only makes sense for an invoice
CREATE TYPE type_extracteur AS ENUM ('facture', 'releve');
ALTER TABLE extracteur
  ADD COLUMN type type_extracteur NOT NULL DEFAULT 'facture',
  ALTER COLUMN energie DROP NOT NULL,
  ADD CONSTRAINT extracteur_energie CHECK ((type = 'facture') = (energie IS NOT NULL));

CREATE TABLE releve_bancaire (
  id               serial PRIMARY KEY,
  fournisseur_id   int  NOT NULL REFERENCES fournisseur(id),    -- the bank
  compte           text NOT NULL,
  date_releve      date NOT NULL,
  solde_precedent  numeric(14,2) NOT NULL,
  nouveau_solde    numeric(14,2) NOT NULL,
  fichier_pdf      text,
  extracteur_id    int REFERENCES extracteur(id),
  importe_le       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (compte, date_releve)
);

-- A movement: credit positive, debit negative. What it became is on the other side (paiement.mouvement_id,
-- travaux.mouvement_id): deleting the payment puts it back « à traiter ». Ignored: with a reason.
CREATE TABLE mouvement (
  id              serial PRIMARY KEY,
  releve_id       int  NOT NULL REFERENCES releve_bancaire(id) ON DELETE CASCADE,
  ordre           int  NOT NULL,
  date_operation  date NOT NULL,
  date_valeur     date,
  libelle         text NOT NULL,
  detail          text,
  montant         numeric(12,2) NOT NULL CHECK (montant <> 0),
  motif_ignore    text
);
CREATE INDEX ON mouvement (date_operation);

ALTER TABLE paiement ADD COLUMN mouvement_id int REFERENCES mouvement(id) ON DELETE SET NULL;
ALTER TABLE travaux ADD COLUMN mouvement_id int REFERENCES mouvement(id) ON DELETE SET NULL;
CREATE INDEX ON paiement (mouvement_id);
CREATE INDEX ON travaux (mouvement_id);

-- PDFs by kind
UPDATE facture SET fichier_pdf = 'factures/' || fichier_pdf WHERE fichier_pdf NOT LIKE '%/%';
UPDATE travaux SET fichier_pdf = 'travaux/' || fichier_pdf WHERE fichier_pdf NOT LIKE '%/%';
UPDATE assemblee SET pv_signe = 'assemblees/' || pv_signe WHERE pv_signe NOT LIKE '%/%';

COMMIT;

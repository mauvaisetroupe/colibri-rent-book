-- ADR 0019: the details of a bank movement, taken further.
--   1. Works paid in several times: an invoice is paid by bank movements only (paid = seen at the bank, the proof of
--      a payment), one or several, each for an amount; the tax year of each is that of its movement.
--   2. Deposits: what a tenant paid and what was refunded, as rows linked to the movements like payments.
--   3. Categories: « associes » (contributions of and payments to the partners: what « virement_interne » held so far)
--      and « depot_garantie » (a deposit paid or refunded alone, formerly « remboursement_depot »), which has a detail.
BEGIN;

CREATE TABLE reglement_travaux (
  id             serial PRIMARY KEY,
  travaux_id     int NOT NULL REFERENCES travaux(id) ON DELETE CASCADE,
  mouvement_id   int NOT NULL REFERENCES mouvement(id) ON DELETE CASCADE,
  montant        numeric(12,2) NOT NULL CHECK (montant > 0),
  UNIQUE (travaux_id, mouvement_id)
);
CREATE INDEX ON reglement_travaux (mouvement_id);

-- An invoice seen on a statement: paid in full by that movement
INSERT INTO reglement_travaux (travaux_id, mouvement_id, montant)
SELECT id, mouvement_id, montant_ttc FROM travaux WHERE mouvement_id IS NOT NULL;
-- A payment date typed by hand, without movement, is no proof of payment: kept in the note, to link to its transfer
UPDATE travaux SET note = concat_ws(' · ', note, 'payée le ' || to_char(date_paiement, 'DD/MM/YYYY') || ' (date saisie, virement à rattacher)')
WHERE date_paiement IS NOT NULL AND mouvement_id IS NULL;

ALTER TABLE travaux DROP COLUMN date_paiement, DROP COLUMN mouvement_id;
CREATE INDEX ON travaux (immeuble_id, date_facture);

CREATE TABLE versement_depot (
  id              serial PRIMARY KEY,
  sejour_id       int  NOT NULL REFERENCES sejour(id),
  date_versement  date NOT NULL,
  -- Positive: paid by the tenant; negative: refunded to them
  montant         numeric(12,2) NOT NULL CHECK (montant <> 0),
  mouvement_id    int REFERENCES mouvement(id) ON DELETE SET NULL,
  note            text
);
CREATE INDEX ON versement_depot (sejour_id);
CREATE INDEX ON versement_depot (mouvement_id);

ALTER TABLE mouvement DROP CONSTRAINT mouvement_categorie_check;
UPDATE mouvement SET categorie = 'associes' WHERE categorie = 'virement_interne';
UPDATE mouvement SET categorie = 'depot_garantie' WHERE categorie = 'remboursement_depot';
ALTER TABLE mouvement ADD CONSTRAINT mouvement_categorie_check CHECK (categorie IN ('locataire', 'travaux',
  'depot_garantie', 'emprunt', 'assurance', 'energie', 'eau', 'impots', 'frais_bancaires', 'copropriete', 'honoraires',
  'associes', 'virement_interne', 'autre'));

COMMIT;

-- ADR 0017: a validated invoice is never changed nor deleted, it is replaced, with a trace. The value is added
-- outside the transaction: a new enum value cannot be used in the transaction that adds it.
ALTER TYPE statut_facture ADD VALUE IF NOT EXISTS 'remplacee';

BEGIN;

ALTER TABLE facture
  ADD COLUMN remplacee_par      int REFERENCES facture(id),
  ADD COLUMN remplacee_le       timestamptz,
  ADD COLUMN motif_remplacement text,
  -- On the draft of a correction: the validated invoice it replaces when it is validated
  ADD COLUMN remplace_id        int REFERENCES facture(id),
  ADD CONSTRAINT facture_remplacee CHECK (
    (statut = 'remplacee') = (remplacee_par IS NOT NULL AND remplacee_le IS NOT NULL AND motif_remplacement IS NOT NULL)),
  ADD CONSTRAINT facture_pas_elle_meme CHECK (remplacee_par <> id AND remplace_id <> id);

-- The number stays unique at a supplier among the validated invoices: the draft of a correction keeps it
ALTER TABLE facture DROP CONSTRAINT facture_fournisseur_id_numero_key;
CREATE UNIQUE INDEX facture_numero_validee ON facture (fournisseur_id, numero) WHERE statut = 'validee';

COMMIT;

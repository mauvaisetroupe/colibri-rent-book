-- ADR 0013: invoice extractors, TypeScript code written in the application and run in the browser, stored with their
-- version and never changed nor deleted; each invoice keeps the version that read it. The printed total of a draft may
-- be missing (not on the PDF, typed by hand later); a validated invoice has one.
BEGIN;

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

ALTER TABLE facture ADD COLUMN extracteur_id int REFERENCES extracteur(id);
ALTER TABLE facture ALTER COLUMN montant_ttc DROP NOT NULL;
ALTER TABLE facture ADD CONSTRAINT facture_validee_totale CHECK (statut <> 'validee' OR montant_ttc IS NOT NULL);

COMMIT;

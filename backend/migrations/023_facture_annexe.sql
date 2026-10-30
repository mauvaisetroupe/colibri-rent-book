-- ADR 0024: the invoices joined to a supporting document are their redacted version in images, made in the browser,
-- stored next to the original. One row per version, frozen but for its verification; the invoice points to the current
-- one, a sent regularisation keeps those it joined. Terms masked on every invoice (manager, bank account…).
BEGIN;

CREATE TABLE terme_masque (
  terme text PRIMARY KEY CHECK (length(trim(terme)) > 0)
);

CREATE TABLE facture_annexe (
  id             serial PRIMARY KEY,
  facture_id     int  NOT NULL REFERENCES facture(id) ON DELETE CASCADE,
  fichier_pdf    text NOT NULL,                   -- version en images : annexes/<empreinte>.pdf
  source_pdf     text NOT NULL,                   -- PDF de la facture dont elle est faite (à refaire s'il change)
  zones          jsonb NOT NULL,                  -- rectangles peints : page, x0, y0, x1, y1 (fractions), origine
  extracteur_id  int REFERENCES extracteur(id),   -- version qui a donné les règles (vide : termes seuls)
  termes         text[] NOT NULL,                 -- termes masqués du moment
  reglages       jsonb NOT NULL,                  -- dpi, seuil
  cree_le        timestamptz NOT NULL DEFAULT now(),
  verifiee_le    timestamptz
);
CREATE INDEX ON facture_annexe (facture_id);

CREATE FUNCTION facture_annexe_figee() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.verifiee_le IS NULL AND NEW.verifiee_le IS NOT NULL
     AND (to_jsonb(NEW) - 'verifiee_le') = (to_jsonb(OLD) - 'verifiee_le') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Une annexe n''est jamais modifiée : la refaire (ADR 0024)';
END $$;

CREATE TRIGGER facture_annexe_figee BEFORE UPDATE ON facture_annexe
  FOR EACH ROW EXECUTE FUNCTION facture_annexe_figee();

ALTER TABLE facture ADD COLUMN annexe_id int REFERENCES facture_annexe(id);

-- At sending: the annex joined for each invoice ({ "<facture_id>": <annexe_id> }); NULL: sent before ADR 0024
ALTER TABLE regularisation ADD COLUMN annexes_envoyees jsonb;

COMMIT;

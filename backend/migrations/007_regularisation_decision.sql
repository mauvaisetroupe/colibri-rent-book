-- ADR 0010: the state of a regularisation is computed (draft, waiting for payment, settled), never stored; the owner
-- only records a decision (charge given up, unrecoverable). Replaces regularisation.statut and date_solde.
BEGIN;

CREATE TYPE decision_regul AS ENUM ('abandonnee', 'irrecouvrable');
ALTER TABLE regularisation ADD COLUMN decision decision_regul;
UPDATE regularisation SET decision = statut::text::decision_regul WHERE statut IN ('abandonnee', 'irrecouvrable');

-- « étalée » was a note only: kept in the note when it does not say it already
UPDATE regularisation SET note = concat_ws(' ; ', 'Étalée', note) WHERE statut = 'etalee' AND coalesce(note, '') !~* 'étal';

-- Sent regularisations without a sending date (2023, from the legacy workbook): before their first payment
UPDATE regularisation r SET
  date_envoi = coalesce(
    (SELECT date_trunc('month', min(p.date_paiement))::date FROM paiement p WHERE p.regularisation_id = r.id),
    r.cree_le::date),
  note = concat_ws(' ; ', note, 'date d''envoi approximative (avant le premier versement)')
WHERE r.statut <> 'brouillon' AND r.date_envoi IS NULL;

ALTER TABLE regularisation DROP COLUMN statut, DROP COLUMN date_solde;
DROP TYPE statut_regul;
ALTER TABLE regularisation ADD CONSTRAINT regularisation_decision_envoyee CHECK (decision IS NULL OR date_envoi IS NOT NULL);

-- State of a regularisation: brouillon (not sent), soldee (paid within 1 euro, corrective chain included: the legacy
-- workbook rounds), en_attente (sent, still to be paid or refunded)
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

COMMIT;

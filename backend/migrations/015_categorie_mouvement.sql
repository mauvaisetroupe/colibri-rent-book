-- Bank movements (ADR 0018, continued): each movement gets a category instead of being « ignored ». Two categories have
-- a detail (the payments of a tenant, the works); the others only a note. The note of a tenant payment or works
-- justifies a rest not covered by the detail (a deposit paid with the rent).
BEGIN;

ALTER TABLE mouvement
  ADD COLUMN categorie text CHECK (categorie IN ('locataire', 'travaux', 'emprunt', 'assurance', 'energie', 'eau',
    'impots', 'frais_bancaires', 'copropriete', 'honoraires', 'remboursement_depot', 'virement_interne', 'autre')),
  ADD COLUMN note text,
  ADD CONSTRAINT mouvement_autre_note CHECK (categorie IS DISTINCT FROM 'autre' OR note IS NOT NULL);

-- What a movement became so far: its payments, its works, the reason it was « ignored »
UPDATE mouvement m SET categorie = 'locataire', note = m.motif_ignore
WHERE EXISTS (SELECT 1 FROM paiement p WHERE p.mouvement_id = m.id);
UPDATE mouvement m SET categorie = 'travaux', note = m.motif_ignore
WHERE m.categorie IS NULL AND EXISTS (SELECT 1 FROM travaux t WHERE t.mouvement_id = m.id);
UPDATE mouvement SET categorie = CASE motif_ignore
    WHEN 'Emprunt' THEN 'emprunt'
    WHEN 'Assurance' THEN 'assurance'
    WHEN 'Facture d''énergie (prélèvement)' THEN 'energie'
    WHEN 'Facture d''eau' THEN 'eau'
    WHEN 'Impôts et taxes' THEN 'impots'
    WHEN 'Frais bancaires' THEN 'frais_bancaires'
    WHEN 'Charges de copropriété' THEN 'copropriete'
    ELSE 'autre' END,
  note = CASE WHEN motif_ignore IN ('Emprunt', 'Assurance', 'Facture d''énergie (prélèvement)', 'Facture d''eau',
    'Impôts et taxes', 'Frais bancaires', 'Charges de copropriété') THEN NULL ELSE motif_ignore END
WHERE categorie IS NULL AND motif_ignore IS NOT NULL;

ALTER TABLE mouvement DROP COLUMN motif_ignore;

COMMIT;

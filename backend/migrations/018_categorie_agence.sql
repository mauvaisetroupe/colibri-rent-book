-- ADR 0019: the category « agence », the rents an agency collected and paid back (its fees deducted) before the owner
-- managed the letting: a category without detail, never « à compléter ».
BEGIN;

ALTER TABLE mouvement DROP CONSTRAINT mouvement_categorie_check;
ALTER TABLE mouvement ADD CONSTRAINT mouvement_categorie_check CHECK (categorie IN ('locataire', 'travaux',
  'depot_garantie', 'agence', 'emprunt', 'assurance', 'energie', 'eau', 'impots', 'frais_bancaires', 'copropriete',
  'honoraires', 'associes', 'virement_interne', 'autre'));

COMMIT;

-- ADR 0014: the invoices of a confidential supplier (the property tax notice: tax number of the owner, other
-- properties) are never joined to the supporting document; they are listed, « consultable sur demande ».
BEGIN;

ALTER TABLE fournisseur ADD COLUMN confidentiel boolean NOT NULL DEFAULT false;

COMMIT;

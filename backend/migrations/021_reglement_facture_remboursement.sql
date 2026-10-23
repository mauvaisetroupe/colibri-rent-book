-- ADR 0022 (refunds): a credit of the bank refunding an invoice of charges (a monthly payment plan that paid more than
-- the yearly invoice) is a negative payment of that invoice.
BEGIN;

ALTER TABLE reglement_facture DROP CONSTRAINT reglement_facture_montant_check;
ALTER TABLE reglement_facture ADD CONSTRAINT reglement_facture_montant_check CHECK (montant <> 0);

COMMIT;

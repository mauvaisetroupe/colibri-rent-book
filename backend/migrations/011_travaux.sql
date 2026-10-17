-- ADR 0015: invoices of works paid by the owner (repairs, improvements, construction), for the tax return only: never
-- allocated to the tenants. Deductible (2044, line 224) according to their nature; tax year: that of the payment.
BEGIN;

CREATE TYPE nature_travaux AS ENUM ('entretien', 'amelioration', 'construction');

CREATE TABLE travaux (
  id             serial PRIMARY KEY,
  immeuble_id    int  NOT NULL REFERENCES immeuble(id),
  lot_id         int  REFERENCES lot(id),
  fournisseur    text NOT NULL,
  description    text NOT NULL,
  nature         nature_travaux NOT NULL,
  date_facture   date NOT NULL,
  date_paiement  date,
  montant_ttc    numeric(12,2) NOT NULL,
  fichier_pdf    text,
  note           text
);
CREATE INDEX ON travaux (immeuble_id, date_paiement);

COMMIT;

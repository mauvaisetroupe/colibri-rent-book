-- ADR 0022: invoices of charges (gas, electricity, water, property tax) paid by bank movements, like works (ADR 0019):
-- one or several payments, each a movement and an amount; their total exceeds neither the invoice nor the movement.
-- None taken over: the history is linked on the screen or by a script of the operations.
BEGIN;

CREATE TABLE reglement_facture (
  id             serial PRIMARY KEY,
  facture_id     int NOT NULL REFERENCES facture(id) ON DELETE CASCADE,
  mouvement_id   int NOT NULL REFERENCES mouvement(id) ON DELETE CASCADE,
  montant        numeric(12,2) NOT NULL CHECK (montant > 0),
  UNIQUE (facture_id, mouvement_id)
);
CREATE INDEX ON reglement_facture (mouvement_id);

COMMIT;

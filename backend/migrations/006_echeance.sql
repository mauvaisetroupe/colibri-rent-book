-- ADR 0009: rent and provision called each month, per stay, with their history (one row per change).
BEGIN;

-- Rent and provision called each month from a given month on, until the next row of the stay (revision of the rent,
-- new provision after a regularisation). A month of presence that is not complete is called pro rata of its days.
CREATE TABLE echeance (
  id          serial PRIMARY KEY,
  sejour_id   int  NOT NULL REFERENCES sejour(id) ON DELETE CASCADE,
  a_partir_du date NOT NULL CHECK (extract(day FROM a_partir_du) = 1),  -- first month concerned (1st day)
  loyer       numeric(12,2) NOT NULL CHECK (loyer >= 0),
  provision   numeric(12,2) NOT NULL CHECK (provision >= 0),           -- provision sur charges
  note        text,
  UNIQUE (sejour_id, a_partir_du)
);

COMMIT;

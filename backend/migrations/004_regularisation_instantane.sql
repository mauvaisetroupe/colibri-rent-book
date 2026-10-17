-- ADR 0007: a regularisation freezes what was sent (statement row, building expenses, invoices) so that its
-- supporting PDF and mails stay identical even if the data changes later. NULL for a regularisation entered by hand
-- (sent outside the application).
BEGIN;

ALTER TABLE regularisation
  ADD COLUMN instantane jsonb,
  ADD COLUMN cree_le timestamptz NOT NULL DEFAULT now();

COMMIT;

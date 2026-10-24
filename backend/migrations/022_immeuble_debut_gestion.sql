-- ADR 0023: the date from which the accounts of a building are kept in the application (before: a letting agency, or
-- nothing). Optional; before it, no gap of invoices, no missing regularisation, no charge counted for a departure.
BEGIN;

ALTER TABLE immeuble ADD COLUMN debut_gestion date;

COMMIT;

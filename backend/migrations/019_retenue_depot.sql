-- ADR 0021: the deposit is managed from the stay (paid, refunded, kept). What is kept to cover what the tenant owes is
-- a retention: payments of the mode « depot », toward unpaid months or regularisations, without a bank movement. The
-- deposit kept for charges is their sum toward regularisations: sejour.depot_retenu_charges, typed by hand, goes.
BEGIN;

ALTER TABLE paiement DROP CONSTRAINT paiement_mode_check;
ALTER TABLE paiement ADD CONSTRAINT paiement_mode_check
  CHECK (mode IN ('virement', 'prelevement', 'cheque', 'especes', 'autre', 'depot'));
ALTER TABLE paiement ADD CONSTRAINT paiement_depot_sans_mouvement CHECK (mode IS DISTINCT FROM 'depot' OR mouvement_id IS NULL);

-- A deposit kept typed by hand is kept in the note of the stay, to be entered again as a retention
UPDATE sejour SET note = concat_ws(' · ', note, 'Conservé au départ pour charges (à saisir en retenue sur le dépôt) : '
                                               || depot_retenu_charges || ' €')
WHERE depot_retenu_charges IS NOT NULL AND depot_retenu_charges <> 0;
ALTER TABLE sejour DROP COLUMN depot_retenu_charges;

COMMIT;

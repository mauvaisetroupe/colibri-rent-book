-- 025: English names (docs/glossary.md). Every table, column, type, value, constraint, index, sequence, view, function
-- and trigger of the schema; the JSON stored (extractor settings, tenant copies, snapshots of the charge adjustments).
-- Nothing is computed again: names change, never amounts. The tables never used (meters, readings, events) are
-- dropped. Applied after a backup; the API of this version reads only the new names.

BEGIN;

-- ---------------------------------------------------------------- tables never used, empty

DROP TABLE releve;
DROP TABLE evenement;
DROP TABLE compteur;

-- ---------------------------------------------------------------- views, functions and triggers: their text names the
-- old tables; dropped here, written again in English at the end

DROP FUNCTION synthese(int, date, date);
DROP FUNCTION decompte(int, date, date);
DROP FUNCTION repartition(int, date, date);
DROP FUNCTION nb_jours(daterange);
DROP FUNCTION regularisation_date_solde(int);
DROP FUNCTION regularisation_etat(int);
DROP FUNCTION regularisation_verse(int);
DROP VIEW v_provision;
DROP VIEW v_controle_facture;

DROP TRIGGER extracteur_fige ON extracteur;
DROP TRIGGER facture_annexe_figee ON facture_annexe;
DROP TRIGGER assemblee_close_figee ON assemblee;
DROP TRIGGER presence_figee ON presence;
DROP TRIGGER resolution_figee ON resolution;
DROP FUNCTION extracteur_fige();
DROP FUNCTION facture_annexe_figee();
DROP FUNCTION assemblee_close_figee();
DROP FUNCTION assemblee_detail_fige();

-- ---------------------------------------------------------------- text values checked by a constraint

ALTER TABLE paiement DROP CONSTRAINT paiement_mode_check;
ALTER TABLE paiement DROP CONSTRAINT paiement_depot_sans_mouvement;
UPDATE paiement SET mode = CASE mode
  WHEN 'virement' THEN 'transfer' WHEN 'prelevement' THEN 'direct_debit' WHEN 'especes' THEN 'cash'
  WHEN 'autre' THEN 'other' WHEN 'depot' THEN 'deposit' ELSE mode END
WHERE mode IS NOT NULL;

ALTER TABLE mouvement DROP CONSTRAINT mouvement_categorie_check;
ALTER TABLE mouvement DROP CONSTRAINT mouvement_autre_note;
UPDATE mouvement SET categorie = CASE categorie
  WHEN 'locataire' THEN 'tenant' WHEN 'travaux' THEN 'works' WHEN 'depot_garantie' THEN 'security_deposit'
  WHEN 'agence' THEN 'agency' WHEN 'emprunt' THEN 'loan' WHEN 'assurance' THEN 'insurance' WHEN 'energie' THEN 'energy'
  WHEN 'eau' THEN 'water' WHEN 'impots' THEN 'taxes' WHEN 'frais_bancaires' THEN 'bank_fees'
  WHEN 'copropriete' THEN 'co_ownership' WHEN 'honoraires' THEN 'fees' WHEN 'associes' THEN 'partners'
  WHEN 'virement_interne' THEN 'internal_transfer' WHEN 'autre' THEN 'other' ELSE categorie END
WHERE categorie IS NOT NULL;

-- Types and their values (no data moved: a value keeps its place, a default or a constraint follows it)
ALTER TYPE energie RENAME TO energy;
ALTER TYPE energy RENAME VALUE 'gaz' TO 'gas';
ALTER TYPE energy RENAME VALUE 'electricite' TO 'electricity';
ALTER TYPE energy RENAME VALUE 'eau' TO 'water';
ALTER TYPE energy RENAME VALUE 'ordures_menageres' TO 'household_waste';
ALTER TYPE energy RENAME VALUE 'autre' TO 'other';
ALTER TYPE categorie_ligne RENAME TO line_category;
ALTER TYPE line_category RENAME VALUE 'consommation' TO 'consumption';
ALTER TYPE line_category RENAME VALUE 'abonnement' TO 'subscription';
ALTER TYPE line_category RENAME VALUE 'taxe' TO 'tax';
ALTER TYPE line_category RENAME VALUE 'prestation' TO 'service';
ALTER TYPE line_category RENAME VALUE 'penalite' TO 'penalty';
ALTER TYPE line_category RENAME VALUE 'autre' TO 'other';
ALTER TYPE statut_facture RENAME TO invoice_status;
ALTER TYPE invoice_status RENAME VALUE 'a_verifier' TO 'draft';
ALTER TYPE invoice_status RENAME VALUE 'validee' TO 'validated';
ALTER TYPE invoice_status RENAME VALUE 'remplacee' TO 'replaced';
ALTER TYPE affectation_ligne RENAME TO line_allocation;
ALTER TYPE line_allocation RENAME VALUE 'recuperable' TO 'recoverable';
ALTER TYPE line_allocation RENAME VALUE 'proprietaire' TO 'owner';
ALTER TYPE line_allocation RENAME VALUE 'hors_immeuble' TO 'outside_building';
ALTER TYPE decision_regul RENAME TO adjustment_decision;
ALTER TYPE adjustment_decision RENAME VALUE 'abandonnee' TO 'written_off';
ALTER TYPE adjustment_decision RENAME VALUE 'irrecouvrable' TO 'unrecoverable';
ALTER TYPE type_extracteur RENAME TO extractor_type;
ALTER TYPE extractor_type RENAME VALUE 'facture' TO 'invoice';
ALTER TYPE extractor_type RENAME VALUE 'releve' TO 'bank_statement';
ALTER TYPE nature_travaux RENAME TO works_nature;
ALTER TYPE works_nature RENAME VALUE 'entretien' TO 'maintenance';
ALTER TYPE works_nature RENAME VALUE 'amelioration' TO 'improvement';
ALTER TYPE type_assemblee RENAME TO meeting_type;
ALTER TYPE meeting_type RENAME VALUE 'ordinaire' TO 'ordinary';
ALTER TYPE meeting_type RENAME VALUE 'extraordinaire' TO 'extraordinary';
ALTER TYPE statut_assemblee RENAME TO meeting_status;
ALTER TYPE meeting_status RENAME VALUE 'brouillon' TO 'draft';
ALTER TYPE meeting_status RENAME VALUE 'close' TO 'closed';
ALTER TYPE presence_associe RENAME TO attendance_status;
ALTER TYPE attendance_status RENAME VALUE 'represente' TO 'represented';

-- Tables and columns (data, keys and defaults follow)
ALTER TABLE immeuble RENAME TO building;
ALTER TABLE building RENAME COLUMN nom TO name;
ALTER TABLE building RENAME COLUMN adresse TO address;
ALTER TABLE building RENAME COLUMN debut_gestion TO managed_from;
ALTER TABLE lot RENAME TO unit;
ALTER TABLE unit RENAME COLUMN immeuble_id TO building_id;
ALTER TABLE unit RENAME COLUMN designation TO label;
ALTER TABLE unit RENAME COLUMN surface_m2 TO area_m2;
ALTER TABLE unit RENAME COLUMN tantiemes TO charge_shares;
ALTER TABLE locataire RENAME TO tenant;
ALTER TABLE tenant RENAME COLUMN nom TO name;
ALTER TABLE tenant RENAME COLUMN telephone TO phone;
ALTER TABLE sejour RENAME TO tenancy;
ALTER TABLE tenancy RENAME COLUMN lot_id TO unit_id;
ALTER TABLE tenancy RENAME COLUMN locataire_id TO tenant_id;
ALTER TABLE tenancy RENAME COLUMN periode TO period;
ALTER TABLE tenancy RENAME COLUMN depot_garantie TO security_deposit;
ALTER TABLE fournisseur RENAME TO supplier;
ALTER TABLE supplier RENAME COLUMN nom TO name;
ALTER TABLE supplier RENAME COLUMN confidentiel TO confidential;
ALTER TABLE supplier RENAME COLUMN zones_masquees TO masked_zones;
ALTER TABLE extracteur RENAME TO extractor;
ALTER TABLE extractor RENAME COLUMN fournisseur_id TO supplier_id;
ALTER TABLE extractor RENAME COLUMN energie TO energy;
ALTER TABLE extractor RENAME COLUMN reglages TO settings;
ALTER TABLE extractor RENAME COLUMN moteur TO engine;
ALTER TABLE extractor RENAME COLUMN cree_le TO created_at;
ALTER TABLE releve_bancaire RENAME TO bank_statement;
ALTER TABLE bank_statement RENAME COLUMN fournisseur_id TO supplier_id;
ALTER TABLE bank_statement RENAME COLUMN compte TO account;
ALTER TABLE bank_statement RENAME COLUMN date_releve TO statement_date;
ALTER TABLE bank_statement RENAME COLUMN solde_precedent TO previous_balance;
ALTER TABLE bank_statement RENAME COLUMN nouveau_solde TO new_balance;
ALTER TABLE bank_statement RENAME COLUMN fichier_pdf TO pdf_file;
ALTER TABLE bank_statement RENAME COLUMN extracteur_id TO extractor_id;
ALTER TABLE bank_statement RENAME COLUMN importe_le TO imported_at;
ALTER TABLE mouvement RENAME TO bank_transaction;
ALTER TABLE bank_transaction RENAME COLUMN releve_id TO bank_statement_id;
ALTER TABLE bank_transaction RENAME COLUMN ordre TO position;
ALTER TABLE bank_transaction RENAME COLUMN date_operation TO transaction_date;
ALTER TABLE bank_transaction RENAME COLUMN date_valeur TO value_date;
ALTER TABLE bank_transaction RENAME COLUMN libelle TO label;
ALTER TABLE bank_transaction RENAME COLUMN montant TO amount;
ALTER TABLE bank_transaction RENAME COLUMN categorie TO category;
ALTER TABLE facture RENAME TO invoice;
ALTER TABLE invoice RENAME COLUMN immeuble_id TO building_id;
ALTER TABLE invoice RENAME COLUMN fournisseur_id TO supplier_id;
ALTER TABLE invoice RENAME COLUMN energie TO energy;
ALTER TABLE invoice RENAME COLUMN numero TO number;
ALTER TABLE invoice RENAME COLUMN date_facture TO invoice_date;
ALTER TABLE invoice RENAME COLUMN montant_ttc TO total_incl_tax;
ALTER TABLE invoice RENAME COLUMN fichier_pdf TO pdf_file;
ALTER TABLE invoice RENAME COLUMN statut TO status;
ALTER TABLE invoice RENAME COLUMN extracteur_id TO extractor_id;
ALTER TABLE invoice RENAME COLUMN remplacee_par TO replaced_by;
ALTER TABLE invoice RENAME COLUMN remplacee_le TO replaced_at;
ALTER TABLE invoice RENAME COLUMN motif_remplacement TO replacement_reason;
ALTER TABLE invoice RENAME COLUMN remplace_id TO replaces_id;
ALTER TABLE invoice RENAME COLUMN annexe_id TO tenant_copy_id;
ALTER TABLE invoice RENAME COLUMN zones_masquees TO masked_zones;
ALTER TABLE terme_masque RENAME TO masked_term;
ALTER TABLE masked_term RENAME COLUMN terme TO term;
ALTER TABLE facture_annexe RENAME TO invoice_tenant_copy;
ALTER TABLE invoice_tenant_copy RENAME COLUMN facture_id TO invoice_id;
ALTER TABLE invoice_tenant_copy RENAME COLUMN fichier_pdf TO pdf_file;
ALTER TABLE invoice_tenant_copy RENAME COLUMN extracteur_id TO extractor_id;
ALTER TABLE invoice_tenant_copy RENAME COLUMN termes TO terms;
ALTER TABLE invoice_tenant_copy RENAME COLUMN reglages TO settings;
ALTER TABLE invoice_tenant_copy RENAME COLUMN cree_le TO created_at;
ALTER TABLE invoice_tenant_copy RENAME COLUMN verifiee_le TO checked_at;
ALTER TABLE invoice_tenant_copy RENAME COLUMN pages_scannees TO scanned_pages;
ALTER TABLE ligne_facture RENAME TO invoice_line;
ALTER TABLE invoice_line RENAME COLUMN facture_id TO invoice_id;
ALTER TABLE invoice_line RENAME COLUMN ordre TO position;
ALTER TABLE invoice_line RENAME COLUMN categorie TO category;
ALTER TABLE invoice_line RENAME COLUMN libelle TO label;
ALTER TABLE invoice_line RENAME COLUMN periode TO period;
ALTER TABLE invoice_line RENAME COLUMN montant_ht TO amount_excl_tax;
ALTER TABLE invoice_line RENAME COLUMN taux_tva TO vat_rate;
ALTER TABLE invoice_line RENAME COLUMN montant_ttc TO amount_incl_tax;
ALTER TABLE invoice_line RENAME COLUMN affectation TO allocation;
ALTER TABLE provision_annuelle RENAME TO annual_charge_advance;
ALTER TABLE annual_charge_advance RENAME COLUMN sejour_id TO tenancy_id;
ALTER TABLE annual_charge_advance RENAME COLUMN annee TO year;
ALTER TABLE annual_charge_advance RENAME COLUMN montant TO amount;
ALTER TABLE regularisation RENAME TO charge_adjustment;
ALTER TABLE charge_adjustment RENAME COLUMN sejour_id TO tenancy_id;
ALTER TABLE charge_adjustment RENAME COLUMN exercice TO period;
ALTER TABLE charge_adjustment RENAME COLUMN montant_du TO amount_due;
ALTER TABLE charge_adjustment RENAME COLUMN provisions TO advances;
ALTER TABLE charge_adjustment RENAME COLUMN solde TO balance;
ALTER TABLE charge_adjustment RENAME COLUMN date_envoi TO sent_on;
ALTER TABLE charge_adjustment RENAME COLUMN remplace_id TO replaces_id;
ALTER TABLE charge_adjustment RENAME COLUMN instantane TO snapshot;
ALTER TABLE charge_adjustment RENAME COLUMN annexes_envoyees TO sent_tenant_copies;
ALTER TABLE charge_adjustment RENAME COLUMN cree_le TO created_at;
ALTER TABLE paiement RENAME TO payment;
ALTER TABLE payment RENAME COLUMN sejour_id TO tenancy_id;
ALTER TABLE payment RENAME COLUMN date_paiement TO payment_date;
ALTER TABLE payment RENAME COLUMN mois TO month;
ALTER TABLE payment RENAME COLUMN loyer TO rent;
ALTER TABLE payment RENAME COLUMN provision TO charge_advance;
ALTER TABLE payment RENAME COLUMN regularisation_id TO charge_adjustment_id;
ALTER TABLE payment RENAME COLUMN regularisation TO charge_adjustment;
ALTER TABLE payment RENAME COLUMN mode TO method;
ALTER TABLE payment RENAME COLUMN mouvement_id TO bank_transaction_id;
ALTER TABLE versement_depot RENAME TO deposit_payment;
ALTER TABLE deposit_payment RENAME COLUMN sejour_id TO tenancy_id;
ALTER TABLE deposit_payment RENAME COLUMN date_versement TO payment_date;
ALTER TABLE deposit_payment RENAME COLUMN montant TO amount;
ALTER TABLE deposit_payment RENAME COLUMN mouvement_id TO bank_transaction_id;
ALTER TABLE echeance RENAME TO rent_schedule;
ALTER TABLE rent_schedule RENAME COLUMN sejour_id TO tenancy_id;
ALTER TABLE rent_schedule RENAME COLUMN a_partir_du TO from_month;
ALTER TABLE rent_schedule RENAME COLUMN loyer TO rent;
ALTER TABLE rent_schedule RENAME COLUMN provision TO charge_advance;
ALTER TABLE travaux RENAME TO works_invoice;
ALTER TABLE works_invoice RENAME COLUMN immeuble_id TO building_id;
ALTER TABLE works_invoice RENAME COLUMN lot_id TO unit_id;
ALTER TABLE works_invoice RENAME COLUMN fournisseur TO supplier;
ALTER TABLE works_invoice RENAME COLUMN date_facture TO invoice_date;
ALTER TABLE works_invoice RENAME COLUMN montant_ttc TO total_incl_tax;
ALTER TABLE works_invoice RENAME COLUMN fichier_pdf TO pdf_file;
ALTER TABLE reglement_travaux RENAME TO works_invoice_payment;
ALTER TABLE works_invoice_payment RENAME COLUMN travaux_id TO works_invoice_id;
ALTER TABLE works_invoice_payment RENAME COLUMN mouvement_id TO bank_transaction_id;
ALTER TABLE works_invoice_payment RENAME COLUMN montant TO amount;
ALTER TABLE reglement_facture RENAME TO invoice_payment;
ALTER TABLE invoice_payment RENAME COLUMN facture_id TO invoice_id;
ALTER TABLE invoice_payment RENAME COLUMN mouvement_id TO bank_transaction_id;
ALTER TABLE invoice_payment RENAME COLUMN montant TO amount;
ALTER TABLE societe RENAME TO company;
ALTER TABLE company RENAME COLUMN denomination TO name;
ALTER TABLE company RENAME COLUMN forme TO legal_form;
ALTER TABLE company RENAME COLUMN siege TO registered_office;
ALTER TABLE associe RENAME TO partner;
ALTER TABLE partner RENAME COLUMN nom TO name;
ALTER TABLE partner RENAME COLUMN gerant TO manager;
ALTER TABLE partner RENAME COLUMN adresse TO address;
ALTER TABLE partner RENAME COLUMN parts TO shares;
ALTER TABLE assemblee RENAME TO general_meeting;
ALTER TABLE general_meeting RENAME COLUMN numero TO number;
ALTER TABLE general_meeting RENAME COLUMN heure TO time;
ALTER TABLE general_meeting RENAME COLUMN lieu TO place;
ALTER TABLE general_meeting RENAME COLUMN ordre_du_jour TO agenda;
ALTER TABLE general_meeting RENAME COLUMN president TO chair;
ALTER TABLE general_meeting RENAME COLUMN observations TO remarks;
ALTER TABLE general_meeting RENAME COLUMN statut TO status;
ALTER TABLE general_meeting RENAME COLUMN close_le TO closed_at;
ALTER TABLE general_meeting RENAME COLUMN instantane TO snapshot;
ALTER TABLE general_meeting RENAME COLUMN pv_signe TO signed_minutes;
ALTER TABLE presence RENAME TO attendance;
ALTER TABLE attendance RENAME COLUMN assemblee_id TO general_meeting_id;
ALTER TABLE attendance RENAME COLUMN associe_id TO partner_id;
ALTER TABLE attendance RENAME COLUMN presence TO status;
ALTER TABLE attendance RENAME COLUMN represente_par TO represented_by;
ALTER TABLE resolution RENAME COLUMN assemblee_id TO general_meeting_id;
ALTER TABLE resolution RENAME COLUMN ordre TO position;
ALTER TABLE resolution RENAME COLUMN titre TO title;
ALTER TABLE resolution RENAME COLUMN texte TO text;
ALTER TABLE resolution RENAME COLUMN pour TO votes_for;
ALTER TABLE resolution RENAME COLUMN contre TO votes_against;
ALTER TABLE resolution RENAME COLUMN abstention TO abstentions;
ALTER TABLE utilisateur RENAME TO app_user;
ALTER TABLE app_user RENAME COLUMN nom TO name;
ALTER TABLE app_user RENAME COLUMN cree_le TO created_at;
ALTER TABLE passkey RENAME COLUMN utilisateur_id TO app_user_id;
ALTER TABLE passkey RENAME COLUMN cle_publique TO public_key;
ALTER TABLE passkey RENAME COLUMN compteur TO sign_count;
ALTER TABLE passkey RENAME COLUMN appareil TO device;
ALTER TABLE passkey RENAME COLUMN cree_le TO created_at;
ALTER TABLE passkey RENAME COLUMN utilisee_le TO used_at;
ALTER TABLE session RENAME COLUMN empreinte TO token_hash;
ALTER TABLE session RENAME COLUMN utilisateur_id TO app_user_id;
ALTER TABLE session RENAME COLUMN cree_le TO created_at;
ALTER TABLE session RENAME COLUMN expire_le TO expires_at;
ALTER TABLE lien_enregistrement RENAME TO registration_link;
ALTER TABLE registration_link RENAME COLUMN empreinte TO token_hash;
ALTER TABLE registration_link RENAME COLUMN utilisateur_id TO app_user_id;
ALTER TABLE registration_link RENAME COLUMN expire_le TO expires_at;
ALTER TABLE registration_link RENAME COLUMN utilise_le TO used_at;
ALTER TABLE jeton_api RENAME TO api_token;
ALTER TABLE api_token RENAME COLUMN nom TO name;
ALTER TABLE api_token RENAME COLUMN empreinte TO token_hash;
ALTER TABLE api_token RENAME COLUMN utilisateur_id TO app_user_id;
ALTER TABLE api_token RENAME COLUMN cree_le TO created_at;
ALTER TABLE api_token RENAME COLUMN utilise_le TO used_at;
ALTER TABLE api_token RENAME COLUMN revoque_le TO revoked_at;

-- Constraints, indexes and sequences named after the old tables and columns. Constraints (an index behind a primary key, unique or exclusion constraint is renamed with it)
ALTER TABLE general_meeting RENAME CONSTRAINT assemblee_close TO general_meeting_closed;
ALTER TABLE general_meeting RENAME CONSTRAINT assemblee_date_not_null TO general_meeting_date_not_null;
ALTER TABLE general_meeting RENAME CONSTRAINT assemblee_id_not_null TO general_meeting_id_not_null;
ALTER TABLE general_meeting RENAME CONSTRAINT assemblee_numero_key TO general_meeting_number_key;
ALTER TABLE general_meeting RENAME CONSTRAINT assemblee_ordre_du_jour_not_null TO general_meeting_agenda_not_null;
ALTER TABLE general_meeting RENAME CONSTRAINT assemblee_pkey TO general_meeting_pkey;
ALTER TABLE general_meeting RENAME CONSTRAINT assemblee_statut_not_null TO general_meeting_status_not_null;
ALTER TABLE general_meeting RENAME CONSTRAINT assemblee_type_not_null TO general_meeting_type_not_null;
ALTER TABLE partner RENAME CONSTRAINT associe_gerant_not_null TO partner_manager_not_null;
ALTER TABLE partner RENAME CONSTRAINT associe_id_not_null TO partner_id_not_null;
ALTER TABLE partner RENAME CONSTRAINT associe_nom_not_null TO partner_name_not_null;
ALTER TABLE partner RENAME CONSTRAINT associe_parts_check TO partner_shares_check;
ALTER TABLE partner RENAME CONSTRAINT associe_parts_not_null TO partner_shares_not_null;
ALTER TABLE partner RENAME CONSTRAINT associe_pkey TO partner_pkey;
ALTER TABLE rent_schedule RENAME CONSTRAINT echeance_a_partir_du_check TO rent_schedule_from_month_check;
ALTER TABLE rent_schedule RENAME CONSTRAINT echeance_a_partir_du_not_null TO rent_schedule_from_month_not_null;
ALTER TABLE rent_schedule RENAME CONSTRAINT echeance_id_not_null TO rent_schedule_id_not_null;
ALTER TABLE rent_schedule RENAME CONSTRAINT echeance_loyer_check TO rent_schedule_rent_check;
ALTER TABLE rent_schedule RENAME CONSTRAINT echeance_loyer_not_null TO rent_schedule_rent_not_null;
ALTER TABLE rent_schedule RENAME CONSTRAINT echeance_pkey TO rent_schedule_pkey;
ALTER TABLE rent_schedule RENAME CONSTRAINT echeance_provision_check TO rent_schedule_charge_advance_check;
ALTER TABLE rent_schedule RENAME CONSTRAINT echeance_provision_not_null TO rent_schedule_charge_advance_not_null;
ALTER TABLE rent_schedule RENAME CONSTRAINT echeance_sejour_id_a_partir_du_key TO rent_schedule_tenancy_id_from_month_key;
ALTER TABLE rent_schedule RENAME CONSTRAINT echeance_sejour_id_fkey TO rent_schedule_tenancy_id_fkey;
ALTER TABLE rent_schedule RENAME CONSTRAINT echeance_sejour_id_not_null TO rent_schedule_tenancy_id_not_null;
ALTER TABLE extractor RENAME CONSTRAINT extracteur_code_not_null TO extractor_code_not_null;
ALTER TABLE extractor RENAME CONSTRAINT extracteur_cree_le_not_null TO extractor_created_at_not_null;
ALTER TABLE extractor RENAME CONSTRAINT extracteur_energie TO extractor_energy;
ALTER TABLE extractor RENAME CONSTRAINT extracteur_fournisseur_id_fkey TO extractor_supplier_id_fkey;
ALTER TABLE extractor RENAME CONSTRAINT extracteur_fournisseur_id_not_null TO extractor_supplier_id_not_null;
ALTER TABLE extractor RENAME CONSTRAINT extracteur_fournisseur_id_version_key TO extractor_supplier_id_version_key;
ALTER TABLE extractor RENAME CONSTRAINT extracteur_id_not_null TO extractor_id_not_null;
ALTER TABLE extractor RENAME CONSTRAINT extracteur_moteur_not_null TO extractor_engine_not_null;
ALTER TABLE extractor RENAME CONSTRAINT extracteur_pkey TO extractor_pkey;
ALTER TABLE extractor RENAME CONSTRAINT extracteur_reglages_not_null TO extractor_settings_not_null;
ALTER TABLE extractor RENAME CONSTRAINT extracteur_source_not_null TO extractor_source_not_null;
ALTER TABLE extractor RENAME CONSTRAINT extracteur_type_not_null TO extractor_type_not_null;
ALTER TABLE extractor RENAME CONSTRAINT extracteur_version_check TO extractor_version_check;
ALTER TABLE extractor RENAME CONSTRAINT extracteur_version_not_null TO extractor_version_not_null;
ALTER TABLE invoice RENAME CONSTRAINT facture_annexe_id_fkey TO invoice_tenant_copy_id_fkey;
ALTER TABLE invoice RENAME CONSTRAINT facture_energie_not_null TO invoice_energy_not_null;
ALTER TABLE invoice RENAME CONSTRAINT facture_extracteur_id_fkey TO invoice_extractor_id_fkey;
ALTER TABLE invoice RENAME CONSTRAINT facture_fournisseur_id_fkey TO invoice_supplier_id_fkey;
ALTER TABLE invoice RENAME CONSTRAINT facture_fournisseur_id_not_null TO invoice_supplier_id_not_null;
ALTER TABLE invoice RENAME CONSTRAINT facture_id_not_null TO invoice_id_not_null;
ALTER TABLE invoice RENAME CONSTRAINT facture_immeuble_id_fkey TO invoice_building_id_fkey;
ALTER TABLE invoice RENAME CONSTRAINT facture_immeuble_id_not_null TO invoice_building_id_not_null;
ALTER TABLE invoice RENAME CONSTRAINT facture_numero_not_null TO invoice_number_not_null;
ALTER TABLE invoice RENAME CONSTRAINT facture_pas_elle_meme TO invoice_not_itself;
ALTER TABLE invoice RENAME CONSTRAINT facture_pkey TO invoice_pkey;
ALTER TABLE invoice RENAME CONSTRAINT facture_remplace_id_fkey TO invoice_replaces_id_fkey;
ALTER TABLE invoice RENAME CONSTRAINT facture_remplacee TO invoice_replaced;
ALTER TABLE invoice RENAME CONSTRAINT facture_remplacee_par_fkey TO invoice_replaced_by_fkey;
ALTER TABLE invoice RENAME CONSTRAINT facture_statut_not_null TO invoice_status_not_null;
ALTER TABLE invoice RENAME CONSTRAINT facture_validee_totale TO invoice_validated_has_total;
ALTER TABLE invoice_tenant_copy RENAME CONSTRAINT facture_annexe_cree_le_not_null TO invoice_tenant_copy_created_at_not_null;
ALTER TABLE invoice_tenant_copy RENAME CONSTRAINT facture_annexe_extracteur_id_fkey TO invoice_tenant_copy_extractor_id_fkey;
ALTER TABLE invoice_tenant_copy RENAME CONSTRAINT facture_annexe_facture_id_fkey TO invoice_tenant_copy_invoice_id_fkey;
ALTER TABLE invoice_tenant_copy RENAME CONSTRAINT facture_annexe_facture_id_not_null TO invoice_tenant_copy_invoice_id_not_null;
ALTER TABLE invoice_tenant_copy RENAME CONSTRAINT facture_annexe_fichier_pdf_not_null TO invoice_tenant_copy_pdf_file_not_null;
ALTER TABLE invoice_tenant_copy RENAME CONSTRAINT facture_annexe_id_not_null TO invoice_tenant_copy_id_not_null;
ALTER TABLE invoice_tenant_copy RENAME CONSTRAINT facture_annexe_pages_scannees_not_null TO invoice_tenant_copy_scanned_pages_not_null;
ALTER TABLE invoice_tenant_copy RENAME CONSTRAINT facture_annexe_pkey TO invoice_tenant_copy_pkey;
ALTER TABLE invoice_tenant_copy RENAME CONSTRAINT facture_annexe_reglages_not_null TO invoice_tenant_copy_settings_not_null;
ALTER TABLE invoice_tenant_copy RENAME CONSTRAINT facture_annexe_source_pdf_not_null TO invoice_tenant_copy_source_pdf_not_null;
ALTER TABLE invoice_tenant_copy RENAME CONSTRAINT facture_annexe_termes_not_null TO invoice_tenant_copy_terms_not_null;
ALTER TABLE invoice_tenant_copy RENAME CONSTRAINT facture_annexe_zones_not_null TO invoice_tenant_copy_zones_not_null;
ALTER TABLE supplier RENAME CONSTRAINT fournisseur_confidentiel_not_null TO supplier_confidential_not_null;
ALTER TABLE supplier RENAME CONSTRAINT fournisseur_id_not_null TO supplier_id_not_null;
ALTER TABLE supplier RENAME CONSTRAINT fournisseur_nom_key TO supplier_name_key;
ALTER TABLE supplier RENAME CONSTRAINT fournisseur_nom_not_null TO supplier_name_not_null;
ALTER TABLE supplier RENAME CONSTRAINT fournisseur_pkey TO supplier_pkey;
ALTER TABLE supplier RENAME CONSTRAINT fournisseur_zones_masquees_not_null TO supplier_masked_zones_not_null;
ALTER TABLE building RENAME CONSTRAINT immeuble_code_key TO building_code_key;
ALTER TABLE building RENAME CONSTRAINT immeuble_code_not_null TO building_code_not_null;
ALTER TABLE building RENAME CONSTRAINT immeuble_id_not_null TO building_id_not_null;
ALTER TABLE building RENAME CONSTRAINT immeuble_nom_not_null TO building_name_not_null;
ALTER TABLE building RENAME CONSTRAINT immeuble_pkey TO building_pkey;
ALTER TABLE api_token RENAME CONSTRAINT jeton_api_cree_le_not_null TO api_token_created_at_not_null;
ALTER TABLE api_token RENAME CONSTRAINT jeton_api_empreinte_key TO api_token_token_hash_key;
ALTER TABLE api_token RENAME CONSTRAINT jeton_api_empreinte_not_null TO api_token_token_hash_not_null;
ALTER TABLE api_token RENAME CONSTRAINT jeton_api_id_not_null TO api_token_id_not_null;
ALTER TABLE api_token RENAME CONSTRAINT jeton_api_nom_not_null TO api_token_name_not_null;
ALTER TABLE api_token RENAME CONSTRAINT jeton_api_pkey TO api_token_pkey;
ALTER TABLE api_token RENAME CONSTRAINT jeton_api_utilisateur_id_fkey TO api_token_app_user_id_fkey;
ALTER TABLE api_token RENAME CONSTRAINT jeton_api_utilisateur_id_not_null TO api_token_app_user_id_not_null;
ALTER TABLE registration_link RENAME CONSTRAINT lien_enregistrement_empreinte_not_null TO registration_link_token_hash_not_null;
ALTER TABLE registration_link RENAME CONSTRAINT lien_enregistrement_expire_le_not_null TO registration_link_expires_at_not_null;
ALTER TABLE registration_link RENAME CONSTRAINT lien_enregistrement_pkey TO registration_link_pkey;
ALTER TABLE registration_link RENAME CONSTRAINT lien_enregistrement_utilisateur_id_fkey TO registration_link_app_user_id_fkey;
ALTER TABLE registration_link RENAME CONSTRAINT lien_enregistrement_utilisateur_id_not_null TO registration_link_app_user_id_not_null;
ALTER TABLE invoice_line RENAME CONSTRAINT ligne_facture_affectation_not_null TO invoice_line_allocation_not_null;
ALTER TABLE invoice_line RENAME CONSTRAINT ligne_facture_categorie_not_null TO invoice_line_category_not_null;
ALTER TABLE invoice_line RENAME CONSTRAINT ligne_facture_facture_id_fkey TO invoice_line_invoice_id_fkey;
ALTER TABLE invoice_line RENAME CONSTRAINT ligne_facture_facture_id_not_null TO invoice_line_invoice_id_not_null;
ALTER TABLE invoice_line RENAME CONSTRAINT ligne_facture_id_not_null TO invoice_line_id_not_null;
ALTER TABLE invoice_line RENAME CONSTRAINT ligne_facture_libelle_not_null TO invoice_line_label_not_null;
ALTER TABLE invoice_line RENAME CONSTRAINT ligne_facture_montant_ttc_not_null TO invoice_line_amount_incl_tax_not_null;
ALTER TABLE invoice_line RENAME CONSTRAINT ligne_facture_ordre_not_null TO invoice_line_position_not_null;
ALTER TABLE invoice_line RENAME CONSTRAINT ligne_facture_periode_check TO invoice_line_period_check;
ALTER TABLE invoice_line RENAME CONSTRAINT ligne_facture_periode_not_null TO invoice_line_period_not_null;
ALTER TABLE invoice_line RENAME CONSTRAINT ligne_facture_pkey TO invoice_line_pkey;
ALTER TABLE tenant RENAME CONSTRAINT locataire_id_not_null TO tenant_id_not_null;
ALTER TABLE tenant RENAME CONSTRAINT locataire_nom_key TO tenant_name_key;
ALTER TABLE tenant RENAME CONSTRAINT locataire_nom_not_null TO tenant_name_not_null;
ALTER TABLE tenant RENAME CONSTRAINT locataire_pkey TO tenant_pkey;
ALTER TABLE unit RENAME CONSTRAINT lot_code_not_null TO unit_code_not_null;
ALTER TABLE unit RENAME CONSTRAINT lot_id_not_null TO unit_id_not_null;
ALTER TABLE unit RENAME CONSTRAINT lot_immeuble_id_code_key TO unit_building_id_code_key;
ALTER TABLE unit RENAME CONSTRAINT lot_immeuble_id_fkey TO unit_building_id_fkey;
ALTER TABLE unit RENAME CONSTRAINT lot_immeuble_id_not_null TO unit_building_id_not_null;
ALTER TABLE unit RENAME CONSTRAINT lot_pkey TO unit_pkey;
ALTER TABLE unit RENAME CONSTRAINT lot_tantiemes_check TO unit_charge_shares_check;
ALTER TABLE unit RENAME CONSTRAINT lot_tantiemes_not_null TO unit_charge_shares_not_null;
ALTER TABLE bank_transaction RENAME CONSTRAINT mouvement_date_operation_not_null TO bank_transaction_transaction_date_not_null;
ALTER TABLE bank_transaction RENAME CONSTRAINT mouvement_id_not_null TO bank_transaction_id_not_null;
ALTER TABLE bank_transaction RENAME CONSTRAINT mouvement_libelle_not_null TO bank_transaction_label_not_null;
ALTER TABLE bank_transaction RENAME CONSTRAINT mouvement_montant_check TO bank_transaction_amount_check;
ALTER TABLE bank_transaction RENAME CONSTRAINT mouvement_montant_not_null TO bank_transaction_amount_not_null;
ALTER TABLE bank_transaction RENAME CONSTRAINT mouvement_ordre_not_null TO bank_transaction_position_not_null;
ALTER TABLE bank_transaction RENAME CONSTRAINT mouvement_pkey TO bank_transaction_pkey;
ALTER TABLE bank_transaction RENAME CONSTRAINT mouvement_releve_id_fkey TO bank_transaction_bank_statement_id_fkey;
ALTER TABLE bank_transaction RENAME CONSTRAINT mouvement_releve_id_not_null TO bank_transaction_bank_statement_id_not_null;
ALTER TABLE payment RENAME CONSTRAINT paiement_check TO payment_check;
ALTER TABLE payment RENAME CONSTRAINT paiement_check1 TO payment_check1;
ALTER TABLE payment RENAME CONSTRAINT paiement_date_paiement_not_null TO payment_payment_date_not_null;
ALTER TABLE payment RENAME CONSTRAINT paiement_id_not_null TO payment_id_not_null;
ALTER TABLE payment RENAME CONSTRAINT paiement_loyer_not_null TO payment_rent_not_null;
ALTER TABLE payment RENAME CONSTRAINT paiement_mois_check TO payment_month_check;
ALTER TABLE payment RENAME CONSTRAINT paiement_mouvement_id_fkey TO payment_bank_transaction_id_fkey;
ALTER TABLE payment RENAME CONSTRAINT paiement_pkey TO payment_pkey;
ALTER TABLE payment RENAME CONSTRAINT paiement_provision_not_null TO payment_charge_advance_not_null;
ALTER TABLE payment RENAME CONSTRAINT paiement_regularisation_id_fkey TO payment_charge_adjustment_id_fkey;
ALTER TABLE payment RENAME CONSTRAINT paiement_regularisation_not_null TO payment_charge_adjustment_not_null;
ALTER TABLE payment RENAME CONSTRAINT paiement_sejour_id_fkey TO payment_tenancy_id_fkey;
ALTER TABLE payment RENAME CONSTRAINT paiement_sejour_id_not_null TO payment_tenancy_id_not_null;
ALTER TABLE passkey RENAME CONSTRAINT passkey_appareil_not_null TO passkey_device_not_null;
ALTER TABLE passkey RENAME CONSTRAINT passkey_cle_publique_not_null TO passkey_public_key_not_null;
ALTER TABLE passkey RENAME CONSTRAINT passkey_compteur_not_null TO passkey_sign_count_not_null;
ALTER TABLE passkey RENAME CONSTRAINT passkey_cree_le_not_null TO passkey_created_at_not_null;
ALTER TABLE passkey RENAME CONSTRAINT passkey_utilisateur_id_fkey TO passkey_app_user_id_fkey;
ALTER TABLE passkey RENAME CONSTRAINT passkey_utilisateur_id_not_null TO passkey_app_user_id_not_null;
ALTER TABLE attendance RENAME CONSTRAINT presence_assemblee_id_fkey TO attendance_general_meeting_id_fkey;
ALTER TABLE attendance RENAME CONSTRAINT presence_assemblee_id_not_null TO attendance_general_meeting_id_not_null;
ALTER TABLE attendance RENAME CONSTRAINT presence_associe_id_fkey TO attendance_partner_id_fkey;
ALTER TABLE attendance RENAME CONSTRAINT presence_associe_id_not_null TO attendance_partner_id_not_null;
ALTER TABLE attendance RENAME CONSTRAINT presence_pkey TO attendance_pkey;
ALTER TABLE attendance RENAME CONSTRAINT presence_presence_not_null TO attendance_status_not_null;
ALTER TABLE annual_charge_advance RENAME CONSTRAINT provision_annuelle_annee_not_null TO annual_charge_advance_year_not_null;
ALTER TABLE annual_charge_advance RENAME CONSTRAINT provision_annuelle_id_not_null TO annual_charge_advance_id_not_null;
ALTER TABLE annual_charge_advance RENAME CONSTRAINT provision_annuelle_montant_not_null TO annual_charge_advance_amount_not_null;
ALTER TABLE annual_charge_advance RENAME CONSTRAINT provision_annuelle_pkey TO annual_charge_advance_pkey;
ALTER TABLE annual_charge_advance RENAME CONSTRAINT provision_annuelle_sejour_id_annee_key TO annual_charge_advance_tenancy_id_year_key;
ALTER TABLE annual_charge_advance RENAME CONSTRAINT provision_annuelle_sejour_id_fkey TO annual_charge_advance_tenancy_id_fkey;
ALTER TABLE annual_charge_advance RENAME CONSTRAINT provision_annuelle_sejour_id_not_null TO annual_charge_advance_tenancy_id_not_null;
ALTER TABLE invoice_payment RENAME CONSTRAINT reglement_facture_facture_id_fkey TO invoice_payment_invoice_id_fkey;
ALTER TABLE invoice_payment RENAME CONSTRAINT reglement_facture_facture_id_mouvement_id_key TO invoice_payment_invoice_id_bank_transaction_id_key;
ALTER TABLE invoice_payment RENAME CONSTRAINT reglement_facture_facture_id_not_null TO invoice_payment_invoice_id_not_null;
ALTER TABLE invoice_payment RENAME CONSTRAINT reglement_facture_id_not_null TO invoice_payment_id_not_null;
ALTER TABLE invoice_payment RENAME CONSTRAINT reglement_facture_montant_check TO invoice_payment_amount_check;
ALTER TABLE invoice_payment RENAME CONSTRAINT reglement_facture_montant_not_null TO invoice_payment_amount_not_null;
ALTER TABLE invoice_payment RENAME CONSTRAINT reglement_facture_mouvement_id_fkey TO invoice_payment_bank_transaction_id_fkey;
ALTER TABLE invoice_payment RENAME CONSTRAINT reglement_facture_mouvement_id_not_null TO invoice_payment_bank_transaction_id_not_null;
ALTER TABLE invoice_payment RENAME CONSTRAINT reglement_facture_pkey TO invoice_payment_pkey;
ALTER TABLE works_invoice_payment RENAME CONSTRAINT reglement_travaux_id_not_null TO works_invoice_payment_id_not_null;
ALTER TABLE works_invoice_payment RENAME CONSTRAINT reglement_travaux_montant_check TO works_invoice_payment_amount_check;
ALTER TABLE works_invoice_payment RENAME CONSTRAINT reglement_travaux_montant_not_null TO works_invoice_payment_amount_not_null;
ALTER TABLE works_invoice_payment RENAME CONSTRAINT reglement_travaux_mouvement_id_fkey TO works_invoice_payment_bank_transaction_id_fkey;
ALTER TABLE works_invoice_payment RENAME CONSTRAINT reglement_travaux_mouvement_id_not_null TO works_invoice_payment_bank_transaction_id_not_null;
ALTER TABLE works_invoice_payment RENAME CONSTRAINT reglement_travaux_pkey TO works_invoice_payment_pkey;
ALTER TABLE works_invoice_payment RENAME CONSTRAINT reglement_travaux_travaux_id_fkey TO works_invoice_payment_works_invoice_id_fkey;
ALTER TABLE works_invoice_payment RENAME CONSTRAINT reglement_travaux_travaux_id_mouvement_id_key TO works_invoice_payment_works_invoice_id_bank_transaction_id_key;
ALTER TABLE works_invoice_payment RENAME CONSTRAINT reglement_travaux_travaux_id_not_null TO works_invoice_payment_works_invoice_id_not_null;
ALTER TABLE charge_adjustment RENAME CONSTRAINT regularisation_cree_le_not_null TO charge_adjustment_created_at_not_null;
ALTER TABLE charge_adjustment RENAME CONSTRAINT regularisation_decision_envoyee TO charge_adjustment_decision_sent;
ALTER TABLE charge_adjustment RENAME CONSTRAINT regularisation_exercice_not_null TO charge_adjustment_period_not_null;
ALTER TABLE charge_adjustment RENAME CONSTRAINT regularisation_id_not_null TO charge_adjustment_id_not_null;
ALTER TABLE charge_adjustment RENAME CONSTRAINT regularisation_montant_du_not_null TO charge_adjustment_amount_due_not_null;
ALTER TABLE charge_adjustment RENAME CONSTRAINT regularisation_pkey TO charge_adjustment_pkey;
ALTER TABLE charge_adjustment RENAME CONSTRAINT regularisation_provisions_not_null TO charge_adjustment_advances_not_null;
ALTER TABLE charge_adjustment RENAME CONSTRAINT regularisation_remplace_id_fkey TO charge_adjustment_replaces_id_fkey;
ALTER TABLE charge_adjustment RENAME CONSTRAINT regularisation_sejour_id_fkey TO charge_adjustment_tenancy_id_fkey;
ALTER TABLE charge_adjustment RENAME CONSTRAINT regularisation_sejour_id_not_null TO charge_adjustment_tenancy_id_not_null;
ALTER TABLE bank_statement RENAME CONSTRAINT releve_bancaire_compte_date_releve_key TO bank_statement_account_statement_date_key;
ALTER TABLE bank_statement RENAME CONSTRAINT releve_bancaire_compte_not_null TO bank_statement_account_not_null;
ALTER TABLE bank_statement RENAME CONSTRAINT releve_bancaire_date_releve_not_null TO bank_statement_statement_date_not_null;
ALTER TABLE bank_statement RENAME CONSTRAINT releve_bancaire_extracteur_id_fkey TO bank_statement_extractor_id_fkey;
ALTER TABLE bank_statement RENAME CONSTRAINT releve_bancaire_fournisseur_id_fkey TO bank_statement_supplier_id_fkey;
ALTER TABLE bank_statement RENAME CONSTRAINT releve_bancaire_fournisseur_id_not_null TO bank_statement_supplier_id_not_null;
ALTER TABLE bank_statement RENAME CONSTRAINT releve_bancaire_id_not_null TO bank_statement_id_not_null;
ALTER TABLE bank_statement RENAME CONSTRAINT releve_bancaire_importe_le_not_null TO bank_statement_imported_at_not_null;
ALTER TABLE bank_statement RENAME CONSTRAINT releve_bancaire_nouveau_solde_not_null TO bank_statement_new_balance_not_null;
ALTER TABLE bank_statement RENAME CONSTRAINT releve_bancaire_pkey TO bank_statement_pkey;
ALTER TABLE bank_statement RENAME CONSTRAINT releve_bancaire_solde_precedent_not_null TO bank_statement_previous_balance_not_null;
ALTER TABLE resolution RENAME CONSTRAINT resolution_abstention_check TO resolution_abstentions_check;
ALTER TABLE resolution RENAME CONSTRAINT resolution_abstention_not_null TO resolution_abstentions_not_null;
ALTER TABLE resolution RENAME CONSTRAINT resolution_assemblee_id_fkey TO resolution_general_meeting_id_fkey;
ALTER TABLE resolution RENAME CONSTRAINT resolution_assemblee_id_not_null TO resolution_general_meeting_id_not_null;
ALTER TABLE resolution RENAME CONSTRAINT resolution_contre_check TO resolution_votes_against_check;
ALTER TABLE resolution RENAME CONSTRAINT resolution_contre_not_null TO resolution_votes_against_not_null;
ALTER TABLE resolution RENAME CONSTRAINT resolution_ordre_not_null TO resolution_position_not_null;
ALTER TABLE resolution RENAME CONSTRAINT resolution_pour_check TO resolution_votes_for_check;
ALTER TABLE resolution RENAME CONSTRAINT resolution_pour_not_null TO resolution_votes_for_not_null;
ALTER TABLE resolution RENAME CONSTRAINT resolution_texte_not_null TO resolution_text_not_null;
ALTER TABLE resolution RENAME CONSTRAINT resolution_titre_not_null TO resolution_title_not_null;
ALTER TABLE tenancy RENAME CONSTRAINT sejour_id_not_null TO tenancy_id_not_null;
ALTER TABLE tenancy RENAME CONSTRAINT sejour_locataire_id_fkey TO tenancy_tenant_id_fkey;
ALTER TABLE tenancy RENAME CONSTRAINT sejour_locataire_id_not_null TO tenancy_tenant_id_not_null;
ALTER TABLE tenancy RENAME CONSTRAINT sejour_lot_id_fkey TO tenancy_unit_id_fkey;
ALTER TABLE tenancy RENAME CONSTRAINT sejour_lot_id_not_null TO tenancy_unit_id_not_null;
ALTER TABLE tenancy RENAME CONSTRAINT sejour_lot_id_periode_excl TO tenancy_unit_id_period_excl;
ALTER TABLE tenancy RENAME CONSTRAINT sejour_periode_check TO tenancy_period_check;
ALTER TABLE tenancy RENAME CONSTRAINT sejour_periode_not_null TO tenancy_period_not_null;
ALTER TABLE tenancy RENAME CONSTRAINT sejour_pkey TO tenancy_pkey;
ALTER TABLE session RENAME CONSTRAINT session_cree_le_not_null TO session_created_at_not_null;
ALTER TABLE session RENAME CONSTRAINT session_empreinte_not_null TO session_token_hash_not_null;
ALTER TABLE session RENAME CONSTRAINT session_expire_le_not_null TO session_expires_at_not_null;
ALTER TABLE session RENAME CONSTRAINT session_utilisateur_id_fkey TO session_app_user_id_fkey;
ALTER TABLE session RENAME CONSTRAINT session_utilisateur_id_not_null TO session_app_user_id_not_null;
ALTER TABLE company RENAME CONSTRAINT societe_denomination_not_null TO company_name_not_null;
ALTER TABLE company RENAME CONSTRAINT societe_forme_not_null TO company_legal_form_not_null;
ALTER TABLE company RENAME CONSTRAINT societe_id_check TO company_id_check;
ALTER TABLE company RENAME CONSTRAINT societe_id_not_null TO company_id_not_null;
ALTER TABLE company RENAME CONSTRAINT societe_pkey TO company_pkey;
ALTER TABLE masked_term RENAME CONSTRAINT terme_masque_pkey TO masked_term_pkey;
ALTER TABLE masked_term RENAME CONSTRAINT terme_masque_terme_check TO masked_term_term_check;
ALTER TABLE masked_term RENAME CONSTRAINT terme_masque_terme_not_null TO masked_term_term_not_null;
ALTER TABLE works_invoice RENAME CONSTRAINT travaux_date_facture_not_null TO works_invoice_invoice_date_not_null;
ALTER TABLE works_invoice RENAME CONSTRAINT travaux_description_not_null TO works_invoice_description_not_null;
ALTER TABLE works_invoice RENAME CONSTRAINT travaux_fournisseur_not_null TO works_invoice_supplier_not_null;
ALTER TABLE works_invoice RENAME CONSTRAINT travaux_id_not_null TO works_invoice_id_not_null;
ALTER TABLE works_invoice RENAME CONSTRAINT travaux_immeuble_id_fkey TO works_invoice_building_id_fkey;
ALTER TABLE works_invoice RENAME CONSTRAINT travaux_immeuble_id_not_null TO works_invoice_building_id_not_null;
ALTER TABLE works_invoice RENAME CONSTRAINT travaux_lot_id_fkey TO works_invoice_unit_id_fkey;
ALTER TABLE works_invoice RENAME CONSTRAINT travaux_montant_ttc_not_null TO works_invoice_total_incl_tax_not_null;
ALTER TABLE works_invoice RENAME CONSTRAINT travaux_nature_not_null TO works_invoice_nature_not_null;
ALTER TABLE works_invoice RENAME CONSTRAINT travaux_pkey TO works_invoice_pkey;
ALTER TABLE app_user RENAME CONSTRAINT utilisateur_cree_le_not_null TO app_user_created_at_not_null;
ALTER TABLE app_user RENAME CONSTRAINT utilisateur_email_key TO app_user_email_key;
ALTER TABLE app_user RENAME CONSTRAINT utilisateur_email_not_null TO app_user_email_not_null;
ALTER TABLE app_user RENAME CONSTRAINT utilisateur_id_not_null TO app_user_id_not_null;
ALTER TABLE app_user RENAME CONSTRAINT utilisateur_nom_not_null TO app_user_name_not_null;
ALTER TABLE app_user RENAME CONSTRAINT utilisateur_pkey TO app_user_pkey;
ALTER TABLE deposit_payment RENAME CONSTRAINT versement_depot_date_versement_not_null TO deposit_payment_payment_date_not_null;
ALTER TABLE deposit_payment RENAME CONSTRAINT versement_depot_id_not_null TO deposit_payment_id_not_null;
ALTER TABLE deposit_payment RENAME CONSTRAINT versement_depot_montant_check TO deposit_payment_amount_check;
ALTER TABLE deposit_payment RENAME CONSTRAINT versement_depot_montant_not_null TO deposit_payment_amount_not_null;
ALTER TABLE deposit_payment RENAME CONSTRAINT versement_depot_mouvement_id_fkey TO deposit_payment_bank_transaction_id_fkey;
ALTER TABLE deposit_payment RENAME CONSTRAINT versement_depot_pkey TO deposit_payment_pkey;
ALTER TABLE deposit_payment RENAME CONSTRAINT versement_depot_sejour_id_fkey TO deposit_payment_tenancy_id_fkey;
ALTER TABLE deposit_payment RENAME CONSTRAINT versement_depot_sejour_id_not_null TO deposit_payment_tenancy_id_not_null;

-- Indexes
ALTER INDEX facture_numero_validee RENAME TO invoice_number_validated;
ALTER INDEX facture_annexe_facture_id_idx RENAME TO invoice_tenant_copy_invoice_id_idx;
ALTER INDEX ligne_facture_periode_idx RENAME TO invoice_line_period_idx;
ALTER INDEX mouvement_date_operation_idx RENAME TO bank_transaction_transaction_date_idx;
ALTER INDEX paiement_mouvement_id_idx RENAME TO payment_bank_transaction_id_idx;
ALTER INDEX paiement_regularisation_id_idx RENAME TO payment_charge_adjustment_id_idx;
ALTER INDEX paiement_sejour_id_mois_idx RENAME TO payment_tenancy_id_month_idx;
ALTER INDEX passkey_utilisateur_id_idx RENAME TO passkey_app_user_id_idx;
ALTER INDEX reglement_facture_mouvement_id_idx RENAME TO invoice_payment_bank_transaction_id_idx;
ALTER INDEX reglement_travaux_mouvement_id_idx RENAME TO works_invoice_payment_bank_transaction_id_idx;
ALTER INDEX session_utilisateur_id_idx RENAME TO session_app_user_id_idx;
ALTER INDEX travaux_immeuble_id_date_facture_idx RENAME TO works_invoice_building_id_invoice_date_idx;
ALTER INDEX versement_depot_mouvement_id_idx RENAME TO deposit_payment_bank_transaction_id_idx;
ALTER INDEX versement_depot_sejour_id_idx RENAME TO deposit_payment_tenancy_id_idx;

-- Sequences
ALTER SEQUENCE assemblee_id_seq RENAME TO general_meeting_id_seq;
ALTER SEQUENCE associe_id_seq RENAME TO partner_id_seq;
ALTER SEQUENCE echeance_id_seq RENAME TO rent_schedule_id_seq;
ALTER SEQUENCE extracteur_id_seq RENAME TO extractor_id_seq;
ALTER SEQUENCE facture_annexe_id_seq RENAME TO invoice_tenant_copy_id_seq;
ALTER SEQUENCE facture_id_seq RENAME TO invoice_id_seq;
ALTER SEQUENCE fournisseur_id_seq RENAME TO supplier_id_seq;
ALTER SEQUENCE immeuble_id_seq RENAME TO building_id_seq;
ALTER SEQUENCE jeton_api_id_seq RENAME TO api_token_id_seq;
ALTER SEQUENCE ligne_facture_id_seq RENAME TO invoice_line_id_seq;
ALTER SEQUENCE locataire_id_seq RENAME TO tenant_id_seq;
ALTER SEQUENCE lot_id_seq RENAME TO unit_id_seq;
ALTER SEQUENCE mouvement_id_seq RENAME TO bank_transaction_id_seq;
ALTER SEQUENCE paiement_id_seq RENAME TO payment_id_seq;
ALTER SEQUENCE provision_annuelle_id_seq RENAME TO annual_charge_advance_id_seq;
ALTER SEQUENCE reglement_facture_id_seq RENAME TO invoice_payment_id_seq;
ALTER SEQUENCE reglement_travaux_id_seq RENAME TO works_invoice_payment_id_seq;
ALTER SEQUENCE regularisation_id_seq RENAME TO charge_adjustment_id_seq;
ALTER SEQUENCE releve_bancaire_id_seq RENAME TO bank_statement_id_seq;
ALTER SEQUENCE sejour_id_seq RENAME TO tenancy_id_seq;
ALTER SEQUENCE travaux_id_seq RENAME TO works_invoice_id_seq;
ALTER SEQUENCE utilisateur_id_seq RENAME TO app_user_id_seq;
ALTER SEQUENCE versement_depot_id_seq RENAME TO deposit_payment_id_seq;

-- ---------------------------------------------------------------- text values checked by a constraint, again

ALTER TABLE payment ADD CONSTRAINT payment_method_check
  CHECK (method IN ('transfer', 'direct_debit', 'cheque', 'cash', 'other', 'deposit'));
ALTER TABLE payment ADD CONSTRAINT payment_deposit_without_transaction
  CHECK (method IS DISTINCT FROM 'deposit' OR bank_transaction_id IS NULL);
ALTER TABLE bank_transaction ADD CONSTRAINT bank_transaction_category_check CHECK (category IN ('tenant', 'works',
  'security_deposit', 'agency', 'loan', 'insurance', 'energy', 'water', 'taxes', 'bank_fees', 'co_ownership',
  'fees', 'partners', 'internal_transfer', 'other'));
ALTER TABLE bank_transaction ADD CONSTRAINT bank_transaction_other_has_note
  CHECK (category IS DISTINCT FROM 'other' OR note IS NOT NULL);

-- ---------------------------------------------------------------- JSON stored (triggers dropped above: the frozen
-- rows can be rewritten here, their keys only)

-- Grouping settings of every extractor version
UPDATE extractor SET settings = jsonb_strip_nulls(jsonb_build_object(
  'lineTolerance', settings -> 'toleranceHauteur', 'joinGap', settings -> 'collage',
  'columnGap', settings -> 'colonne', 'margin', settings -> 'marge'));

-- Tenant copies: their settings and the origin of each zone painted
UPDATE invoice_tenant_copy SET
  settings = jsonb_build_object('dpi', settings -> 'dpi', 'threshold', settings -> 'seuil'),
  zones = coalesce((
    SELECT jsonb_agg((z - 'origine') || jsonb_build_object('origin', CASE z ->> 'origine'
      WHEN 'termes' THEN 'terms' WHEN 'extracteur' THEN 'extractor' WHEN 'modele' THEN 'template'
      WHEN 'main' THEN 'manual' ELSE z ->> 'origine' END) ORDER BY n)
    FROM jsonb_array_elements(zones) WITH ORDINALITY AS x(z, n)), '[]');

-- Snapshots of the charge adjustments sent (the supporting statement, its PDF made again from it): keys only
UPDATE charge_adjustment SET snapshot = jsonb_build_object(
  'building', jsonb_build_object(
    'name', snapshot -> 'immeuble' -> 'nom', 'address', snapshot -> 'immeuble' -> 'adresse',
    'total_charge_shares', snapshot -> 'immeuble' -> 'total_tantiemes'),
  'period', jsonb_build_object('start', snapshot -> 'exercice' -> 'debut', 'end', snapshot -> 'exercice' -> 'fin'),
  'tenancy', jsonb_build_object(
    'id', snapshot -> 'sejour' -> 'id', 'tenant', snapshot -> 'sejour' -> 'locataire', 'unit', snapshot -> 'sejour' -> 'lot',
    'unit_label', snapshot -> 'sejour' -> 'designation', 'charge_shares', snapshot -> 'sejour' -> 'tantiemes',
    'present_from', snapshot -> 'sejour' -> 'present_du', 'present_to', snapshot -> 'sejour' -> 'present_au',
    'days', snapshot -> 'sejour' -> 'jours', 'period_days', snapshot -> 'sejour' -> 'jours_exercice'),
  'headings', coalesce((
    SELECT jsonb_agg(jsonb_build_object('label', h -> 'libelle', 'building_expenses', h -> 'depenses_immeuble',
      'share', h -> 'quote_part') ORDER BY n)
    FROM jsonb_array_elements(snapshot -> 'rubriques') WITH ORDINALITY AS x(h, n)), '[]'),
  'total', snapshot -> 'total',
  'advances', snapshot -> 'provisions',
  'balance', snapshot -> 'solde',
  'invoices', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'invoice_id', f -> 'facture_id', 'supplier', f -> 'fournisseur', 'number', f -> 'numero',
      'invoice_date', f -> 'date_facture',
      'energy', to_jsonb(CASE f ->> 'energie' WHEN 'gaz' THEN 'gas' WHEN 'electricite' THEN 'electricity'
        WHEN 'eau' THEN 'water' WHEN 'ordures_menageres' THEN 'household_waste' WHEN 'autre' THEN 'other'
        ELSE f ->> 'energie' END),
      'start', f -> 'debut', 'end', f -> 'fin', 'invoice_amount', f -> 'montant_facture', 'share', f -> 'quote_part')
      ORDER BY n)
    FROM jsonb_array_elements(snapshot -> 'factures') WITH ORDINALITY AS x(f, n)), '[]'),
  'generated_at', snapshot -> 'genere_le')
WHERE snapshot IS NOT NULL;

-- ---------------------------------------------------------------- triggers, in English

CREATE FUNCTION extractor_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Un extracteur n''est jamais modifié ni supprimé : créer une nouvelle version (ADR 0013)';
END $$;
CREATE TRIGGER extractor_frozen BEFORE UPDATE OR DELETE ON extractor
  FOR EACH ROW EXECUTE FUNCTION extractor_frozen();

-- Only checked_at may be set, once
CREATE FUNCTION tenant_copy_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.checked_at IS NULL AND NEW.checked_at IS NOT NULL
     AND (to_jsonb(NEW) - 'checked_at') = (to_jsonb(OLD) - 'checked_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Une annexe n''est jamais modifiée : la refaire (ADR 0024)';
END $$;
CREATE TRIGGER tenant_copy_frozen BEFORE UPDATE ON invoice_tenant_copy
  FOR EACH ROW EXECUTE FUNCTION tenant_copy_frozen();

-- A closed general meeting: only its signed minutes may still be added
CREATE FUNCTION general_meeting_closed_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Assemblée close : elle n''est jamais supprimée (registre, ADR 0016)';
  END IF;
  IF (to_jsonb(NEW) - 'signed_minutes') <> (to_jsonb(OLD) - 'signed_minutes') THEN
    RAISE EXCEPTION 'Assemblée close : elle n''est plus modifiée (registre, ADR 0016)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER general_meeting_closed_frozen BEFORE UPDATE OR DELETE ON general_meeting
  FOR EACH ROW WHEN (OLD.status = 'closed') EXECUTE FUNCTION general_meeting_closed_frozen();

CREATE FUNCTION general_meeting_detail_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM general_meeting
             WHERE id = coalesce(NEW.general_meeting_id, OLD.general_meeting_id) AND status = 'closed') THEN
    RAISE EXCEPTION 'Assemblée close : ses présences et résolutions ne changent plus (registre, ADR 0016)';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER attendance_frozen BEFORE INSERT OR UPDATE OR DELETE ON attendance
  FOR EACH ROW EXECUTE FUNCTION general_meeting_detail_frozen();
CREATE TRIGGER resolution_frozen BEFORE INSERT OR UPDATE OR DELETE ON resolution
  FOR EACH ROW EXECUTE FUNCTION general_meeting_detail_frozen();

-- ---------------------------------------------------------------- views, in English

CREATE VIEW v_invoice_check AS
SELECT i.id, i.number, i.energy, i.total_incl_tax,
       coalesce(sum(l.amount_incl_tax), 0)                            AS lines_total,
       i.total_incl_tax - coalesce(sum(l.amount_incl_tax), 0)         AS gap,
       abs(i.total_incl_tax - coalesce(sum(l.amount_incl_tax), 0)) <= 0.05 AS ok
FROM invoice i LEFT JOIN invoice_line l ON l.invoice_id = i.id
GROUP BY i.id;

-- Charge advances of a year: the sum of the payments when there are any, else the yearly total entered
CREATE VIEW v_charge_advance AS
WITH paid AS (
  SELECT tenancy_id, extract(year FROM month)::int AS year, sum(charge_advance) AS amount
  FROM payment WHERE month IS NOT NULL GROUP BY 1, 2
)
SELECT p.tenancy_id, p.year, p.amount, 'payments'::text AS source FROM paid p
UNION ALL
SELECT a.tenancy_id, a.year, a.amount, 'entered' FROM annual_charge_advance a
WHERE NOT EXISTS (SELECT 1 FROM paid p WHERE p.tenancy_id = a.tenancy_id AND p.year = a.year);

-- ---------------------------------------------------------------- functions, in English

-- Paid toward a charge adjustment and the ones it replaced
CREATE FUNCTION charge_adjustment_paid(p_id int) RETURNS numeric
LANGUAGE sql STABLE AS $$
WITH RECURSIVE chain AS (
  SELECT id, replaces_id FROM charge_adjustment WHERE id = p_id
  UNION ALL
  SELECT c.id, c.replaces_id FROM charge_adjustment c JOIN chain ch ON c.id = ch.replaces_id
)
SELECT coalesce(sum(p.charge_adjustment), 0) FROM payment p WHERE p.charge_adjustment_id IN (SELECT id FROM chain)
$$;

CREATE FUNCTION charge_adjustment_state(p_id int) RETURNS text
LANGUAGE sql STABLE AS $$
SELECT CASE WHEN c.sent_on IS NULL THEN 'draft'
            WHEN abs(c.balance - charge_adjustment_paid(c.id)) < 1 THEN 'settled'
            ELSE 'pending' END
FROM charge_adjustment c WHERE c.id = p_id
$$;

CREATE FUNCTION charge_adjustment_settled_on(p_id int) RETURNS date
LANGUAGE sql STABLE AS $$
WITH RECURSIVE chain AS (
  SELECT id, replaces_id FROM charge_adjustment WHERE id = p_id
  UNION ALL
  SELECT c.id, c.replaces_id FROM charge_adjustment c JOIN chain ch ON c.id = ch.replaces_id
)
SELECT CASE WHEN charge_adjustment_state(p_id) = 'settled'
            THEN (SELECT max(p.payment_date) FROM payment p WHERE p.charge_adjustment_id IN (SELECT id FROM chain)) END
$$;

CREATE FUNCTION day_count(r daterange) RETURNS int
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN isempty(r) THEN 0 ELSE upper(r) - lower(r) END $$;

-- Each recoverable line of the validated invoices of a building, apportioned to the tenancies of a period by days and
-- charge shares; the rest (empty units) with tenancy_id NULL
CREATE FUNCTION apportionment(p_building int, p_start date, p_end date)
RETURNS TABLE (invoice_line_id int, invoice_id int, energy energy, category line_category,
               tenancy_id int, days int, amount numeric)
LANGUAGE sql STABLE AS $$
WITH per AS (SELECT daterange(p_start, p_end + 1) AS r),
tot AS (SELECT sum(charge_shares)::numeric AS t FROM unit WHERE building_id = p_building),
lin AS (
  SELECT l.id, l.invoice_id, i.energy, l.category, l.amount_incl_tax,
         day_count(l.period) AS n, l.period * per.r AS pe
  FROM invoice_line l
  JOIN invoice i ON i.id = l.invoice_id AND i.building_id = p_building AND i.status = 'validated'
  CROSS JOIN per
  WHERE l.allocation = 'recoverable' AND l.period && per.r
),
parts AS (
  SELECT lin.id, lin.invoice_id, lin.energy, lin.category, t.id AS tenancy_id,
         day_count(lin.pe * t.period) AS days,
         lin.amount_incl_tax * day_count(lin.pe * t.period) / lin.n * u.charge_shares / tot.t AS amount
  FROM lin
  JOIN tenancy t ON t.period && lin.pe
  JOIN unit u ON u.id = t.unit_id AND u.building_id = p_building
  CROSS JOIN tot
)
SELECT id, invoice_id, energy, category, tenancy_id, days, amount FROM parts
UNION ALL
SELECT lin.id, lin.invoice_id, lin.energy, lin.category, NULL, day_count(lin.pe),
       lin.amount_incl_tax * day_count(lin.pe) / lin.n
         - coalesce((SELECT sum(p.amount) FROM parts p WHERE p.id = lin.id), 0)
FROM lin
$$;

CREATE FUNCTION charge_statement(p_building int, p_start date, p_end date)
RETURNS TABLE (tenancy_id int, tenant text, unit text, charge_shares int, present daterange, days int,
               gas_consumption numeric, gas_other numeric,
               electricity_consumption numeric, electricity_other numeric,
               water numeric, household_waste numeric,
               total numeric, advances numeric, balance numeric)
LANGUAGE sql STABLE AS $$
WITH r AS (SELECT * FROM apportionment(p_building, p_start, p_end) WHERE tenancy_id IS NOT NULL),
agg AS (
  SELECT r.tenancy_id,
    coalesce(sum(amount) FILTER (WHERE energy = 'gas' AND category = 'consumption'), 0)           AS gc,
    coalesce(sum(amount) FILTER (WHERE energy = 'gas' AND category <> 'consumption'), 0)          AS go,
    coalesce(sum(amount) FILTER (WHERE energy = 'electricity' AND category = 'consumption'), 0)   AS ec,
    coalesce(sum(amount) FILTER (WHERE energy = 'electricity' AND category <> 'consumption'), 0)  AS eo,
    coalesce(sum(amount) FILTER (WHERE energy = 'water'), 0)                                      AS wa,
    coalesce(sum(amount) FILTER (WHERE energy = 'household_waste'), 0)                            AS hw
  FROM r GROUP BY r.tenancy_id
),
adv AS (
  SELECT a.tenancy_id, sum(a.amount) AS m FROM v_charge_advance a
  WHERE a.year BETWEEN extract(year FROM p_start) AND extract(year FROM p_end)
  GROUP BY a.tenancy_id
)
SELECT t.id, te.name, u.code, u.charge_shares,
       t.period * daterange(p_start, p_end + 1),
       day_count(t.period * daterange(p_start, p_end + 1)),
       coalesce(a.gc, 0), coalesce(a.go, 0), coalesce(a.ec, 0), coalesce(a.eo, 0),
       coalesce(a.wa, 0), coalesce(a.hw, 0),
       coalesce(a.gc + a.go + a.ec + a.eo + a.wa + a.hw, 0),
       coalesce(v.m, 0),
       coalesce(a.gc + a.go + a.ec + a.eo + a.wa + a.hw, 0) - coalesce(v.m, 0)
FROM tenancy t
JOIN unit u ON u.id = t.unit_id AND u.building_id = p_building
JOIN tenant te ON te.id = t.tenant_id
LEFT JOIN agg a ON a.tenancy_id = t.id
LEFT JOIN adv v ON v.tenancy_id = t.id
WHERE t.period && daterange(p_start, p_end + 1) OR v.m IS NOT NULL
ORDER BY u.code, lower(t.period)
$$;

CREATE FUNCTION summary(p_building int, p_start date, p_end date)
RETURNS TABLE (energy energy, invoices numeric, tenants numeric, owner numeric)
LANGUAGE sql STABLE AS $$
SELECT energy,
       sum(amount),
       coalesce(sum(amount) FILTER (WHERE tenancy_id IS NOT NULL), 0),
       coalesce(sum(amount) FILTER (WHERE tenancy_id IS NULL), 0)
FROM apportionment(p_building, p_start, p_end)
GROUP BY energy ORDER BY energy
$$;

COMMIT;

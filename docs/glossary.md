# Glossaire : du français à l'anglais (base, API, code)

Le code et la base passent à l'anglais : un nom français y est une dette technique (`CLAUDE.md`). Ce glossaire fixe,
une fois pour toutes, le nom anglais de chaque terme du métier, de chaque table, colonne, type et valeur stockée. Il
sert de référence au renommage (une migration pour toute la base, puis l'API, le frontend et colibri) et ensuite à
tout nom nouveau. L'interface et la documentation restent en français.

Conventions :

- `snake_case` en base et dans le JSON de l'API ; tables au singulier (comme aujourd'hui) ;
- un horodatage `*_le` devient `*_at` (`cree_le` → `created_at`), une date `date_*` devient `*_date` ou `*_on` ;
- un mot réservé de PostgreSQL ou ambigu est évité (`user`, `transaction`, `order`) ;
- les choix discutés sont notés à la fin (« Décisions »).

## Termes du métier

| Français | Anglais | Note |
|---|---|---|
| immeuble | building | |
| lot | unit | un logement ou un local de l'immeuble |
| tantièmes | charge shares | part d'un lot dans les charges (somme des lots de l'immeuble) |
| locataire | tenant | |
| séjour | tenancy | occupation d'un lot par un locataire, de l'entrée à la sortie |
| dépôt de garantie | security deposit | |
| échéance (loyer + provision à partir d'un mois) | rent schedule | |
| loyer | rent | |
| provision sur charges | charge advance | versée chaque mois avec le loyer |
| régularisation | charge adjustment | solde des charges d'une période, demandé ou remboursé au locataire |
| décompte (de charges) | charge statement | calcul par locataire d'une période |
| répartition | apportionment | partage d'une facture entre les séjours |
| synthèse | summary | |
| exercice (période régularisée) | period | |
| facture | invoice | |
| ligne de facture | invoice line | |
| affectation (récupérable, propriétaire…) | allocation | à qui revient une ligne |
| récupérable | recoverable | à la charge des locataires |
| version locataire (annexe) | tenant copy | facture masquée, en images, jointe au justificatif (ADR 0024) |
| terme masqué | masked term | |
| zones masquées (tracées à la main) | masked zones | ADR 0025 |
| fournisseur | supplier | |
| extracteur | extractor | |
| réglages (d'un extracteur) | settings | |
| relevé bancaire | bank statement | |
| mouvement (de banque) | bank transaction | |
| rapprochement (bancaire) | reconciliation | paiement ou facture rattaché à un mouvement (ADR 0018) |
| règlement (d'une facture) | payment | le mouvement qui la paie |
| paiement (reçu d'un locataire) | payment | |
| versement (sur le dépôt) | deposit payment | |
| retenue (sur le dépôt) | deposit retention | |
| travaux | works invoice | factures de travaux du propriétaire (ADR 0015) |
| société (SCI) | company | |
| associé | partner | |
| parts (sociales) | shares | |
| gérant | manager | |
| assemblée | general meeting | |
| présence | attendance | |
| résolution | resolution | |
| procès-verbal | minutes | |
| utilisateur | app user | `user` est réservé |
| jeton d'API | API token | |
| lien d'enregistrement | registration link | |
| instantané | snapshot | ce qui a été envoyé ou clos, figé |

## Types énumérés et valeurs stockées

Renommés sans déplacer de données (`ALTER TYPE … RENAME TO`, `ALTER TYPE … RENAME VALUE`). Les valeurs produites par
les extracteurs enregistrés (catégorie, énergie, affectation) demandent une nouvelle version de chacun.

| Type | Anglais | Valeurs |
|---|---|---|
| `energie` | `energy` | gaz → `gas`, electricite → `electricity`, eau → `water`, ordures_menageres → `household_waste`, autre → `other` |
| `categorie_ligne` | `line_category` | consommation → `consumption`, abonnement → `subscription`, taxe → `tax`, prestation → `service`, penalite → `penalty`, autre → `other` |
| `statut_facture` | `invoice_status` | a_verifier → `draft`, validee → `validated`, remplacee → `replaced` |
| `affectation_ligne` | `line_allocation` | recuperable → `recoverable`, proprietaire → `owner`, hors_immeuble → `outside_building` |
| `decision_regul` | `adjustment_decision` | abandonnee → `written_off`, irrecouvrable → `unrecoverable` |
| `type_extracteur` | `extractor_type` | facture → `invoice`, releve → `bank_statement` |
| `nature_travaux` | `works_nature` | entretien → `maintenance`, amelioration → `improvement`, construction → `construction` |
| `type_assemblee` | `meeting_type` | ordinaire → `ordinary`, extraordinaire → `extraordinary` |
| `statut_assemblee` | `meeting_status` | brouillon → `draft`, close → `closed` |
| `presence_associe` | `attendance_status` | present → `present`, represente → `represented`, absent → `absent` |

Valeurs en `text` contrôlées par `CHECK` (migration des données, puis de la contrainte) :

| Colonne | Valeurs |
|---|---|
| `paiement.mode` → `payment.method` | virement → `transfer`, prelevement → `direct_debit`, cheque → `cheque`, especes → `cash`, autre → `other`, depot → `deposit` |
| `mouvement.categorie` → `bank_transaction.category` | locataire → `tenant`, travaux → `works`, depot_garantie → `security_deposit`, agence → `agency`, emprunt → `loan`, assurance → `insurance`, energie → `energy`, eau → `water`, impots → `taxes`, frais_bancaires → `bank_fees`, copropriete → `co_ownership`, honoraires → `fees`, associes → `partners`, virement_interne → `internal_transfer`, autre → `other` |

Valeurs calculées (fonctions SQL, API) :

| Où | Valeurs |
|---|---|
| état d'une régularisation (`regularisation_etat`) | brouillon → `draft`, en_attente → `pending`, soldee → `settled` |
| état de la version locataire d'une facture (API) | confidentiel → `confidential`, sans_pdf → `no_pdf`, a_faire → `to_make`, a_verifier → `to_check`, verifiee → `checked` |
| origine d'une zone masquée (JSON) | termes → `terms`, extracteur → `extractor`, modele → `template`, main → `manual` |

## Tables et colonnes

Colonnes inchangées (déjà anglaises ou neutres) non répétées : `id`, `code`, `email`, `version`, `source`, `type`,
`description`, `capital`, `rcs`, `kwh`, `transports`, `nature` (sauf mention).

| Table | Anglais | Colonnes |
|---|---|---|
| `immeuble` | `building` | nom → `name`, adresse → `address`, debut_gestion → `managed_from` |
| `lot` | `unit` | immeuble_id → `building_id`, designation → `label`, surface_m2 → `area_m2`, tantiemes → `charge_shares` |
| `locataire` | `tenant` | nom → `name`, telephone → `phone`, note → `note` |
| `sejour` | `tenancy` | lot_id → `unit_id`, locataire_id → `tenant_id`, periode → `period`, depot_garantie → `security_deposit` |
| `fournisseur` | `supplier` | nom → `name`, confidentiel → `confidential`, zones_masquees → `masked_zones` |
| `extracteur` | `extractor` | fournisseur_id → `supplier_id`, energie → `energy`, reglages → `settings`, code → `code`, moteur → `engine`, cree_le → `created_at` |
| `releve_bancaire` | `bank_statement` | fournisseur_id → `supplier_id`, compte → `account`, date_releve → `statement_date`, solde_precedent → `previous_balance`, nouveau_solde → `new_balance`, fichier_pdf → `pdf_file`, extracteur_id → `extractor_id`, importe_le → `imported_at` |
| `mouvement` | `bank_transaction` | releve_id → `bank_statement_id`, ordre → `position`, date_operation → `transaction_date`, date_valeur → `value_date`, libelle → `label`, detail → `detail`, montant → `amount`, categorie → `category` |
| `facture` | `invoice` | immeuble_id → `building_id`, fournisseur_id → `supplier_id`, energie → `energy`, numero → `number`, date_facture → `invoice_date`, montant_ttc → `total_incl_tax`, fichier_pdf → `pdf_file`, statut → `status`, extracteur_id → `extractor_id`, remplacee_par → `replaced_by`, remplacee_le → `replaced_at`, motif_remplacement → `replacement_reason`, remplace_id → `replaces_id`, annexe_id → `tenant_copy_id`, zones_masquees → `masked_zones` |
| `terme_masque` | `masked_term` | terme → `term` |
| `facture_annexe` | `invoice_tenant_copy` | facture_id → `invoice_id`, fichier_pdf → `pdf_file`, source_pdf → `source_pdf`, zones → `zones`, extracteur_id → `extractor_id`, termes → `terms`, reglages → `settings`, cree_le → `created_at`, verifiee_le → `checked_at`, pages_scannees → `scanned_pages` |
| `ligne_facture` | `invoice_line` | facture_id → `invoice_id`, ordre → `position`, categorie → `category`, libelle → `label`, periode → `period`, montant_ht → `amount_excl_tax`, taux_tva → `vat_rate`, montant_ttc → `amount_incl_tax`, affectation → `allocation` |
| `provision_annuelle` | `annual_charge_advance` | sejour_id → `tenancy_id`, annee → `year`, montant → `amount` |
| `regularisation` | `charge_adjustment` | sejour_id → `tenancy_id`, exercice → `period`, montant_du → `amount_due`, provisions → `advances`, solde → `balance`, date_envoi → `sent_on`, decision → `decision`, remplace_id → `replaces_id`, instantane → `snapshot`, annexes_envoyees → `sent_tenant_copies`, cree_le → `created_at` |
| `paiement` | `payment` | sejour_id → `tenancy_id`, date_paiement → `payment_date`, mois → `month`, loyer → `rent`, provision → `charge_advance`, regularisation_id → `charge_adjustment_id`, regularisation → `charge_adjustment`, mode → `method`, mouvement_id → `bank_transaction_id` |
| `versement_depot` | `deposit_payment` | sejour_id → `tenancy_id`, date_versement → `payment_date`, montant → `amount`, mouvement_id → `bank_transaction_id` |
| `echeance` | `rent_schedule` | sejour_id → `tenancy_id`, a_partir_du → `from_month`, loyer → `rent`, provision → `charge_advance` |
| `travaux` | `works_invoice` | immeuble_id → `building_id`, lot_id → `unit_id`, fournisseur → `supplier`, nature → `nature`, date_facture → `invoice_date`, montant_ttc → `total_incl_tax`, fichier_pdf → `pdf_file` |
| `reglement_travaux` | `works_invoice_payment` | travaux_id → `works_invoice_id`, mouvement_id → `bank_transaction_id`, montant → `amount` |
| `reglement_facture` | `invoice_payment` | facture_id → `invoice_id`, mouvement_id → `bank_transaction_id`, montant → `amount` |
| `societe` | `company` | denomination → `name`, forme → `legal_form`, siege → `registered_office` |
| `associe` | `partner` | nom → `name`, parts → `shares`, gerant → `manager`, adresse → `address` |
| `assemblee` | `general_meeting` | numero → `number`, date → `date`, heure → `time`, lieu → `place`, ordre_du_jour → `agenda`, president → `chair`, observations → `remarks`, statut → `status`, close_le → `closed_at`, instantane → `snapshot`, pv_signe → `signed_minutes` |
| `presence` | `attendance` | assemblee_id → `general_meeting_id`, associe_id → `partner_id`, presence → `status`, represente_par → `represented_by` |
| `resolution` | `resolution` | assemblee_id → `general_meeting_id`, ordre → `position`, titre → `title`, texte → `text`, pour → `votes_for`, contre → `votes_against`, abstention → `abstentions` |
| `utilisateur` | `app_user` | nom → `name`, cree_le → `created_at` |
| `passkey` | `passkey` | utilisateur_id → `app_user_id`, cle_publique → `public_key`, compteur → `sign_count`, appareil → `device`, cree_le → `created_at`, utilisee_le → `used_at` |
| `session` | `session` | empreinte → `token_hash`, utilisateur_id → `app_user_id`, cree_le → `created_at`, expire_le → `expires_at` |
| `lien_enregistrement` | `registration_link` | empreinte → `token_hash`, utilisateur_id → `app_user_id`, expire_le → `expires_at`, utilise_le → `used_at` |
| `jeton_api` | `api_token` | nom → `name`, empreinte → `token_hash`, utilisateur_id → `app_user_id`, cree_le → `created_at`, utilise_le → `used_at`, revoque_le → `revoked_at` |

## Vues, fonctions, déclencheurs

| Français | Anglais | Colonnes rendues |
|---|---|---|
| vue `v_controle_facture` | `v_invoice_check` | total_lignes → `lines_total`, ecart → `gap`, ok → `ok` |
| vue `v_provision` | `v_charge_advance` | annee → `year`, montant → `amount`, source : paiements → `payments`, saisie → `entered` |
| `nb_jours(daterange)` | `day_count` | |
| `repartition(immeuble, debut, fin)` | `apportionment(building, start, end)` | ligne_id → `invoice_line_id`, facture_id → `invoice_id`, energie → `energy`, categorie → `category`, sejour_id → `tenancy_id`, jours → `days`, montant → `amount` |
| `decompte(…)` | `charge_statement(…)` | locataire → `tenant`, lot → `unit`, tantiemes → `charge_shares`, present → `present`, jours → `days`, gaz_consommation → `gas_consumption`, gaz_autres → `gas_other`, electricite_consommation → `electricity_consumption`, electricite_autres → `electricity_other`, eau → `water`, ordures_menageres → `household_waste`, total, provisions → `advances`, solde → `balance` |
| `synthese(…)` | `summary(…)` | factures → `invoices`, locataires → `tenants`, proprietaire → `owner` |
| `regularisation_verse(id)` | `charge_adjustment_paid` | |
| `regularisation_etat(id)` | `charge_adjustment_state` | |
| `regularisation_date_solde(id)` | `charge_adjustment_settled_on` | |
| déclencheurs `extracteur_fige`, `facture_annexe_figee`, `assemblee_close_figee`, `assemblee_detail_fige`, `presence_figee`, `resolution_figee` | `extractor_frozen`, `tenant_copy_frozen`, `general_meeting_closed_frozen`, `general_meeting_detail_frozen`, `attendance_frozen`, `resolution_frozen` | messages d'erreur : restent en français (montrés à l'utilisateur) |

Contraintes et index nommés : renommés comme leur table (`facture_numero_validee` → `invoice_number_validated`,
`paiement_mode_check` → `payment_method_check`…).

## Contenus JSON stockés

Les clés des objets `jsonb` changent avec une migration des données (`jsonb` réécrit), en même temps que le code qui
les lit.

| Où | Clés |
|---|---|
| `extractor.settings` (réglages de regroupement) | toleranceHauteur → `lineTolerance`, collage → `joinGap`, colonne → `columnGap`, marge → `margin` |
| `invoice_tenant_copy.settings` | dpi → `dpi`, seuil → `threshold` |
| `invoice_tenant_copy.zones` | origine → `origin` (et ses valeurs, ci-dessus) |
| `supplier.masked_zones`, `invoice.masked_zones` | inchangées (`page`, `x0`, `y0`, `x1`, `y1`) |
| `charge_adjustment.snapshot` (le justificatif envoyé, d'où son PDF est régénéré) | voir ci-dessous ; migré (décision 7) |
| `charge_adjustment.sent_tenant_copies` | inchangé (`{ "<invoice_id>": <tenant_copy_id> }`) |
| `general_meeting.snapshot` | aucun en production à la migration ; suit les colonnes de `general_meeting`, `company`, `partner`, `resolution` |

Instantané d'une régularisation (`Justificatif` dans le code, `SupportingStatement` après le renommage) :

| Clé | Anglais | Sous-clés |
|---|---|---|
| immeuble | `building` | nom → `name`, adresse → `address`, total_tantiemes → `total_charge_shares` |
| exercice | `period` | debut → `start`, fin → `end` |
| sejour | `tenancy` | id, locataire → `tenant`, lot → `unit`, designation → `unit_label`, tantiemes → `charge_shares`, present_du → `present_from`, present_au → `present_to`, jours → `days`, jours_exercice → `period_days` |
| rubriques | `headings` | libelle → `label` (texte affiché, inchangé), depenses_immeuble → `building_expenses`, quote_part → `share` |
| total | `total` | |
| provisions | `advances` | |
| solde | `balance` | |
| factures | `invoices` | facture_id → `invoice_id`, fournisseur → `supplier`, numero → `number`, date_facture → `invoice_date`, energie → `energy` (et sa valeur, comme le type `energy`), debut → `start`, fin → `end`, montant_facture → `invoice_amount`, quote_part → `share` |
| genere_le | `generated_at` | |

Garde-fou de la migration : les justificatifs des régularisations figées, régénérés avant et après, doivent avoir le
même texte.

## Décisions

Arrêtées avec le propriétaire le 2026-10-31.

1. **Régularisation** : `charge_adjustment` (*reconciliation* sert au rapprochement bancaire).
2. **Provision sur charges** : `charge_advance` (*provision* est un faux ami, « provision pour risques »).
3. **Version locataire** : `tenant_copy`.
4. **Travaux** : `works_invoice` (la table contient des factures).
5. **Tantièmes** du lot : `charge_shares` ; **parts** de l'associé : `shares`.
6. **`a_verifier`** d'une facture : `draft`, comme l'écran (« Brouillon »).
7. **Instantanés** (`snapshot`) : migrés en anglais (une seule forme dans le code) ; seuls les noms des clés changent,
   jamais les chiffres, vérifié en régénérant les justificatifs avant et après.
8. **Tables mortes** : `compteur`, `releve` (relevés de compteur) et `evenement`, vides en production et sans code,
   sont supprimées par la migration de renommage ; elles seront recréées en anglais le jour où l'eau se répartira au
   compteur.

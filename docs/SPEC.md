# Gestion des charges locatives – cahier des charges

## 1. Contexte

Un propriétaire (particulier ou SCI) loue des logements dans un ou plusieurs immeubles. Les charges communes (gaz du
chauffage, électricité des communs, eau, taxe d'enlèvement des ordures ménagères) sont payées par le propriétaire,
puis réparties entre les locataires au **tantième**, sur leurs jours de présence ; chaque année, une régularisation
compare ces charges aux provisions versées.

La méthode a d'abord été validée dans un classeur Excel ; le logiciel reproduit ses résultats au centime (les tests
de la première exploitation le vérifient sur ses données) tout en supprimant la saisie manuelle des factures.

## 2. Objectifs, par phase

| Phase | Contenu | Critère de fin |
|---|---|---|
| 1 | Import d'une facture (PDF ou copier-coller), lignes affichées dans une grille éditable, contrôles automatiques (§ 6), enregistrement | Les PDF réels s'importent sans retouche, contrôle OK |
| 2 | Immeubles, lots, locataires, séjours, provisions ; décompte d'un exercice ; export Excel | Décomptes du classeur retrouvés au centime |
| 3 | PDF justificatif par locataire, texte des mails (régularisation, rectificatif) | Un PDF lisible par un locataire, montants identiques au décompte |
| 4 | Paiements reçus, suivi des régularisations, synthèse fiscale des charges non récupérées, plusieurs immeubles | Synthèse fiscale par année |

## 3. Règles métier (décisions prises)

- **R1 – Méthode de référence : la consommation de l'exercice.** C'est la méthode de la régularisation 2023. Une charge appartient à l'exercice pendant lequel elle a été consommée, pas à celui où elle a été payée. (Les mails 2024-2025 mélangeaient les deux : double comptage de fin 2023 et oubli de fin 2025.)
- **R2 – Chaque ligne de facture a sa propre période.** Consommation par sous-période, abonnement souvent facturé d'avance, taxes avec leurs propres dates, régularisations d'abonnement négatives. On ne répartit jamais « le reste de la facture » sur la période globale.
- **R3 – Formule.** Pour chaque ligne récupérable, chaque séjour, l'exercice choisi (bornes incluses) :
  `part = TTC × jours(ligne ∩ séjour ∩ exercice) ÷ jours(ligne) × tantièmes du lot ÷ total tantièmes de l'immeuble`.
  Un départ au milieu d'un mois n'est proratisé que sur la sous-période concernée.
- **R4 – Vacance.** Les jours sans locataire d'un lot restent au propriétaire (jamais reportés sur les autres locataires). Ils sont visibles explicitement (« part propriétaire »).
- **R5 – Affectation d'une ligne** (ADR 0013, 2026-10-17). `recuperable` : répartie entre les locataires. `proprietaire` : pénalités de retard, taxe foncière hors ordures ménagères, tout frais propre au bailleur ; stockée (pour la comptabilité et la synthèse fiscale) mais jamais répartie. `hors_immeuble` : concerne un autre bien (des garages portés sur le même avis de taxe foncière) ; stockée pour que la somme des lignes retombe sur le total, ni répartie ni dans la synthèse fiscale de l'immeuble.
- **R6 – Ligne sans période imprimée** (CTA / TICGN sur certaines factures ENGIE) : période de consommation de la facture, avec une note.
- **R7 – Eau** : les factures vont de relevé à relevé ; on stocke `fin = date du relevé suivant − 1 jour` pour qu'aucun jour ne soit compté deux fois. TTC uniquement (HT/TVA non repris pour l'instant).
- **R8 – Ordures ménagères** : montant de la TEOM de l'avis de taxe foncière, période = année civile.
- **R9 – Provisions** : saisies par séjour et par année civile ; un exercice sur plusieurs années additionne les années concernées. Un exercice qui ne commence pas un 1ᵉʳ janvier doit déclencher un avertissement.
- **R10 – Arrondis** : calculs en `numeric` non arrondi ; arrondi au centime à l'affichage et dans les documents. Tolérance de contrôle facture : 0,05 € (arrondis de TVA des fournisseurs).
- **R11 – Changement de clé de répartition** (par ex. eau aux compteurs individuels) : à date d'effet explicite, jamais rétroactif sans décision. Prévoir dans le modèle une clé par énergie et par période (phase ultérieure).

## 4. Modèle de données

Voir `backend/migrations/V001__schema.sql` (et les migrations suivantes). Points clés :

- toutes les périodes sont des `daterange` semi-ouverts `[début, fin+1)` ; un séjour en cours a une borne haute infinie ;
- contrainte d'exclusion : deux séjours ne peuvent pas se chevaucher sur un même lot ;
- `facture.montant_ttc` = total imprimé, sert au contrôle (`v_controle_facture`) ;
- `ligne_facture.montant_ttc` en `numeric(12,3)` (certaines lignes ENGIE ont 3 décimales) ;
- `regularisation` garde l'historique (statut, montant reçu, `remplace_id` pour un rectificatif).

## 5. Moteur de répartition

Implémenté en SQL dans `backend/migrations/V001__schema.sql` (anciennes migrations 002 et 003) ; seules les factures validées sont réparties (ADR 0003) :

- `repartition(immeuble, debut, fin)` : détail ligne × séjour, plus une ligne « propriétaire » (sejour_id NULL) par ligne de facture ;
- `decompte(immeuble, debut, fin)` : une ligne par séjour, colonnes gaz conso / gaz autres / élec conso / élec autres / eau / ordures ménagères / total / provisions / solde ;
- `synthese(immeuble, debut, fin)` : par énergie, total factures / part locataires / part propriétaire.

Les tests de la première exploitation vérifient ces fonctions contre ses décomptes attendus au centime. Le serveur appelle ces fonctions ; il ne réimplémente pas la formule.

## 6. Import des factures

Contrainte : **tout est local, aucun service externe payant** (pas d'API de LLM).

Pipeline (ADR 0013, 2026-10-17, remplace la lecture par colonnes de l'ADR 0004) :

1. Le PDF est lu **dans le navigateur** par pdf.js : morceaux de texte et leur position, regroupés en lignes de texte.
2. Détection du fournisseur : la dernière version de chaque **extracteur** (code TypeScript écrit dans l'écran
   « Fournisseurs », enregistré en base par version, jamais modifié) dit s'il reconnaît le PDF ; il lit le numéro, la
   date, le total et les lignes (catégorie, libellé, période, montant, affectation). Un champ introuvable (le total de
   la taxe foncière, sur un autre PDF) se saisit dans le brouillon.
3. Le PDF et le brouillon sont envoyés à l'API : PDF archivé (`facture.fichier_pdf`), brouillon enregistré avec la
   version de l'extracteur (`facture.extracteur_id`).
4. Si aucun extracteur ne reconnaît la facture : grille vide pré-remplie de l'en-tête, saisie ou **collage d'un tableau** (TSV depuis Excel ou copié du PDF).
5. Affichage dans la grille éditable, statut `a_verifier`, contrôles en direct (voir ci-dessous).
6. Validation par l'utilisateur → statut `validee`. **Seules les factures validées entrent dans les décomptes** (décision du 2026-10-12, ADR 0003) ; avant, la facture est un brouillon (aperçu).

Contrôles automatiques (tous affichés dans la grille, une ligne en défaut est surlignée) :

- somme des TTC des lignes = total imprimé (tolérance 0,05 €) ; total manquant : brouillon enregistrable, validation bloquée ;
- chaque période est comprise dans la plage de la facture (tolérance pour l'abonnement facturé d'avance) ;
- aucune période attribuée par défaut sans être signalée (ligne marquée « période à confirmer ») ;
- consommation : sous-périodes contiguës, sans trou ni chevauchement (les kWh ne sont plus lus, ADR 0013) ;
- une ligne `penalite` est forcément à la charge du propriétaire (`proprietaire`).

Le contrôle du total ne suffit pas : un libellé tronqué peut donner une mauvaise période avec un montant juste
(cas rencontré lors des essais du lecteur par colonnes).

Autres entrées : copier-coller d'un tableau (TSV depuis Excel ou depuis le PDF), saisie manuelle.

Format d'une ligne (identique pour les extracteurs et le collage ; `kwh`, `montant_ht`, `taux_tva` facultatifs, vides
pour une facture lue par un extracteur) :
`{categorie, libelle, debut, fin, kwh, montant_ht, taux_tva, montant_ttc, affectation, note}`, dates ISO **bornes incluses**.

Aucun extracteur livré (ADR 0026) : ils sont en base, écrits dans l'éditeur à partir d'un modèle (`frontend/src/extraction/modeles/`) ; le moteur est testé sur une facture fictive (`cd frontend && npm test`), les extracteurs sur les factures réelles par l'exploitation.
Particularités connues :

- **EDF** : lignes en une seule ligne de texte, abonnement facturé d'avance, accise (ex-CSPE) en deux lignes quand le taux change, CTA avec des périodes qui se chevauchent d'un jour d'une facture à l'autre (conservées telles qu'imprimées). TTC ligne = HT × (1 + TVA) arrondi : écart de 0,01 € possible avec le total.
- **ENGIE Gaz Passerelle** : libellés coupés sur plusieurs lignes (imprimés au-dessus et en dessous des montants) ; année de début parfois omise (« du 05/05 au 30/06/23 ») ; régularisations d'abonnement négatives ; CTA/TICGN sans période sur certaines factures ; pénalités de retard.
- **Taxe foncière** (DGFiP) : détail des cotisations par adresse ; le total de l'avis et les frais de gestion sont sur l'avis principal, un autre PDF, et se saisissent à la main. Adresse de l'immeuble : TEOM récupérable, le reste à la charge du propriétaire ; autres biens du même avis : hors immeuble. Extracteur propre à chaque exploitation (adresses).
- **Eau** : estimations puis factures de rattrapage couvrant plusieurs années.
- **Mensualisation gaz depuis mai 2026** : les échéances mensuelles sont des paiements, pas des lignes ; seule la facture annuelle (avec son détail) se saisit.

## 7. Écrans

- **Factures** : liste par immeuble / énergie / année, statut, contrôle ; bouton importer.
- **Édition d'une facture** : en-tête (fournisseur, numéro, date, total imprimé) + grille RevoGrid (`@revolist/vue3-datagrid`) : édition de cellules, sélection de plages, copier-coller depuis Excel, ajout/suppression de lignes ; bandeau « somme des lignes / total / écart » en direct ; aperçu du PDF à côté.
- **Immeuble** : lots et tantièmes (total affiché).
- **Locataires et séjours** : frise par lot (visualise les trous = vacance), erreurs de chevauchement remontées de la contrainte SQL.
- **Provisions** (puis paiements en phase 4).
- **Décompte** : choix de l'immeuble et de l'exercice, tableau par séjour, synthèse par énergie, clic sur un montant → détail ligne par ligne (fonction `repartition`).
- **Régularisations** : création à partir du décompte, statut, rectificatif.
- **Fiscal** (phase 4) : par année, charges de vacance et soldes non récupérés au départ.

## 8. Documents

- **Export Excel** du décompte et du détail (même présentation que le classeur, utile pour l'expert-comptable).
- **PDF justificatif par locataire** : période de présence, tantièmes, tableau par énergie (dépenses de l'immeuble, quote-part), provisions, solde, liste des factures prises en compte avec leurs périodes, puis en annexe les PDF de ces factures (sauf celles d'un fournisseur confidentiel, comme l'avis de taxe foncière : listées, « consultable sur demande »). Composé par pdfmake et pdf-lib, sans navigateur (ADR 0014).
- **Texte de mail** : régularisation standard et rectificatif (excuses, montant initial, montant corrigé, déduction des versements déjà faits, proposition d'étalement, nouvelle provision mensuelle proposée). Ouverture dans le client mail (pas d'envoi automatique au début).

## 9. Fiscal (phase 4, à faire valider par l'expert-comptable)

D'après la doctrine (BOFiP BOI-RFPI-BASE-20-40) :

- les provisions reçues ne sont pas des recettes et les charges payées pour le compte des locataires ne sont pas déductibles ;
- sont déductibles les charges récupérables **non remboursées au 31/12 de l'année du départ du locataire** (toutes années depuis son entrée), l'année du départ ; déclaration rectificative possible si le montant est connu plus tard ;
- les charges supportées pendant la **vacance** d'un bien destiné à la location sont déductibles ;
- dépôt de garantie conservé pour des charges : ajouté aux recettes et déduit comme charge non récupérée (simplification si montants égaux) ;
- 2044 : ligne 225 ; pour une SCI : déclaration 2072 puis quote-part des associés.

Une charge « offerte » à un locataire encore en place n'est pas une perte déclarable avant son départ.

## 10. Tests

- `cd backend && npm run test:local` : contrôles du § 6, textes des mails, santé de l'API (base de test, schéma seul).
- `cd frontend && npm test` : moteur d'extraction sur une facture fictive.
- Les tests sur des données réelles (décomptes au centime, import des vraies factures, justificatifs) sont lancés par
  l'exploitation, sur ce code, avec ses données (`TEST_SEED_FILES`).

## 11. Pile technique

Fastify (TypeScript) + PostgreSQL + Vue 3, dans une image Docker publiée sur GHCR. Factures lues dans le navigateur par pdf.js (ADR 0013) ; justificatifs par pdfmake et pdf-lib (ADR 0014) ; conteneurs Docker (ADR 0011). Grille : RevoGrid. Aucune dépendance à un service externe payant.

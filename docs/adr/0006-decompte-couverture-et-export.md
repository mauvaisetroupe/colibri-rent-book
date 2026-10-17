# 6. Décompte, couverture des périodes et export Excel

- Statut : Accepté
- Date : 2026-10-12

## Contexte

La phase 2 sert le décompte d'un exercice à partir des fonctions SQL `decompte`, `synthese` et `repartition`
(ADR 0002 : la formule n'est pas réimplémentée). Les régularisations 2024-2025 ont montré deux erreurs que le calcul
seul ne voit pas : une fin d'année jamais facturée et une période comptée deux fois (SPEC R1). La SPEC demande aussi un
export Excel pour l'expert-comptable.

## Décision

- **Montants non arrondis dans l'API** : le décompte, la synthèse et le détail renvoient le `numeric` du moteur en
  texte, sans arrondi. L'écran et l'export arrondissent au centime pour l'affichage (R10) ; les totaux de colonnes sont
  additionnés en décimal (`big.js`) puis arrondis une fois.
- **Couverture** (`GET /api/couverture`, écran « Couverture ») : pour chaque énergie facturée à l'immeuble, les jours de
  l'exercice couverts par des factures **validées** (multiranges PostgreSQL : `range_agg`), les trous, et les lignes
  qui se chevauchent. Gaz et électricité : lignes de consommation seulement (l'abonnement est facturé d'avance, les
  taxes se chevauchent par construction) ; eau et ordures ménagères : toutes les lignes récupérables.
- **Avertissements en tête du décompte** (et dans l'export) : exercice qui ne suit pas l'année civile (R9), factures
  encore en brouillon sur la période (ADR 0003), trous de couverture, chevauchements, séjour présent sans provision
  saisie pour une année de l'exercice. Ils n'empêchent pas le calcul.
- **Détail** (`GET /api/decompte/detail`) : lignes de `repartition` filtrées par séjour (ou part du propriétaire),
  énergie et groupe (consommation / autres, comme les colonnes) ; les parts du propriétaire nulles sont omises.
- **Export Excel** (`GET /api/decompte/export`, exceljs) : onglets Décompte, Synthèse, Détail (filtre automatique) et
  Avertissements ; montants arrondis au centime en nombres Excel, format monétaire. La mise en page du classeur
  le classeur d'origine n'étant pas disponible, la présentation suit les colonnes de la feuille « Décompte » de la SPEC.
- **Référentiel** : immeubles et lots (tantièmes), locataires, séjours (frise par lot ; chevauchement refusé par la
  contrainte d'exclusion, message en français), provisions par séjour et par année. Changer les tantièmes d'un lot
  change aussi les décomptes passés (pas encore de clé datée, R11) : l'écran demande confirmation.

## Conséquences

- `tests/golden.json` est retrouvé au centime par l'API (`backend/src/routes/decompte.test.ts`) ; les soldes affichés
  pour 2024-2025 sont ceux du § 11 de la SPEC.
- Sur les données réelles de la première exploitation, la couverture était complète ; les seuls chevauchements
  venaient d'une facture d'eau de rattrapage couvrant plusieurs années, signalés tant que son découpage n'était pas tranché.
- exceljs ajoute environ 190 paquets npm au backend.

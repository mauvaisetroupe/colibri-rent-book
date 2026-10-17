# 8. Paiements reçus, suivi des régularisations et synthèse fiscale

- Statut : Accepté
- Date : 2026-10-12

## Contexte

Phase 4 de la SPEC : paiements reçus, suivi des régularisations, synthèse fiscale des charges non récupérées,
second immeuble. Le propriétaire a choisi de saisir **tous les paiements mensuels** (loyer et provision), et de gérer le
**dépôt de garantie** conservé pour charges. Les décomptes 2024-2025 reposent sur des totaux annuels de provisions
(seed), qui doivent rester valables (`tests/golden.json`).

## Décision

- **Table `paiement`** (migration 005) : un paiement reçu (virement, chèque…) par ligne, avec le mois couvert, le
  loyer et la provision de ce mois, et/ou un montant versé sur une régularisation (négatif : remboursement par le
  propriétaire). Saisie (révisée le 2026-10-13, à la demande du propriétaire) : **tous les paiements, versements de
  régularisation compris, se saisissent dans l'écran Paiements**, un par un, dans un formulaire : montant reçu
  (relevé), puis sa répartition entre loyer, provision et régularisation ; enregistrement refusé si la répartition ne
  retombe pas sur le montant (`montant` vérifié par l'API, non stocké : il vaut la somme des trois). Liste filtrable,
  une ligne cliquable par paiement. L'écran Régularisations n'enregistre plus de versement : il les affiche.
- **Provisions d'une année = somme des provisions de ses paiements mensuels** dès que l'année en a un ; sinon, le
  total annuel saisi à la main (`provision_annuelle`, historique). Vue `v_provision`, lue par `decompte()`. Le total
  annuel d'une année alimentée par des paiements n'est plus modifiable.
- **Mois impayés** : signalés (écran Paiements, accueil) pour les mois de présence sans paiement, à partir du premier
  mois qui a un paiement enregistré (avant, on ne dispose que des totaux annuels).
- **Suivi des régularisations** : le montant reçu est la somme des paiements rattachés, ceux des régularisations
  remplacées compris (fonction `regularisation_verse`) ; la colonne `montant_recu` est supprimée, ses valeurs reprises
  en paiements. Statut « payée » automatique quand le reçu atteint le solde (et retour à « envoyée » si un paiement
  est supprimé) ; « étalée », « abandonnée », « irrécouvrable » choisis à la main. **Remplacé par l'ADR 0010** : état
  calculé (brouillon, en attente, soldée) et décision du propriétaire (abandonnée, irrécouvrable). Un versement ne va que sur la
  régularisation en cours (envoyée, non remplacée).
- **Dépôt de garantie** : sur le séjour, le montant reçu et la part conservée au départ pour des charges impayées.
- **Synthèse fiscale d'une année civile** (SPEC § 9, à faire valider par l'expert-comptable) :
  - charges de la vacance = part du propriétaire du décompte de l'année ;
  - pour chaque locataire parti dans l'année, sur tout son séjour : charges − provisions − versements de
    régularisation reçus au 31/12 ; la partie positive est déductible ; un séjour non entièrement couvert par des
    factures validées est signalé « données incomplètes » ;
  - total ligne 225 de la 2044 = vacance + non remboursé ; dépôts conservés pour charges à ajouter aux recettes ;
  - pour information : lignes non récupérables des factures de l'année, régularisations abandonnées à des locataires
    encore présents (non déductibles avant le départ).
- **Second immeuble** : création d'un immeuble depuis l'écran Immeuble ; le sélecteur d'immeuble apparaît dès qu'il y en a
  deux. Les données sont saisies par le propriétaire.

## Conséquences

- `golden.json` reste retrouvé au centime : sans paiement mensuel, les provisions sont les totaux annuels du seed.
- Les séjours commencés avant 2024 ont des charges incomplètes (pas de factures détaillées 2021-2023, SPEC § 10
  point 6) : la synthèse fiscale de leur départ le signale.
- Les loyers sont saisis mais ne servent pas encore (quittances, suivi des impayés de loyer, recettes fiscales :
  plus tard si besoin).

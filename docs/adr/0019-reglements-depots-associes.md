# 19. Travaux payés en plusieurs fois, dépôts de garantie, associés

- Statut : Accepté (complète 0015 et 0018) ; dépôts de garantie modifiés par 0021
- Date : 2026-10-18

## Contexte

Le rapprochement des relevés (ADR 0018) a montré trois limites du modèle :

- **Une facture de travaux n'avait qu'une date de paiement et qu'un mouvement.** Un artisan payé par un acompte sur
  devis puis par un solde ne pouvait être rattaché qu'une fois ; l'autre virement restait « à compléter » ou portait
  une note. L'année fiscale (date du paiement, ADR 0015) ne savait pas partager une facture entre deux années.
- **Le dépôt de garantie n'existait que dans le bail** (`sejour.depot_garantie`, ADR 0008) et dans des notes de
  mouvements (« Dépôt de garantie (versé avec le premier loyer) »). Ce qui a été réellement versé, puis remboursé, ne se
  voyait nulle part.
- **« Virement interne, apport » rassemblait les mouvements des associés** (apport en capital, versements aux
  associés) : l'expert-comptable a besoin de les distinguer d'un éventuel virement entre deux comptes de la société.

## Décision

### Règlements des travaux

- **Payé, c'est vu à la banque** : une facture de travaux n'est payée que par des mouvements bancaires (le relevé est
  la preuve du paiement en cas de contrôle). Pas de date de paiement saisie à la main : sans mouvement, la facture n'est
  pas payée. Une autre sorte de facture payée à la banque (énergie) suivrait la même règle.
- Une facture a ses **règlements** (`reglement_travaux` : un mouvement, un montant positif) : un acompte puis un solde
  font deux règlements ; un virement qui paie deux factures, un règlement sur chacune. Leur total ne dépasse ni la
  facture ni le mouvement.
- La facture se saisit d'abord, seule (écran Travaux, avec son PDF) ; un règlement naît d'un rattachement, depuis le
  mouvement (« Rattacher à une facture de travaux ») ou depuis la facture (« Rattacher un virement » : les débits
  « travaux » ou non catégorisés qui ont un reste). Il vaut ce qui reste du mouvement, au plus ce qui reste de la
  facture ; détacher le supprime. Le serveur propose, pour un débit, les factures dont le reste est son montant.
- `travaux.date_paiement` et `travaux.mouvement_id` disparaissent : la migration 016 fait d'une facture vue sur un
  relevé un règlement de son montant ; une date de paiement saisie sans mouvement passe dans la note (virement à
  rattacher). L'API rend les règlements (date et libellé du mouvement), le payé, le reste, la date du dernier.
- **Année fiscale : celle du mouvement de chaque règlement.** La synthèse fiscale liste les règlements de l'année ;
  « restant à payer » donne, au 31 décembre, ce que les factures émises n'ont pas encore réglé. À confirmer avec
  l'expert-comptable, comme la règle de l'ADR 0015 qu'elle prolonge.

### Dépôts de garantie

- `versement_depot` : un séjour, une date, un montant (positif : versé par le locataire ; négatif : remboursé), un
  mouvement bancaire facultatif, une note. Ce que le propriétaire détient est leur somme (`depot_detenu` du séjour).
  `sejour.depot_garantie` reste le montant prévu au bail, `depot_retenu_charges` la part conservée pour charges (SPEC
  § 9, synthèse fiscale) : inchangés.
- Un versement se rattache à un mouvement « paiement de locataire » (versé avec le loyer, remboursé avec le dernier
  mois) ou « dépôt de garantie » (seul), du même signe.
- Dans la fenêtre de paiement ouverte depuis un virement, le reste non réparti se déclare **dépôt de garantie** (un
  versement est créé) ou reste à rattacher. La case est cochée d'office quand le libellé parle de caution ou de
  garantie, ou quand le séjour commence moins d'un mois avant le virement. *Remplacé par l'ADR 0021 : le dépôt se
  saisit depuis le séjour, la banque y renvoie ; `depot_retenu_charges` devient la retenue en paiements.*

### Catégories

- `remboursement_depot` devient **`depot_garantie`** (« Dépôt de garantie », versé ou remboursé seul) et a un détail,
  comme « locataire » et « travaux » : sans versement qui le couvre, le mouvement est « à compléter ».
- **Une note ne complète pas un mouvement** (modifié le 2026-10-19) : un mouvement « locataire », « travaux » ou
  « dépôt de garantie » n'est complet que si son détail (paiements, règlements, versements) couvre son montant. La
  note reste un commentaire (obligatoire pour « autre ») ; elle ne justifie plus un reste.
- **`agence`** (« Versement d'une agence (gérance) », ajoutée le 2026-10-19, migration 018) : les loyers encaissés par
  une agence de gestion et reversés, ses frais déduits, avant que le propriétaire gère lui-même la location. Sans
  détail, jamais « à compléter » : les paiements des locataires de cette période ne s'y rattachent pas (le virement
  n'est ni un loyer ni une somme de loyers) ; les revenus et les frais de ces années se lisent dans le compte rendu de
  gérance de l'agence. Le filtre par catégorie de l'écran Banque les retrouve.
- `virement_interne` devient **`associes`** (« Associés : apports, versements ») pour tous les mouvements existants ;
  `virement_interne` reste, renommé « Virement entre comptes de la société ».
- Le montant couvert d'un mouvement additionne paiements, règlements de travaux et versements de dépôt
  (`couverture.ts`), et chaque rattachement vérifie la catégorie, le signe et le montant au même endroit.

## Conséquences

- Les factures payées en deux fois se rattachent à leurs deux virements, et la synthèse fiscale les partage entre
  années ; modifier une facture ne touche pas à ses règlements (un montant inférieur à ce qu'ils paient est refusé).
- Les dépôts de garantie ont un historique réel ; la fiche du locataire montre le dépôt détenu, et signale un écart
  avec le bail pour un séjour en cours.
- Migration 016 : règlements repris des factures payées, catégories renommées. Les dépôts notés sur un mouvement
  restent des notes (le mouvement est « à compléter ») : les transformer en versements est une reprise de l'exploitation (données propres à chaque
  propriétaire), pas de la migration ; un mouvement « dépôt de garantie » repris sans versement est « à compléter ».

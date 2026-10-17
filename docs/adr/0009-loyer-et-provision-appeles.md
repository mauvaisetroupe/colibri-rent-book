# 9. Loyer et provision appelés

- Statut : Accepté
- Date : 2026-10-14

## Contexte

L'écran Contrôles signalait seulement les mois de présence **sans aucun** paiement : un mois payé en partie
(un locataire, un mois : 190 € reçus) passait inaperçu, faute de connaître le montant attendu. La base ne gardait que
ce qui a été reçu (ADR 0008). Le loyer et la provision appelés changent au fil du séjour (révision du loyer, nouvelle
provision après une régularisation) : le propriétaire veut en garder l'historique.

## Décision

- **Table `echeance`** (migration 006) : par séjour, une ligne par changement, avec le mois à partir duquel elle vaut
  (`a_partir_du`, 1ᵉʳ du mois), le loyer et la provision appelés chaque mois, une note. Elle vaut jusqu'à la ligne
  suivante du séjour ; une seule ligne par séjour et par mois. Les lignes ne sont pas écrasées : l'historique reste.
  Saisie dans la fiche du locataire (écran Locataires), enregistrée avec elle. API : `GET/POST/PUT/DELETE
  /api/echeances`.
- **Montant attendu d'un mois** (`frontend/src/echeances.ts`) : la ligne en vigueur ce mois-là ; un mois d'entrée ou
  de sortie est appelé **au prorata des jours de présence**, arrondi au centime pour le loyer et pour la provision
  (comme dans les anciens classeurs : 540 € × 25/31 = 435,48 € pour un locataire entré le 7 du mois, 550 € × 15/30 =
  275 € pour un autre entré le 16).
- **Contrôles › Paiements** : pour chaque mois suivi (à partir du premier mois qui a un paiement), le loyer + provision
  reçus pour ce mois (`paiement.mois`) comparés au montant attendu : payé (à 1 € près : le legacy arrondit un mois
  au prorata à l'euro, 266 € versés pour 266,12 € appelés), payé en partie, rien reçu. Un rattrapage saisi le mois
  suivant **avec le bon mois couvert** complète le mois concerné ; saisi sur un autre mois, il apparaît en trop sur
  celui-là. Reste dû par locataire = somme des montants attendus − reçus sur l'exercice
  (net : un trop-perçu d'un mois compense un manque). Sans ligne d'échéance, le mois affiche seulement ce qui a été
  reçu, et un avertissement invite à renseigner le montant appelé.
- **Formulaire de paiement** : le loyer et la provision proposés sont ceux appelés pour le mois couvert (au prorata),
  sinon ceux du dernier mois payé.
- Le décompte n'est pas concerné : ses provisions restent celles **reçues** (`v_provision`, ADR 0008).

## Conséquences

- L'historique d'une exploitation se reprend de ses anciens classeurs (`echeance`, source de chaque ligne dans sa
  note) ; les nouveaux séjours se saisissent dans la fiche du locataire.
- Le calcul du montant attendu est fait par l'interface (affichage seulement) : à reprendre côté serveur s'il doit
  servir ailleurs (relances, synthèse fiscale).
- Migration 006 appliquée à la base de développement ; à appliquer à la production.

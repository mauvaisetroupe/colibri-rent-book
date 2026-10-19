# 21. Dépôt de garantie géré depuis le séjour, retenue en paiements

- Statut : Accepté (modifie 0019)
- Date : 2026-10-19

## Contexte

Le dépôt de garantie était réparti en trois endroits sans lien entre eux : le montant du bail et la « part conservée
au départ pour charges » sur le séjour (saisie à la main, lue seulement par la synthèse fiscale), les versements et
remboursements (`versement_depot`, ADR 0019) créés depuis l'écran Banque. Un dépôt non rendu ne soldait donc rien :
M. Meyer, parti fin 2024 en devant ses régularisations 2023 et 2024, laisse une caution de 410 € que les écrans des
régularisations ignoraient (reste dû affiché : 963,09 € au lieu de 553,09 €). Un dépôt non rendu couvre aussi
souvent des loyers impayés. Et le dépôt, objet métier avec son histoire (versé, rendu, conservé), se créait depuis la
banque, alors que les factures et les travaux se saisissent dans leur écran et que la banque ne fait que rattacher.

## Décision

- **Le dépôt se gère depuis le séjour** (écran Locataires, encadré « Dépôt de garantie » de la fiche du
  séjour, dont les opérations sont enregistrées aussitôt, à part du bouton « Enregistrer » de la fiche) : le montant du
  bail (fiche du séjour), les **dépôts reçus** et **restitutions** (`versement_depot`, rattachés à un virement ou à
  aucun : versé à une agence, avant les relevés, en espèces), et la **retenue**.
- **La retenue est faite de paiements** du mode **`depot`** (« retenue sur le dépôt ») : un dépôt non rendu, c'est un
  dépôt rendu puis un paiement de même montant. Chaque ligne couvre un **mois impayé** (loyer et provision) ou une
  **régularisation** envoyée, en cours, sans décision (au plus son reste). Le total ne dépasse pas le dépôt versé.
  Ces paiements comptent comme les autres : le mois est payé, la régularisation reçoit le montant et peut être soldée
  (ADR 0010) ; ce qui reste après la retenue se clôt par la décision « irrécouvrable ».
- **Une seule retenue par séjour, refaite d'un bloc** (`PUT /api/sejours/:id/retenue`, aucune ligne : retirée), dans
  une transaction. Ailleurs, ces paiements sont **visibles mais verrouillés** : `/api/paiements` refuse d'en créer, de
  les modifier ou de les supprimer, l'écran Paiements les montre avec un cadenas et renvoie vers le dépôt du séjour.
  Un versement de dépôt ne peut pas être modifié ou supprimé s'il laisse moins que la retenue.
- **Jamais à la banque** : une contrainte interdit de rattacher un paiement `depot` à un mouvement ; les contrôles
  (« paiements absents des relevés », filtre « non rapprochés ») et les propositions de rapprochement les ignorent.
- **Ce que le propriétaire détient** = dépôts reçus − restitutions − retenue. **La caution conservée pour charges**
  (SPEC § 9) n'est plus saisie : c'est la part de la retenue qui va aux régularisations (`sejour.depot_retenu_charges`
  supprimée, migration 019). La synthèse fiscale garde sa présentation : la caution conservée en recette, la charge non
  remboursée calculée sans elle (versements de régularisation hors retenue). Une retenue sur un loyer est un loyer
  encaissé.
- **La fenêtre de retenue propose** ce qui reste dû (`frontend/src/depot.ts`) : les mois impayés depuis le premier mois
  payé du séjour (loyer et provision appelés, au prorata, ADR 0009, moins les paiements) et les régularisations
  ouvertes, la plus ancienne d'abord, jusqu'au dépôt versé ; date par défaut : la sortie. Le propriétaire ajuste.
- **Depuis la banque, plus de création de dépôt** : sur un virement « locataire » ou « dépôt de garantie », le bouton
  « Dépôt de garantie… » ouvre la fiche du séjour (le locataire nommé dans le libellé, sinon à choisir), le virement
  prérempli dans son dépôt ; « Rattacher… » rattache un dépôt saisi sans virement, comme un paiement. La case
  « c'est le dépôt de garantie » de la fenêtre de paiement disparaît : le reste d'un virement reste « à compléter »
  jusqu'au dépôt.

## Conséquences

- Les régularisations d'un locataire parti sont soldées par sa caution, à une date et pour des montants figés ; la
  perte restante est une décision visible.
- Le dépôt détenu d'un séjour en cours suppose son versement initial saisi : pour un dépôt versé à une agence ou avant
  les relevés, « Dépôt reçu… » sans virement.
- Migration 019 : mode `depot`, contrainte sans mouvement, `depot_retenu_charges` supprimée ; une valeur saisie passe
  dans la note du séjour (« à saisir en retenue sur le dépôt »), à refaire en retenue.

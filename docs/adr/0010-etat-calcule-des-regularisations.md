# 10. État calculé des régularisations, décision du propriétaire

- Statut : Accepté
- Date : 2026-10-15
- Remplace, dans l'ADR 0008, la partie « statuts » du suivi des régularisations

## Contexte

`regularisation.statut` mélangeait ce que le système déduit (brouillon ou envoyée : la date d'envoi ; payée : les
versements, recopiés par l'API à chaque paiement, avec `date_solde`) et ce que seul le propriétaire décide (charge
abandonnée, irrécouvrable). « Étalée » ne servait à aucun calcul. Une information déduite et stockée peut être fausse,
et l'écran proposait de « changer le statut » comme un filtre.

## Décision

- **État calculé, jamais stocké** (fonction SQL `regularisation_etat`) : `brouillon` (pas de date d'envoi),
  `en_attente` (envoyée, reste à payer ou à rembourser), `soldee` (versements, rectificatifs compris, égaux au solde
  **à 1 € près** : le legacy arrondit, 918 € versés pour 918,22 € demandés). Date de solde calculée
  (`regularisation_date_solde`) : dernier versement d'une régularisation soldée.
- **Décision du propriétaire, facultative** (`regularisation.decision`) : `abandonnee` (reste offert au locataire ; la
  synthèse fiscale le liste dans les abandons, non déductibles avant le départ) ou `irrecouvrable`. Possible seulement
  sur une régularisation envoyée et non remplacée ; retirable. API : `POST /api/regularisations/:id/decision`.
- **« Étalée » disparaît** : les versements montrent l'étalement ; la note le garde (« Étalée ; … »).
- Migration 007 : `statut` et `date_solde` supprimées, `decision` reprise des anciens statuts. Les régularisations
  envoyées sans date d'envoi (2023, legacy) reçoivent le 1ᵉʳ du mois de leur premier versement, avec la note « date
  d'envoi approximative ». Le seed (`seed/paiements.json`) suit les mêmes règles : une base recréée depuis le seed est
  identique à une base migrée.

## Conséquences

- Plus rien à tenir à jour quand un paiement est saisi, modifié ou supprimé : l'état suit.
- « Marquer envoyée » demande confirmation et peut être annulé (`DELETE /api/regularisations/:id/envoi`, retour au
  brouillon) tant qu'aucun versement n'y est rattaché, qu'aucune décision n'est prise et qu'elle n'est pas rectifiée.
- Liste des régularisations : « En cours » = brouillons et en attente sans décision ; « Closes » = soldées ou avec une
  décision. Une régularisation avec une décision n'est plus comparée au décompte (« à rectifier »).
- Appliquée le 2026-10-15 aux bases de développement et de production.

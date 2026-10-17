# 15. Factures de travaux du propriétaire

- Statut : Accepté
- Date : 2026-10-18

## Contexte

Les travaux payés par le propriétaire (réparation d'une fenêtre, réfection d'une toiture, création d'une salle de
bains) ne sont pas des charges récupérables : ils ne passent pas par la répartition. Ils comptent pour la déclaration
des revenus fonciers (2044, ligne 224 « dépenses de réparation, d'entretien et d'amélioration ») : il faut les garder,
avec leur facture, et les retrouver par année.

Décisions du propriétaire (2026-10-18) : pour la fiscalité seulement (jamais refacturés aux locataires) ; l'année est
celle du **paiement** (à confirmer avec l'expert-comptable) ; saisie à la main, avec le PDF de la facture, sans
extracteur.

## Décision

- Table `travaux` : immeuble, lot (facultatif : travaux d'un logement), fournisseur (texte libre), description, date de
  la facture, date du paiement (vide tant que la facture n'est pas payée), montant TTC, **nature**, PDF joint (même
  stockage que les factures d'énergie, par empreinte), note.
- **Nature** (`nature_travaux`) : `entretien` (réparation, entretien) et `amelioration`, **déductibles** ;
  `construction` (construction, reconstruction, agrandissement), **non déductible**. La déductibilité se déduit de la
  nature : elle n'est pas stockée.
- **Synthèse fiscale** de l'année : les travaux payés dans l'année, le total déductible (ligne 224) et, pour
  information, les non déductibles et les factures non payées.
- **Écran « Travaux »** (Tenue des comptes) : liste par année (filtres nature, payé ou non), saisie et modification,
  PDF joint ou remplacé, suppression.
- Les travaux n'entrent dans aucun décompte de charges et ne sont jamais joints aux justificatifs.

## Conséquences

- La synthèse fiscale porte enfin les dépenses de travaux à côté des charges non récupérées.
- Un PDF archivé n'est supprimé que si ni une facture d'énergie ni des travaux ne s'y réfèrent.
- À confirmer avec l'expert-comptable : l'année de paiement, et la frontière entre amélioration et agrandissement pour
  un cas donné (la nature se corrige dans l'écran).

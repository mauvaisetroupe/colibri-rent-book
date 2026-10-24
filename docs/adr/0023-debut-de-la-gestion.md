# 23. Début de la gestion d'un immeuble

- Statut : Accepté
- Date : 2026-10-24

## Contexte

Un propriétaire ne commence pas toujours à tenir ses comptes dans l'application dès l'entrée de ses locataires : une
agence de gestion encaissait les loyers et les provisions, payait ou non les factures, faisait ou non les
régularisations. Pour ces années-là, l'application n'a ni toutes les factures ni les provisions versées. Trois calculs
les comptaient pourtant :

- la **synthèse fiscale** d'un locataire parti prend tout son séjour : des charges partielles (les seules factures
  connues) sans provisions en face gonflent les « charges non remboursées » (un cas réel : 390 € de trop) ;
- les **Contrôles** signalent des périodes sans facture ;
- les **régularisations manquantes** partaient de la première régularisation faite, une approximation.

## Décision

- L'immeuble porte une **date de début de la gestion dans l'application** (`immeuble.debut_gestion`, facultative,
  Réglages › Immeuble). Vide, rien ne change.
- **Synthèse fiscale** : les charges non remboursées d'un locataire parti se calculent à partir de la plus tardive de
  son entrée et du début de la gestion (`debut_calcul`, affiché quand il diffère de l'entrée) ; les versements comptés
  sont ceux des régularisations qui touchent cette période.
- **Couverture des factures** (Contrôles, avertissements du décompte, données incomplètes de la synthèse) : pas de trou
  ni de chevauchement avant le début de la gestion.
- **Régularisations manquantes** (Contrôles, Accueil) : aucune pour un exercice fini avant le début de la gestion ;
  l'Accueil regarde les années depuis le début de la gestion (à défaut, depuis la première régularisation).

## Conséquences

- Les années gérées par une agence sortent des calculs, sans supprimer les données saisies (paiements, factures).
- Migration 022 : colonne `immeuble.debut_gestion`.

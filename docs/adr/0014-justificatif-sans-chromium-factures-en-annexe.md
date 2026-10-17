# 14. Justificatif sans Chromium, factures en annexe, fournisseurs confidentiels

- Statut : Accepté
- Date : 2026-10-17
- Modifie l'ADR 0007 (justificatif : page HTML imprimée par Chromium) ; reprend, avant la séparation des dépôts, le
  retrait de Chromium prévu par l'ADR 0012

## Contexte

Le justificatif d'une régularisation (SPEC § 8, ADR 0007) liste les factures prises en compte, mais sans les joindre :
le locataire doit les demander. Les joindre au même PDF le rend complet et moins contestable.

Deux difficultés :

- **certaines factures ne doivent pas partir telles quelles** : l'avis de taxe foncière porte le numéro fiscal du
  propriétaire et d'autres biens (des garages, par exemple) ;
- **Chromium ne sait pas assembler des PDF** : il imprime une page HTML. Il pèse aussi l'essentiel de l'image (environ
  1 Go), et l'ADR 0012 prévoyait déjà de le remplacer par une bibliothèque PDF en JavaScript.

## Décision

### Le PDF de régularisation

1. **Le justificatif**, même contenu qu'aujourd'hui (locataire, rubriques, quote-part, provisions, solde, factures
   prises en compte), composé avec **pdfmake** (description du document en JavaScript, tableaux, polices embarquées)
   au lieu d'une page HTML imprimée par Chromium.
2. **Une page « Annexes »** : chaque facture prise en compte (fournisseur, n°, date, période, montant) avec son sort :
   « jointe, page N », « non jointe : document confidentiel (données fiscales du propriétaire), consultable sur
   demande », ou « non jointe : pas de PDF » (facture saisie à la main, reçue sur papier).
3. **Les PDF des factures jointes**, à la suite, dans l'ordre de la liste, assemblés avec **pdf-lib**.

Les factures sont celles du justificatif (figé pour une régularisation envoyée, ADR 0007). Une facture validée ne
change plus : un justificatif reconstruit plus tard, annexes comprises, reste le même. Les régularisations déjà
envoyées ont aussi leurs annexes quand leur PDF est reconstruit. Pas d'option « sans annexes » : une vingtaine de
factures par an, 1 à 2 Mo, ce qui passe en pièce jointe.

La loi du 6 juillet 1989 (art. 23) prévoit que les pièces justificatives sont tenues à la disposition du locataire :
« consultable sur demande » pour un document confidentiel reste dans la règle.

### Fournisseur confidentiel

- `fournisseur.confidentiel` (booléen, faux par défaut, migration 010) : ses factures ne sont jamais jointes, elles
  sont listées avec la mention ci-dessus. Pour la SCI : « DGFiP (taxe foncière) ».
- **Écran « Fournisseurs »** (Administration), à la place de « Extracteurs » : tous les fournisseurs, avec ou sans
  extracteur (énergie, factures, version de l'extracteur utilisée, confidentiel) ; la page d'un fournisseur porte la
  case « confidentiel » et le tableau des versions de son extracteur, d'où s'ouvre l'éditeur.

### Chromium retiré

- Plus de Playwright, de Chromium ni de `/dev/shm` agrandi dans l'image ; plus de `PDF_BROWSER_CHANNEL`.
- Police embarquée par pdfmake (Roboto) : le même rendu sur le Mac, dans les tests et en production.
- Les tests lisent toujours le texte du PDF produit (`pdftotext`, outil de test seulement) pour y retrouver les
  montants du décompte.

## Conséquences

- Un PDF de régularisation complet : le locataire a les factures sous les yeux, sauf les documents confidentiels,
  signalés.
- Image plus légère et plus rapide à construire ; plus de navigateur à lancer ni à relancer dans l'API.
- La mise en page du justificatif est refaite : à vérifier une fois sur une régularisation réelle.
- `CLAUDE.md`, `STATUS.md`, `deployment.md`, SPEC § 8 et l'accueil à mettre à jour.

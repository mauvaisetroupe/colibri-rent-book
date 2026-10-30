# 25. Zones tracées à la main sur les factures scannées

- Statut : Proposé
- Date : 2026-10-30
- Remplace, pour les pages scannées, le masquage par le texte et les zones fixes de `redactions()` de l'ADR 0024 ;
  réalise sa section « Plus tard »

## Contexte

L'ADR 0024 masque, sur la version locataire d'une facture, les termes communs et ce que rend `redactions()` de
l'extracteur du fournisseur, cherchés dans le texte que lit pdf.js, plus des zones fixes écrites dans le code
(`{ page, x0, y0, x1, y1 }`) pour les scans.

Les factures d'eau de la SCI sont des scans (Epson Scan 2) : une image par page, sous laquelle le logiciel du scanner
pose le texte qu'il a reconnu, invisible. pdf.js lit ce texte comme un autre, mais il est approximatif
(« HEITANGE GRANDE », « HETTANGE GF`ANDE », « renseignemem complérnentaire ») : un terme masqué ne le trouve pas
toujours, et rien ne le signale. Les zones fixes, elles, s'écrivent en chiffres dans le code, sans les voir : on
devine, on regarde la copie, on corrige. Deux bricolages, sur les documents où se trouvent justement le nom, l'adresse
et le compte bancaire (le TIP SEPA).

Les premières copies faites ont aussi montré que pdf.js 6 décode les images des scans (CCITT, JBIG2) par un module
WebAssembly qu'il charge à l'adresse `wasmUrl` : sans elle, l'image est laissée de côté, sans erreur, et la version
locataire sort blanche.

## Décision

- **Une page scannée se reconnaît seule** (`estScannee`, `pdf.ts`) : une image en couvre au moins 85 % et son texte,
  s'il y en a, est invisible (mode de rendu 3 ou 7). Page par page, sans réglage : une facture EDF scannée à la main
  l'est aussi. La version en images garde la liste de ses pages scannées (`facture_annexe.pages_scannees`).
- **Sur une page scannée, le texte n'est pas cherché** : ni les termes masqués, ni `redactions()`. Seules des zones
  tracées à la main y sont masquées. Une page de texte reste masquée comme dans l'ADR 0024, et les zones tracées s'y
  ajoutent : ce que la recherche ne trouve pas (une image, le QR code d'une facture Veolia).
- **Un modèle de zones par fournisseur** (`fournisseur.zones_masquees`, `[{ page, x0, y0, x1, y1 }]` en fractions de
  la page depuis le coin haut gauche), tracé à la souris sur une de ses factures, sur la page du fournisseur
  (« Zones masquées à la main »). Des données, pas du code : un fournisseur sans extracteur (eau, saisie à la
  main) en a besoin autant qu'un autre.
- **Des zones propres à une facture** (`facture.zones_masquees`, vide : celles du fournisseur), ajustées sur sa version
  locataire (« Il reste une information personnelle : ajuster les zones… ») : un scan décalé, une mention en plus.
  Elles remplacent celles du fournisseur pour cette facture, et sont reprises quand sa version est refaite ; un
  nouveau PDF de la facture les efface (elles étaient tracées pour l'autre). On peut revenir à celles du fournisseur.
- **L'éditeur de zones** (`EditeurZones.vue`) dessine les pages en couleur ; sur une page scannée, glisser trace une
  zone, glisser une zone la déplace, son coin la redimensionne, × ou Suppr la retire ; de même sur une page de texte.
- **Chaque zone peinte dit son origine** dans `facture_annexe.zones` : `termes`, `extracteur`, `modele` (le
  fournisseur) ou `main` (la facture).
- **`redactions()` ne rend plus que du texte** (`{ text }`, `{ pattern }`), pour les pages de texte ; les zones fixes
  disparaissent du contrat (aucun extracteur ne s'en servait). Une zone fixe que rendrait encore une version
  enregistrée est ignorée.
- **pdf.js reçoit `wasmUrl`** : ses décodeurs (JBIG2 et CCITT, JPEG 2000, profils de couleur) sont servis par Vite en
  développement et copiés dans le build, sous `/assets/pdfjs-<version>/` (le serveur garde les fichiers un an). Pas
  l'interpréteur de scripts (quickjs) : les scripts d'un PDF ne sont jamais exécutés.

## Plus tard

- Retirer une zone trouvée à tort par les termes ou l'extracteur.
- Recaler le modèle sur un repère que le scanner lit bien, pour un scan décalé ; pour l'instant, la facture ajuste les
  siennes.

## Conséquences

- Plus de texte reconnu ni de chiffres dans le code pour masquer un scan : ce qui est masqué se voit en le traçant.
- Un nouveau modèle de formulaire du fournisseur (le SEAFF devient le Syndicat Fensch Lorraine en 2027) : des zones à
  tracer de nouveau ; le contrôle de chaque version locataire le montre.
- Changer le modèle ne refait pas les versions : comme après un changement des termes ou de l'extracteur, « Recréer
  les versions locataire », puis les contrôler.
- Migration 024 : `fournisseur.zones_masquees`, `facture.zones_masquees`, `facture_annexe.pages_scannees`.

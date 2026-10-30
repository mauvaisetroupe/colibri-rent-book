# 24. Factures en annexe caviardées et jointes en images

- Statut : Proposé
- Date : 2026-10-30
- Complète l'ADR 0014 (factures jointes au justificatif) et l'ADR 0013 (extracteurs : une méthode de plus, facultative)
- Pour les pages scannées : remplacé par l'ADR 0025 (zones tracées à la main, plus de zones fixes dans le code)

## Contexte

Depuis l'ADR 0014, le PDF d'une régularisation joint les factures prises en compte, telles qu'elles ont été reçues.
Elles portent des données qui ne regardent pas le locataire : nom et adresse personnelle du gérant, références client
et de contrat, point de livraison, compte bancaire du prélèvement (sur le TIP d'une facture d'eau, par exemple).

Pour les premières régularisations envoyées (octobre 2026), ces données ont été masquées une fois, hors de
l'application : un script PyMuPDF cherchait une liste de termes dans le texte des annexes, et masquait des zones à
position fixe sur les scans sans texte. Cela marche, mais c'est à refaire à chaque envoi, hors de l'application, et
rien ne garde ce qui a été envoyé.

Trois façons de masquer ont été regardées :

- **un rectangle noir dessiné par pdf-lib** : le texte reste dessous, on peut le copier ou le retrouver par une
  recherche. Ce n'est pas un caviardage ;
- **retirer le texte de la page** (ou le remplacer par « xxx ») : il faut réécrire le contenu de la page, ce que
  pdf-lib ne sait pas faire. MuPDF le fait (`apply_redactions`), mais son paquet JavaScript (`mupdf`, WASM) est sous
  AGPL-3.0, ou sous licence commerciale. Des « xxx » dans la police de la facture feraient aussi croire à une facture
  modifiée ;
- **remplacer chaque page par une image** où les zones sont peintes en noir : il ne reste rien de l'original sur la
  page (ni texte, ni police, ni objet caché), avec pdf.js et pdf-lib, déjà utilisés. La facture devient comme un scan.

**Essai du 2026-10-30** (factures EDF et ENGIE de l'exploitation, 95 pages ; un justificatif de 63 pages) : en noir et
blanc (seuil 170 sur 255, PNG 1 bit), 150 dpi donne environ 20 Ko par page, 200 dpi environ 31 Ko, contre environ
40 Ko pour les originaux. Les deux sont lisibles ; 100 dpi est crénelé, les petits caractères deviennent difficiles.
Le gris (JPEG ou PNG) n'apporte rien de lisible en plus, et pèse 3 à 7 fois plus.

## Décision

### Les annexes sont des images, le justificatif reste du texte

- Les pages du justificatif et la page « Annexes » (pdfmake, ADR 0014) ne changent pas : c'est notre document, il n'y a
  rien à masquer.
- **Chaque facture jointe l'est dans sa version en images** : toutes ses pages, en noir et blanc, 200 dpi, seuil 170,
  les zones à masquer peintes en noir. Toutes les pages, même celles sans zone : aucun texte de l'original ne part, et
  toutes les annexes se ressemblent.
- **Une facture n'est jamais jointe telle qu'elle a été reçue.** Sans version en images vérifiée, elle est listée
  « Non jointe, consultable sur demande » (le locataire n'a pas à savoir pourquoi). L'écran de la régularisation le
  signale avant l'envoi.
- La page « Annexes » dit que les données personnelles du bailleur ont été masquées et que l'original est consultable
  sur demande (loi du 6 juillet 1989, art. 23, comme les documents confidentiels de l'ADR 0014).

### Ce qu'il faut masquer : l'extracteur du fournisseur, et des termes communs

- **Une méthode facultative `redactions()` sur `InvoiceExtractor`** (ADR 0013), qui rend une liste de choses à
  masquer, sans coordonnées pour le texte :
  - `{ text: '…' }` : chaque occurrence de ce texte, sans tenir compte des espaces ni des majuscules ;
  - `{ pattern: /…/ }` : chaque correspondance de l'expression, ligne par ligne ;
  - ~~`{ page?, x0, y0, x1, y1 }` : une zone fixe~~ : retirée par l'ADR 0025, une page scannée se masque par des zones
    tracées à la main.

  Par défaut, la méthode ne rend rien : les versions existantes ne changent pas, `MOTEUR` reste le même. Masquer de
  nouvelles références, c'est une nouvelle version de l'extracteur.
- **Le moteur retrouve le texte dans les lignes de pdf.js** (`masquage.ts`), regroupées avec les réglages de
  l'extracteur et en gardant les morceaux de chaque ligne (`regroupement.ts`) : rectangle des morceaux couverts, au
  prorata des caractères pour un morceau coupé, de la hauteur du texte avec ses jambages, plus une marge d'un point.
  Un texte coupé sur deux lignes n'est pas trouvé. Une erreur de l'extracteur (zone invalide…) arrête tout : rien
  n'est masqué à moitié.
- **L'éditeur d'extracteur a deux onglets** sur le même code et le même PDF de travail (choisi, avec le regroupement
  en lignes, dans une fenêtre) : « Extraction » (ce qui existait) et « Masquage ». Ce dernier montre en noir, dans le
  texte du PDF, ce que masquent les termes et `redactions()`, pendant la frappe ; un texte sélectionné s'ajoute aux
  termes masqués ; « Ajouter redactions() au code » insère la méthode commentée. Chaque onglet vérifie son travail
  dans une fenêtre : « Vérifier l'extraction… » (toutes les factures du fournisseur relues, le détail du PDF de
  travail), « Vérifier le masquage… » (la copie du PDF de travail, les termes). Un texte fixe va dans les termes, sans
  nouvelle version : le code ne sert qu'aux motifs et aux zones fixes.
- **Les termes communs** (nom et adresse du gérant, compte bancaire de la société) sont dans une table
  `terme_masque`, saisie sur l'écran « Fournisseurs », et cherchés dans toutes les factures. Une table plutôt qu'une
  colonne de `societe` : la société n'est pas forcément saisie. Le dépôt public n'a que le mécanisme ; les termes sont
  des données de l'exploitation.
- **Un fournisseur sans extracteur** (factures reçues sur papier et scannées) peut en avoir un qui ne lit rien
  (numéro, date et total `null`, pas de ligne, ADR 0013) et ne fait que masquer.

### Produite dans le navigateur, stockée à côté de l'original

- **Le front produit la version en images** : pdf.js dessine chaque page à 200 dpi, les zones sont peintes en noir, le
  seuil donne une image 1 bit, et pdf-lib en fait un **nouveau** PDF (rien de l'original n'y est copié, ni les
  métadonnées). Comme les extracteurs (ADR 0013), aucun code saisi n'est exécuté par le serveur.
- L'image est écrite telle quelle (objet image `DeviceGray`, 1 bit par pixel, compressé) : `embedPng` de pdf-lib la
  réécrirait en couleurs, bien plus lourde. pdf-lib passe des dépendances de test à celles du front.
- **Table `facture_annexe`** (migration 023), une ligne par version : `facture_id`, `fichier_pdf`
  (`annexes/<empreinte>.pdf`), `source_pdf` (le PDF de la facture dont elle est faite), `zones jsonb` (les rectangles
  peints : page, fractions, origine), `extracteur_id` (la dernière version de l'extracteur du fournisseur, qui a donné
  les règles ; vide : termes seuls), `termes` (les termes communs du moment), `reglages` (dpi, seuil), `cree_le`,
  `verifiee_le`. Seul `verifiee_le` se renseigne après coup, une fois ; le reste est figé (trigger, comme
  `extracteur`). Les versions d'un brouillon supprimé partent avec lui.
- `facture.annexe_id` désigne la version courante. Une facture validée peut en changer (ADR 0017) : ce n'est pas une
  donnée de calcul. La correction d'une facture garde sa version (même PDF) ; un nouveau PDF la retire : à refaire.
- **État de la copie d'une facture**, calculé : `confidentiel`, `sans_pdf`, `a_faire` (aucune, ou faite depuis un
  autre PDF), `a_verifier`, `verifiee`. Seule une copie vérifiée est jointe.
- **L'original reste la pièce justificative** : `facture.fichier_pdf`, inchangé, lu par les extracteurs, consultable
  sur demande.

### Quand elle est produite et vérifiée

- **À l'import** d'une facture, avec l'extracteur qui la lit.
- **Sur la page d'une facture**, la copie s'appelle « version locataire » (le mot de l'utilisateur) : au-dessus de
  l'aperçu, « Facture reçue » ou « Version locataire (à créer, à contrôler, ✓ contrôlée) ». Affichée, un bandeau dit
  quoi faire : « ✓ Rien de personnel : à joindre », ou « ✗ Il reste une information personnelle… », qui propose de
  recopier le texte (ajouté aux termes masqués, au moins 5 caractères, puis la version est recréée et se contrôle de
  nouveau), d'ouvrir le masquage du fournisseur (éditeur de son extracteur, onglet Masquage) pour un texte qui change
  ou un scan, ou de ne rien faire (la facture n'est pas jointe).
- **Sur la page d'un fournisseur** : « Refaire les copies » de toutes ses factures (après une nouvelle version de son
  extracteur, ou un changement des termes), chacune à vérifier de nouveau ; la liste de celles à vérifier.
- **Sur la page d'une régularisation à envoyer** : les factures dont la copie n'est pas vérifiée, qui ne seront pas
  jointes.

La vérification à l'œil reste nécessaire : un texte que la recherche ne trouve pas (police sans table de caractères,
scan sans texte) n'est pas masqué.

### Ce qui a été envoyé reste ce qui a été envoyé

« Marquer envoyée » note, pour chaque facture jointe, la version de sa copie (`regularisation.annexes_envoyees`,
`{ "<facture_id>": <annexe_id> }`) : un justificatif reconstruit plus tard joint les mêmes images, même si la copie a été
refaite depuis ; une facture absente n'était pas jointe et ne l'est toujours pas. Annuler l'envoi l'efface. Pour les
régularisations envoyées avant cet ADR (`NULL`), les copies vérifiées du moment sont jointes. L'instantané (ADR 0007)
ne change pas : il est figé à la création du brouillon, avant que les copies soient vérifiées.

## Plus tard : des zones tracées à la main

Fait pour les pages scannées par l'ADR 0025 (modèle du fournisseur, ajusté par facture).

Sur l'aperçu d'une facture, tracer un rectangle à la souris (un scan isolé sans texte, un oubli vu à la vérification),
ou retirer une zone trouvée par l'extracteur qui masque à tort une information utile. Pour y venir sans rien changer :

- chaque zone de `facture_annexe.zones` porte son **origine** (`extracteur`, `termes`, plus tard `main`), en fractions de
  la page ;
- quand une annexe est refaite, les zones tracées à la main (et les zones retirées) de la version précédente sont
  reprises dans la nouvelle, qui se vérifie comme les autres.

Une zone tracée à la main ne vaut que pour sa facture : un emplacement qui revient sur toutes les factures d'un
fournisseur (le TIP d'une facture d'eau) va dans son extracteur.

## Conséquences

- Plus de script hors de l'application avant un envoi ; ce qui part chez le locataire est gardé et retrouvable.
- Les annexes ne sont plus du texte : on ne peut plus y sélectionner ni y rechercher. Elles restent légères (environ
  1 Mo pour dix factures de trois pages).
- Une étape de plus avant l'envoi : vérifier l'annexe de chaque facture, une fois.
- Pas de dépendance nouvelle (pdf.js et pdf-lib sont déjà là) ; MuPDF reste possible plus tard si l'on veut garder le
  texte des annexes, avec la question de sa licence.
- Tests de l'exploitation, sur ses vraies factures : chaque occurrence des termes dans le texte de pdf.js est couverte
  par une zone ; la version en images ne contient aucun texte.
- À mettre à jour une fois accepté : SPEC § 8, `CLAUDE.md`, l'aide de l'éditeur d'extracteurs.

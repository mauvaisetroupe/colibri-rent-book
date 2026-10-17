# 13. Extracteurs de factures éditables, versionnés, sur pdf.js

- Statut : Accepté
- Date : 2026-10-17
- Remplace l'ADR 0004 (lecteurs par colonnes sur `pdftotext -bbox-layout`) ; modifie la SPEC § 6 (pipeline d'import,
  format d'une ligne, contrôles sur les kWh) : à mettre à jour une fois l'ADR accepté

## Contexte

Les lecteurs EDF et ENGIE (`backend/src/invoices/edf.ts`, `engie.ts`, ADR 0004) ont permis de mettre l'application en
service vite. Mais ils sont écrits dans le code de l'application :

- l'eau, la taxe foncière (TEOM) ou un nouveau fournisseur de gaz n'ont pas de lecteur, et se saisissent à la main ;
- changer de fournisseur, ou une nouvelle mise en page, demande de modifier le code, de le tester et de redéployer ;
- ils lisent par position des colonnes, en points PDF, ce qui est difficile à comprendre et à ajuster ;
- ils dépendent de poppler, dont la sortie change d'une version à l'autre (ADR 0004, `CLAUDE.md`).

Pourtant, il faut toujours la même chose : **le numéro, la date, le total, et une liste de lignes avec un libellé, une
date de début, une date de fin et un montant.** Les kWh, le HT et la TVA lus aujourd'hui ne servent à aucun calcul : la
répartition (`repartition` dans `schema.sql`) n'utilise que le montant, la période et `recuperable`.

**Essai du 2026-10-17** (`experiments/lecteurs-regex/`, non versionné) : pdf.js, un regroupement des morceaux de texte
en lignes, et un lecteur par fournisseur en expressions régulières. Résultat : les 24 fixtures donnent les mêmes
numéros, dates, totaux, périodes et montants que les lecteurs actuels ; un avis de taxe foncière (TEOM par adresse) a
été lu en quelques minutes. Taille des lecteurs : EDF une quinzaine de lignes, ENGIE une quarantaine (libellés sur
plusieurs lignes, périodes manquantes, pénalités), taxe foncière une vingtaine.

Un outil existant fait déjà ce travail sur ce principe (invoice2data, Python : un modèle par fournisseur, une
expression par champ, une expression de ligne entre un début et une fin). Les outils de sélection par zone (Tabula) ne
lisent que des tableaux ; les services d'extraction (Docparser, Mindee, Azure…) sont externes et payants, exclus
(« tout est local »).

## Décision

### Extraction du texte : pdf.js, à la place de poppler

- `pdfjs-dist`, à version figée par le `package-lock`, dans le navigateur (et dans Node pour les tests). Le Mac, la machine et
  l'éditeur lisent exactement la même chose ; poppler disparaît de l'image et de la machine.
- pdf.js donne des **morceaux de texte** avec leur position (x, y de la ligne de base, largeur). Le **regroupement**
  les range en lignes : tri de haut en bas, même ligne si les hauteurs diffèrent d'au plus `toleranceHauteur`, tri de
  gauche à droite, morceaux collés si l'écart est sous `collage`, séparés par une espace, ou par trois espaces au-delà
  de `colonne` (changement de colonne). Réglages de l'essai : 2, 0,8 et 15 points.

### Un extracteur = une classe, une méthode par étape (modifié le 2026-10-17)

```
morceaux pdf.js ─▶ regroupement (réglages) ─▶ texte en lignes ─▶ new Extracteur(doc)
   ─▶ recognizes · invoiceNumber · invoiceDate · total
   ─▶ linesZone ─▶ findLine (chaque ligne) ─▶ readLine (chaque ligne trouvée) ─▶ after ─▶ brouillon + contrôles
```

- **Le regroupement** : les trois réglages, enregistrés avec l'extracteur ; une fonction de regroupement propre à un
  extracteur reste possible plus tard.
- **Une classe qui étend `InvoiceExtractor`** (module `'extractor'`), écrite **en anglais** comme tout le code : une
  instance par PDF, le texte dans `this.doc` (`text`, `lines`, `pages`). Méthodes abstraites : `recognizes()`,
  `invoiceNumber()`, `invoiceDate()`, `total()` (null : absent du PDF, à saisir), `findLine(line, context)` (est-ce une
  ligne de facture ? sa correspondance), `readLine(match, context)` (la ligne lue : `category`, `label`, `start`,
  `end`, `amount`, `allocation?`, `note?`, ou plusieurs). Par défaut : `linesZone()` (tout le texte), `after()`. Le
  contexte d'une ligne donne ses voisines (libellés imprimés au-dessus et en dessous, ENGIE) et toutes les lignes de
  la zone (cotisations trois lignes plus bas, taxe foncière). Les valeurs des catégories et des affectations restent
  celles de la base (`'consommation'`, `'recuperable'`…).
- **Chaque ligne trouvée est lue à part** : une erreur dans `readLine` marque cette ligne (en rouge dans l'éditeur,
  avec le message) et les autres sont lues ; une facture dont une ligne trouvée n'est pas lue est refusée à l'import.
  Une seule fonction `lignes`, essayée d'abord, s'arrêtait à la première erreur et cachait si l'expression régulière
  était juste.
- **Aides**, méthodes protégées de la classe : `capture`, `amount`, `withVat` (EDF n'imprime pas de TTC par ligne),
  `sum`, `frenchDate`, `startFromEnd` (année de début absente), `between`, `classify` ; motifs `AMOUNT` et `DATE` et
  `rx` pour écrire une expression sans doubler les « \ ». Montants en chaînes décimales (big.js), jamais en `number`.
  Messages d'erreur explicites (« withVat : taux de TVA vide »).
- **Fait par l'application, pas par l'extracteur** : période manquante = période de consommation de la facture, avec
  la note « période à confirmer » (R6) ; pénalité à la charge du propriétaire et datée de la facture ; contrôles.
- **La classe de base ne casse jamais une version enregistrée** : une version s'exécute avec la classe
  `InvoiceExtractor` du moment. On peut y ajouter des aides ; en retirer ou en changer une casse les versions qui
  l'appellent (vu en DEV le 2026-10-17 avec `classify`, retirée) : garder l'ancienne, ou relever `MOTEUR` et écrire de
  nouvelles versions.
- **Surlignage** : pendant la lecture de chaque champ, le moteur note les correspondances des expressions régulières ;
  l'éditeur les replace dans le texte (une couleur par champ).

### Un champ introuvable se saisit à la main

Un extracteur peut ne pas trouver, ou ne pas chercher, une information : il la rend vide (`null`). Le brouillon
s'ouvre quand même, le champ vide est signalé, et l'utilisateur le saisit ; de même, il peut ajouter une ligne que
l'extracteur ne lit pas. La validation reste bloquée tant que le numéro, la date ou le total manquent. Exemple : la
taxe foncière arrive en deux PDF, le détail des cotisations par adresse et l'avis principal, qui porte le total
(1 908 € en 2023, dont 1 829 € de cotisations et 79 € de frais). La facture ne garde qu'un PDF, le détail : les lignes
en sont lues, le total et les frais se saisissent à la main. Pas de facture en plusieurs PDF.

### Affectation d'une ligne : récupérable, propriétaire, hors immeuble

Le booléen `recuperable` devient une **affectation** à trois valeurs (décision du 2026-10-17) :

| Affectation | Répartie entre les locataires | Synthèse fiscale de l'immeuble | Somme des lignes = total |
|---|---|---|---|
| `recuperable` | oui | non | comptée |
| `proprietaire` (pénalités, taxe foncière hors TEOM…) | non | listée | comptée |
| `hors_immeuble` (concerne un autre bien) | non | non | comptée |

Aujourd'hui, une ligne non récupérable apparaît dans la synthèse fiscale comme une charge du propriétaire de
l'immeuble (`fiscal.ts`) : les taxes d'autres biens portés sur le même avis (des garages) y seraient à tort. Exemple
d'un avis : adresse de l'immeuble, TEOM `recuperable` et taxe foncière hors TEOM `proprietaire` ; adresses des garages,
`hors_immeuble` ; frais de gestion, saisis à la
main, affectation à décider (frais de gestion de la TEOM réputés non récupérables : à confirmer avec
l'expert-comptable). Une seule valeur plutôt que deux booléens (`recuperable`, `exclue`) : pas de combinaison absurde.

Migration de `ligne_facture.recuperable` vers `affectation` (`true` → `recuperable`, `false` → `proprietaire`) ;
`repartition` et `statements.ts` filtrent sur `recuperable`, `fiscal.ts` sur `proprietaire` ; contrôle : une pénalité
est `proprietaire` ; colonne de la grille. `repartition.test.ts` doit rester vert. Indépendant des extracteurs : une
étape à part.

### Code saisi en TypeScript (décision du 2026-10-17)

- L'extracteur s'écrit en **TypeScript**, dans l'éditeur Monaco (celui de VS Code), qui embarque le service
  TypeScript : il connaît la classe de base et ses aides (module `'extractor'`) et souligne les erreurs pendant la
  frappe (champ mal nommé, catégorie inconnue, ligne sans `debut`), et propose les aides avec leur description. Les
  types se déduisent du contrat : un extracteur ne porte presque pas d'annotations.
- Le même service produit le JavaScript exécuté : pas de bibliothèque de plus pour la transpilation.
- Chaque version enregistre la **source TypeScript** (celle qu'on édite) et le **JavaScript produit** (celui qui
  s'exécute), figés tous les deux : une version exécute toujours le même code, même après une mise à jour de
  TypeScript ou de Monaco.

### Énergie et catégorie

L'énergie (gaz, électricité, eau, ordures ménagères) est une propriété de l'extracteur : elle est connue en
l'écrivant.

La **catégorie** de chaque ligne (consommation, abonnement, taxe, prestation, pénalité, autre) est gardée (décision du
2026-10-17). Elle ne change aucun montant, mais le décompte et le justificatif détaillent les charges comme la facture
(consommation, abonnement, taxes), ce qui est plus clair et moins contestable pour un locataire qui demande à voir les
factures ; elle sert aussi au contrôle de contiguïté des consommations. L'extracteur la donne pour chaque ligne,
d'après le libellé (table « le libellé commence par… → catégorie, libellé normalisé », comme les lecteurs actuels) ;
en saisie à la main (eau, reçue sur papier), elle se choisit dans la grille, comme aujourd'hui.

### Enregistrés en base, versionnés, jamais modifiés

- Table `extracteur` : `fournisseur` (« ENGIE »), `version` (1, 2, 3…, unique par fournisseur), `energie`,
  `regroupement` (**toujours écrit, même quand ce sont les valeurs par défaut** : changer un jour les valeurs par défaut
  ne doit rien changer aux extracteurs existants), `source` (TypeScript) et `code` (JavaScript produit), `moteur`
  (version du contrat : pdf.js, regroupement, classe de base), date de création, note (« v3 : nouvelle mise en page de mars 2027 »).
- **Rien n'est modifié ni supprimé** : corriger un extracteur, c'est créer la version suivante. La base l'impose
  (trigger refusant `UPDATE` et `DELETE`), comme pour les régularisations figées (ADR 0007).
- `facture.extracteur_id` : la version exacte qui a lu la facture (vide pour une saisie à la main).
- À l'import, la dernière version de chaque fournisseur est essayée ; si plusieurs `recognizes` répondent oui,
  l'utilisateur choisit ; si aucun, saisie à la main comme aujourd'hui.
- Une facture déjà lue ne change pas quand une nouvelle version arrive. La relire avec la nouvelle version crée un
  nouveau brouillon ; une facture validée n'est jamais modifiée silencieusement.

### Exécution dans le navigateur seulement (décision du 2026-10-17)

- Le code d'un extracteur ne s'exécute **que dans le navigateur** : à l'import, le navigateur lit le PDF avec pdf.js,
  applique l'extracteur et envoie à l'API le PDF, le brouillon (numéro, date, total, lignes) et `extracteur_id`. L'API
  archive le PDF, enregistre le brouillon et fait les contrôles, comme aujourd'hui pour une saisie à la main ou un
  collage.
- **Le serveur n'exécute jamais de code saisi.** Le code saisi tourne dans la page de celui qui l'a écrit, avec les
  mêmes droits que lui sur l'API. Aujourd'hui l'application est sur le réseau local seulement ; le jour où elle s'ouvre
  par Cloudflare, il faudra l'authentification (ADR 0011), et l'écran « Extracteurs » sera réservé à un rôle
  administrateur.
- Le moteur (pdf.js, regroupement, classe de base) est un module JavaScript sans dépendance au navigateur : les tests
  d'intégration (ADR 0012) l'utilisent dans Node pour lire les PDF avant d'appeler l'API, avec des extracteurs connus.
- Un traitement par lot côté serveur (relire toutes les factures, import automatique) n'est pas prévu ; il s'ajoutera
  si le besoin apparaît.

### L'écran « Extracteurs » (partie administration)

- Liste des fournisseurs et de leurs versions ; une nouvelle version part de la précédente, un nouveau fournisseur
  d'un modèle commenté.
- Éditeur à trois zones : le **texte du PDF d'exemple ligne par ligne** (après regroupement, mis à jour quand on change
  un réglage), le **code** de chaque fonction, et le **résultat en direct** : chaque champ avec sa valeur ou son erreur
  (« total : 316,18 € ✔ », « numéro : introuvable ✖ »), le tableau des lignes, la somme comparée au total.
- **Non-régression avec les factures déjà en base** : avant d'enregistrer une version, le navigateur la relance sur
  les PDF des factures de ce fournisseur (téléchargés depuis l'API), et l'écran montre les écarts avec ce qui avait été validé (« 23 identiques,
  1 différente : ligne 4, 22,88 € au lieu de 22,90 € »). Les factures réelles servent de tests, dans l'application.
- Plus tard, une aide : cliquer sur un montant ou une date dans l'aperçu du PDF propose l'expression qui le capture.

### Contrôles (SPEC § 6)

Conservés : somme des lignes = total (tolérance 0,05 €), périodes dans la plage de la facture, période attribuée par
défaut signalée, pénalité à la charge du propriétaire, consommations contiguës. Le total seul ne suffit toujours pas : un libellé
mal lu peut donner une mauvaise période avec un montant juste. Supprimé : « somme des kWh = total imprimé » (les kWh ne
sont plus lus). `kwh`, `montant_ht` et `taux_tva` restent des colonnes facultatives (factures déjà en base, saisie à la
main).

## Conséquences

- Un nouveau fournisseur, l'eau, la taxe foncière : un extracteur écrit dans l'application, sans toucher au logiciel ni
  le redéployer.
- Les extracteurs sont des **données** de l'exploitation (en base, sauvegardés avec elle), pas du code du logiciel :
  cohérent avec la séparation de l'ADR 0012. Le logiciel ne livre que le moteur, la classe de base et des modèles ; les
  extracteurs EDF et ENGIE actuels sont réécrits une fois et chargés dans la base de la SCI.
- `backend/src/invoices/` (lecteurs par colonnes, `pdfWords.ts`, `layout.ts`) et `parsers/reference/` disparaissent
  après la bascule ; poppler aussi, avec l'étape `test` de l'image qui surveillait sa version.
- Les tests des 24 fixtures restent le critère de la bascule : les extracteurs réécrits doivent redonner les mêmes
  factures que les lecteurs actuels.
- Le code d'un extracteur est saisi dans l'interface et exécuté dans le navigateur seulement : le serveur reste sans
  code saisi. En contrepartie, l'API d'import reçoit un brouillon déjà lu, et non plus un PDF à lire
  (`POST /api/factures/import` change, ADR 0005).
- SPEC § 6, `CLAUDE.md` (lecteurs, poppler), `STATUS.md` et l'accueil (mode d'emploi du nouvel écran) à mettre à jour.

## Mise en œuvre (ordre)

1. Affectation à trois valeurs (migration, moteur, synthèse fiscale, grille), avant les extracteurs.
2. Contrat d'un extracteur (classe de base, aides, regroupement) et moteur en module JavaScript (navigateur et Node), avec
   pdf.js ; extracteurs EDF et ENGIE réécrits ; les 24 fixtures redonnent les factures attendues (critère de l'ADR 0004 repris).
3. Table `extracteur` (migration), `facture.extracteur_id` ; import dans le navigateur par la dernière version de
   chaque fournisseur, l'API recevant le PDF et le brouillon.
4. Écran « Extracteurs » : liste, versions, éditeur en direct sur un PDF d'exemple.
5. Non-régression sur les factures en base avant d'enregistrer une version.
6. Extracteur de la taxe foncière (détail des cotisations par adresse, total et frais saisis à la main) ; eau (SEAFF)
   quand des PDF seront disponibles, en saisie à la main d'ici là.
7. Retrait des lecteurs par colonnes, de poppler et des lecteurs Python de référence.

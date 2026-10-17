# 5. Import et édition des factures

- Statut : Accepté
- Date : 2026-10-12

## Contexte

L'étape 1c relie les lecteurs (ADR 0004) à l'interface : import d'un PDF, grille éditable, contrôles en direct,
validation (ADR 0003). L'ADR 0002 laissait ouvert le partage du code des contrôles entre `backend/` et `frontend/`,
deux paquets npm indépendants.

## Décision

- **Contrôles en direct par l'API** : la grille envoie l'en-tête et les lignes en cours d'édition à
  `POST /api/controle` (250 ms après la dernière frappe ; une réponse plus ancienne arrivée en retard est ignorée).
  `checks.ts` n'existe qu'au serveur : pas de code partagé entre les paquets, une seule vérité. Le front ne fait
  aucun calcul sur les montants ; la somme et l'écart affichés viennent du serveur.
- **Ce qui est saisi est envoyé tel quel** : le front convertit l'affichage (dates jj/mm/aaaa, virgule, TVA en %) vers
  le format de l'API dans `frontend/src/format.ts`, et envoie le texte brut quand il ne sait pas le lire. Les contrôles
  le signalent comme **erreur de saisie** (date, nombre, catégorie invalide, libellé vide).
- **Trois niveaux** : une erreur de saisie empêche d'enregistrer le brouillon (la base ne pourrait pas le stocker) ;
  toute erreur (y compris l'écart sur le total) empêche la validation ; un avertissement est affiché sans bloquer.
  Le serveur rejoue les contrôles à l'enregistrement et à la validation.
- **Import** (`POST /api/factures/import?immeuble=…`) : le PDF est archivé sous le nom de son empreinte SHA-256 dans
  `STORAGE_DIR` (par défaut `backend/storage/pdf`, hors git) ; la facture est créée en brouillon avec les lignes lues.
  Une facture déjà connue (même fournisseur, même numéro) est refusée (409) avec le lien vers l'existante. Un
  fournisseur non reconnu ou un PDF illisible est refusé (422, `code: 'saisie_manuelle'`) : l'écran propose alors
  de la saisir à la main avec ce PDF.
- **Saisie manuelle** (2026-10-13, `POST /api/factures?immeuble=…`) : fournisseur (créé s'il est nouveau),
  énergie, numéro, date, total imprimé, note, et éventuellement un PDF (multipart) qu'aucun lecteur ne lit ; un PDF
  lu par un lecteur est refusé (il faut l'importer). Le brouillon naît sans ligne et s'édite dans la même grille,
  avec les mêmes contrôles et la même validation qu'une facture importée. La note de la facture (provenance d'un
  montant, PDF manquant…) se modifie avec l'en-tête.
- **Une facture validée n'est plus modifiable ni supprimable** (409). Un brouillon peut être supprimé, son PDF aussi
  s'il ne sert plus. En attendant la décision sur la correction d'une facture validée (point ouvert de l'ADR 0003).
- **Grille** : RevoGrid, toutes les cellules en texte ; collage de plages depuis Excel ou le PDF ; lignes en erreur
  surlignées en rouge, en avertissement en jaune ; liste des constats sous la grille ; aperçu du PDF à côté
  (lecteur PDF du navigateur).

## Conséquences

- Un aller-retour réseau par modification : négligeable sur le réseau local, à surveiller derrière Cloudflare.
- Les types de l'API sont recopiés dans `frontend/src/api.ts` : à tenir alignés sur `backend/src/invoices/types.ts`
  et `checks.ts`.
- Test de bout en bout (`backend/src/routes/factures.test.ts`) : les PDF des fixtures (24 depuis le 2026-10-13) importés puis validés redonnent
  `tests/golden.json` au centime.
- Sur la base de développement, les fixtures sont déjà présentes (seed) : les importer donne « déjà importée ».

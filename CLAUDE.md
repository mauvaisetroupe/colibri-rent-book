# CLAUDE.md – colibri-rent-book, gestion des charges locatives

Logiciel seul : aucune donnée réelle dans ce dépôt (public). Les données d'une exploitation (immeubles, factures,
fixtures, décomptes attendus), sa composition de production et ses scripts sont dans son propre dépôt (pour la
première : `colibri`, privé), qui fixe la version de l'image et lance les tests sur ses données. Lire `docs/SPEC.md`
(règles métier R1 à R11, à ne pas changer sans l'accord du propriétaire) et `docs/adr/` avant toute tâche.

## Pile

- Serveur : Fastify + TypeScript, PostgreSQL ≥ 14 (extension `btree_gist`), SQL brut via `pg` (sans ORM), ESM
- Client : Vue 3 + TypeScript, grille `@revolist/vue3-datagrid`
- Factures lues **dans le navigateur** par des extracteurs (ADR 0013) : pdf.js (version figée par le `package-lock` du
  front), une classe TypeScript par fournisseur qui étend `InvoiceExtractor` (module `'extractor'`), saisie dans
  l'éditeur (écran « Fournisseurs »), enregistrée en base par version et jamais modifiée ; le serveur n'exécute jamais
  ce code
- Justificatifs PDF : pdfmake (police Roboto embarquée), factures jointes en annexe par pdf-lib, sauf celles d'un
  fournisseur confidentiel (ADR 0014) ; pas de navigateur côté serveur
- Image : `Dockerfile`, publiée par la CI sur GHCR à chaque push sur `main` (étiquette = commit court, et `latest`)
- `backend/` et `frontend/` en paquets npm indépendants ; `schema.sql` complet + `migrations/NNN_*.sql` appliquées à
  la main ; ADR dans `docs/adr/` ; Conventional Commits ; pas de Prettier (pas de point-virgule, guillemets simples)
- Langue : code, commentaires et commits en anglais ; noms SQL du domaine, interface et documentation en français ;
  le code des extracteurs (classe de base, aides) est en anglais, les valeurs stockées en base restent en français
- Git : l'utilisateur fait lui-même les commandes git ; proposer les `git add` / `git commit`, ne jamais les lancer

## Ce qui existe

- `backend/src/` : `app.ts` (routes), `routes/` (factures, contrôle, extracteurs, fournisseurs, immeubles, séjours,
  décompte, régularisations, paiements, fiscal, santé), `statements.ts` (lectures SQL du décompte), `justificatif.ts`
  (données) et `justificatifPdf.ts` (PDF), `mails.ts`, `fiscal.ts`, `periods.ts` (**seule** conversion `daterange` ↔
  dates incluses), `invoices/checks.ts` (contrôles du § 6, sans dépendance à Node), `pdfStorage.ts` (PDF par empreinte).
  Le moteur de répartition est en SQL (`repartition`, `decompte`, `synthese`) : ne pas le réimplémenter en TypeScript.
- `backend/seed/extracteurs.sql` : extracteurs livrés (EDF, ENGIE), généré par `npm run extracteurs:sql` dans
  `frontend/` depuis `frontend/src/extraction/modeles/` ; rejouable (une source déjà en base n'est pas ajoutée).
- `frontend/src/` : `api.ts` (client et types), `format.ts` (seule conversion affichage ↔ API), un écran par fichier
  dans `views/`, `extraction/` (`extractor.ts` = classe de base et aides, vue par le code des extracteurs ;
  regroupement des morceaux pdf.js en lignes, moteur, surlignage, éditeur Monaco, test sur les factures en base).
  Navigation calquée sur le cycle d'un exercice ; tout nouvel écran ou changement de processus met à jour l'accueil
  (`AccueilView.vue`) et son mode d'emploi.

## Règles de travail

- Montants : `numeric` en base, jamais de `number` flottant pour stocker ou additionner de l'argent côté TS (chaînes
  ou big.js, arrondi à l'affichage seulement).
- Périodes : `daterange` semi-ouvert en base ; l'API et l'interface parlent en dates **incluses**.
- Une facture n'est jamais modifiée silencieusement : l'utilisateur valide les lignes (`a_verifier` → `validee`).
- Les contrôles de facture du § 6 de la SPEC sont obligatoires (le total seul ne suffit pas).
- **Tout est local** : aucun appel à une API de LLM ni à un service externe payant.
- Les versions d'extracteurs enregistrées tournent avec la classe `InvoiceExtractor` du moment : y ajouter des aides,
  jamais en retirer ni en changer une sans garder l'ancienne ; un changement du moteur qui change ce que lit un
  extracteur existant relève `MOTEUR` (`extraction/contrat.ts`).
- Aucune donnée réelle dans ce dépôt (public) : ni nom de locataire, ni adresse, ni facture ; les tests sur données
  réelles appartiennent à l'exploitation. Tests avec le lanceur de Node (`tsx --test`), pas Vitest.
- Interface et messages en français.

## Commandes

```bash
cd backend && cp .env.local.example .env.local      # une fois
cd backend && npm run db:local && npm run dev       # base Docker de DEV (port 55443, Adminer :8090), API sur :3000
cd backend && npm run db:up && npm run test:local   # base de test jetable (port 55442) : schéma seul, sauf TEST_SEED_FILES
cd backend && npx tsc --noEmit                      # types
cd frontend && npm run dev                          # Vite sur :5173, /api relayé vers 127.0.0.1:3000
cd frontend && npm run build                        # vue-tsc + vite build
cd frontend && npm test                             # moteur d'extraction sur une facture fictive
cd frontend && npm run extracteurs:sql              # backend/seed/extracteurs.sql depuis les modèles
docker build -t colibri-rent-book .                 # l'image, comme la CI
```

Les tests n'utilisent que `TEST_DATABASE_URL` et refusent une base dont le nom ne finit pas par `_test` : ils
suppriment et recréent tout le schéma. `TEST_SEED_FILES` (chemins séparés par « : ») charge les données d'une
exploitation après le schéma.

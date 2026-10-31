# 26. Migrations par Flyway dans une image à part, et des versions

- Statut : Accepté
- Date : 2026-10-31
- Remplace, dans l'ADR 0002 : « `backend/schema.sql` complet et à jour, plus `backend/migrations/NNN_*.sql`
  appliquées à la main » ; l'image étiquetée par commit seulement, avec `latest` ; dans les ADR 0013 et 0018, les
  extracteurs livrés avec le logiciel (EDF, ENGIE, Crédit Mutuel)

## Contexte

Le schéma vit en deux exemplaires : `schema.sql`, complet, pour une base neuve (tests, développement), et 25
migrations `NNN_*.sql` pour une base existante, appliquées à la main avec `psql` après une sauvegarde. Rien ne dit
quelles migrations une base a reçues : le script de déploiement de l'exploitation compare les fichiers de l'ancienne et
de la nouvelle image, s'arrête, affiche les commandes à copier, puis repart avec `MIGRATIONS_APPLIQUEES=1`. Les
extracteurs livrés (`seed/extracteurs.sql`, compilé depuis des fichiers du dépôt) se rechargent à chaque déploiement.
Or un extracteur est une donnée : il est enregistré en base, par version, et se saisit dans l'éditeur de
l'application. Les fichiers ne servent plus qu'aux tests sur les vraies factures, qui sont ceux de l'exploitation.

L'exploitation passe sur un hébergement commun à plusieurs applications, dont le contrat demande une image versionnée,
une image de migration Flyway publiée avec les mêmes tags, et une application qui refuse de démarrer si le schéma
n'est pas à jour. Step Challenge suit déjà ce contrat.

## Décision

- **Flyway**, dans une **image de migration** (`backend/migrations/Dockerfile` : `flyway/flyway` à version figée et
  les SQL du dépôt), publiée avec l'image de l'API sous les mêmes tags. Elle applique ce qui manque, puis s'arrête ;
  l'exploitation la lance avant l'API.
- **Les migrations précédentes sont oubliées.** Le schéma actuel (celui de `schema.sql`, identique à celui des
  migrations 001 à 025, vérifié) devient la première migration, `V001__schema.sql` ; `schema.sql` et les 25 fichiers
  disparaissent. Une base existante, au schéma de la 025, est reprise une seule fois par une **ligne de base à la
  version 1** (`FLYWAY_BASELINE_ON_MIGRATE=true`, `FLYWAY_BASELINE_VERSION=1`) : Flyway note la version 1 sans rien
  exécuter. Les migrations suivantes : `V002__…`, sans `BEGIN`/`COMMIT` (Flyway met chacune dans une transaction).
- **Aucun extracteur n'est livré** avec le logiciel : ils sont en base, la base est la référence, une nouvelle version
  se saisit dans l'éditeur. Le logiciel garde le moteur et les modèles de départ de l'éditeur (`modele.ts`,
  `modele-releve.ts`). Les extracteurs d'EDF, ENGIE et du Crédit Mutuel vont dans le dépôt de l'exploitation de la SCI,
  avec ses tests sur les vraies factures ; le générateur (`npm run extracteurs:sql`) reste, pour qu'une exploitation
  charge les siens dans une base de développement ou de test.
- **L'API vérifie la version du schéma** au démarrage (`schemaVersion.ts`) : la plus haute migration `V`/`B` du dépôt,
  comparée à l'historique de Flyway (`flyway_schema_history`). Base sans historique, plus ancienne, ou avec une migration
  en échec : refus de démarrer **en production** (`NODE_ENV=production`, posé par l'image) ; un avertissement en
  développement, où la base est souvent faite avec `psql` (tests, scripts de l'exploitation). Une base plus récente est
  acceptée avec un avertissement (retour à l'image précédente après une migration compatible).
- **Des versions** : un tag git `vX.Y.Z` publie les images `X.Y.Z` et `X.Y`, et une GitHub Release dont les notes sont
  écrites par la CI depuis git (`.github/release-notes.sh`), rien à la main : d'abord ce que l'exploitant doit lire
  avant de déployer, les commits marqués comme tels en Conventional Commits (`feat!: …`, ou une ligne
  `BREAKING CHANGE: …`) ; puis les migrations nouvelles ; puis les commits depuis la version précédente. La release
  échoue si une migration d'une version publiée a été modifiée ou supprimée. Chaque commit de `main` garde son image
  (commit court), pour essayer. Plus de `latest`.
- La documentation de l'exploitant : `docs/exploitation.md` ; une composition d'exemple : `compose.example.yml`.

## Conséquences

- ✅ Une base sait où elle en est ; le déploiement lance l'image de migration, sans commandes à copier.
- ✅ Un seul exemplaire du schéma : les tests et la base de développement appliquent les migrations dans l'ordre
  (`test/database.ts`, l'image de migration pour `npm run db:local`).
- ✅ Le déploiement ne recharge plus d'extracteurs : la base est la seule référence.
- ❌ Une installation neuve démarre sans extracteur : on les écrit dans l'éditeur, à partir du modèle.
- ❌ L'historique du schéma avant la version 1 n'est plus que dans git (les commits avant cet ADR).
- ❌ Une base de développement existante, sans historique de Flyway, est refusée par `npm run db:local` :
  `npm run db:local:reset` (les comptes sont gardés), ou une ligne de base (`migrations/README.md`).
- ❌ Un changement qui demande une action sur le serveur (une variable, une version de PostgreSQL, une migration sans
  retour en arrière) doit être marqué `!` dans son commit, qui dit quoi faire : sinon les notes ne le signalent pas.

# Migrations

Le schéma de la base est créé et mis à jour par **Flyway**, dans l'image de migration construite par le
[`Dockerfile`](Dockerfile) de ce dossier ([ADR 0026](../../docs/adr/0026-migrations-flyway-et-versions.md)). Elle
s'exécute avant l'API, applique ce qui manque, puis s'arrête ; l'API vérifie à son démarrage que la base a atteint la
dernière version de ce dossier.

| Fichier | Rôle |
|---|---|
| `V<NNN>__<description>.sql` | Migration versionnée, appliquée une fois, dans l'ordre des numéros |

`V001__schema.sql` est le schéma complet, tel qu'il était après les anciennes migrations 001 à 025, appliquées à la main
avant Flyway (elles sont dans l'historique git). Une base de cette époque se reprend par une ligne de base à la
version 1 ([`docs/exploitation.md`](../../docs/exploitation.md)).

## Écrire une migration

1. Un nouveau fichier `V<numéro suivant>__<description>.sql` (par exemple `V002__lease_index.sql`), **sans** `BEGIN;`
   ni `COMMIT;` : Flyway exécute chaque migration dans une transaction.
2. **Ne jamais modifier** un fichier déjà appliqué quelque part, `V001` compris : Flyway compare leurs sommes de
   contrôle et refuse de migrer si l'une a changé.
3. Compatible avec la version précédente de l'API quand c'est possible (colonne ajoutée plutôt que renommée), pour
   qu'un retour à l'image précédente reste possible.
4. Si elle est lourde ou empêche le retour en arrière : `!` dans le commit (`feat!: …`), qui le dit ; les notes de la
   version le mettent en tête. Les migrations nouvelles y sont listées d'elles-mêmes.
5. Les tests l'appliquent d'eux-mêmes (`test/database.ts`) ; `npm run db:local` l'applique à la base de développement.

## Une base de développement d'avant Flyway

Une base créée par l'ancien `schema.sql` n'a pas d'historique : Flyway la refuse (« Found non-empty schema(s) … but no
schema history table »). La recréer (`npm run db:local:reset`, les comptes sont gardés), ou noter une fois qu'elle est
à la version 1 :

```bash
docker compose -f docker-compose.dev.yml run --rm --build \
  -e FLYWAY_BASELINE_ON_MIGRATE=true -e FLYWAY_BASELINE_VERSION=1 dev-migrations
```

## Historique

| Migration | ADR | Contenu |
|---|---|---|
| `V001__schema.sql` | 0026 | Schéma complet après les anciennes migrations 001 à 025 (ADR 0002 à 0025) |

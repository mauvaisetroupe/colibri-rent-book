# 2. Architecture et environnements

- Statut : Accepté
- Date : 2026-10-12

## Contexte

Colibri est une application personnelle, pour un seul utilisateur, utilisée quelques fois par an. Le propriétaire
maintient déjà d'autres applications (Fastify, PostgreSQL, Vue) et déploie sur un serveur personnel par git,
sans Docker. Le kit de départ fournit le schéma, le moteur de répartition en SQL, des lecteurs de factures de référence
en Python et leurs fixtures.

## Décision

**Composants**

```
Navigateur (Vue 3) ──▶ Nginx
                         ├─ /      → frontend/dist
                         └─ /api   → Fastify (TypeScript)
                                      ├─ pdftotext -bbox-layout   (lecture des factures)
                                      ├─ Playwright                (PDF justificatifs, phase 3)
                                      ├─ dossier des PDF archivés
                                      └─ PostgreSQL : schéma + fonctions repartition / decompte / synthese
```

- `backend/` et `frontend/` sont deux paquets npm indépendants. SQL écrit à la main avec `pg`, sans ORM ; ESM.
- Le calcul de la répartition reste en SQL (`repartition`, `decompte`, `synthese`) ; l'API le présente sans le
  réimplémenter.
- Les lecteurs de factures sont des fonctions pures (mots et coordonnées → lignes) ; seul l'appel à `pdftotext`
  touche au système. Ils se testent sur les 22 fixtures sans serveur ni base.
- Les contrôles du § 6 de la SPEC sont écrits une seule fois en TypeScript pur, utilisés en direct dans la grille et
  rejoués par le serveur avant toute validation. Mode de partage du code entre les deux paquets : à préciser à la
  première mise en œuvre (dossier `shared/` importé par les deux). *Précisé par l'ADR 0005 : la grille appelle l'API
  (`POST /api/controle`), le code n'est pas partagé.*
- Montants : `numeric` en base, chaînes de caractères dans l'API, bibliothèque décimale côté TypeScript ; arrondi à
  l'affichage seulement.
- Schéma : `backend/schema.sql` complet et à jour, plus `backend/migrations/NNN_*.sql` appliquées à la main avec
  `psql`, comme Step Challenge.

**Environnements** *(production remplacée par l'ADR 0011 : VM, Docker sans root, déploiement par GitHub)*

| | Développement (maintenant) | Production (plus tard) |
|---|---|---|
| API et front | Mac du propriétaire, réseau local | LXC Proxmox, systemd + Nginx, `git pull` + `deploy/deploy.sh` |
| Base | PostgreSQL 18 de l'exploitation (base `colibri`) | même serveur PostgreSQL |
| Accès | réseau local, sans authentification | Cloudflare Access devant l'application |
| Tests automatiques | PostgreSQL 18 jetable dans Docker sur le Mac (`docker-compose.dev.yml`) | — |

Docker sert uniquement à la base de test sur le poste de développement ; rien n'est déployé dans Docker.

## Conséquences

- Même pile et mêmes réflexes que CountRep et Step Challenge ; le déploiement reprend le script de CountRep.
- Les tests ne touchent jamais la base de production, qui garde les vraies données.
- La sortie de `pdftotext` varie d'une version de poppler à l'autre (constaté avec poppler 26.10) : lecteurs tolérants
  aux espaces, et version de poppler à noter et fixer sur le LXC.
- Pas d'authentification applicative : l'accès de production repose entièrement sur Cloudflare Access ; l'API ne doit
  écouter que sur `127.0.0.1` derrière Nginx.

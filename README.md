# colibri-rent-book – gestion des charges locatives

Logiciel de gestion des charges locatives d'un propriétaire : import des factures d'énergie (PDF lus dans le
navigateur par des extracteurs éditables), répartition entre les locataires au tantième et aux jours de présence,
décomptes, régularisations figées avec leur justificatif PDF (factures en annexe), paiements reçus, synthèse fiscale.

| Dossier | Contenu |
|---|---|
| `backend/` | API Fastify, schéma PostgreSQL et migrations, moteur de répartition en SQL, justificatifs PDF |
| `frontend/` | Interface Vue 3, extraction des factures (pdf.js, extracteurs, éditeur Monaco) |
| `docs/SPEC.md`, `docs/adr/` | Règles métier et décisions d'architecture |
| `Dockerfile`, `backend/migrations/Dockerfile` | Images publiées par la CI : `ghcr.io/mauvaisetroupe/colibri-rent-book:<version>` et sa migration Flyway `…-migrations:<version>` |
| `docs/exploitation.md`, `compose.example.yml` | Pour l'exploitant : configuration, données à conserver, mises à jour ; composition d'exemple (notes de chaque version : GitHub Releases) |

Le dépôt ne contient aucune donnée réelle : chaque exploitation (immeubles, factures, sauvegardes, composition de
production) est tenue par son exploitant, qui choisit la version des images.

Commandes : voir `CLAUDE.md`.

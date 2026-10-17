# colibri-rent-book – gestion des charges locatives

Logiciel de gestion des charges locatives d'un propriétaire : import des factures d'énergie (PDF lus dans le
navigateur par des extracteurs éditables), répartition entre les locataires au tantième et aux jours de présence,
décomptes, régularisations figées avec leur justificatif PDF (factures en annexe), paiements reçus, synthèse fiscale.

| Dossier | Contenu |
|---|---|
| `backend/` | API Fastify, schéma PostgreSQL et migrations, moteur de répartition en SQL, justificatifs PDF |
| `frontend/` | Interface Vue 3, extraction des factures (pdf.js, extracteurs, éditeur Monaco) |
| `docs/SPEC.md`, `docs/adr/` | Règles métier et décisions d'architecture |
| `Dockerfile` | Image publiée par la CI : `ghcr.io/mauvaisetroupe/colibri-rent-book:<commit>` |

Le dépôt ne contient aucune donnée réelle : chaque exploitation (immeubles, factures, sauvegardes, composition de
production) a son propre dépôt, qui choisit la version de l'image et lance les tests sur ses données.

Commandes : voir `CLAUDE.md`.

# Migrations

- `../schema.sql` décrit le schéma **complet et à jour** : il sert à créer une base neuve (tests, nouvel environnement).
- Les fichiers `NNN_*.sql` de ce dossier font évoluer une base **existante**, dans l'ordre de leur numéro, chacun dans
  une transaction.

Toute modification du schéma ajoute une migration **et** met à jour `schema.sql`.

## Appliquer une migration

Toujours après une sauvegarde de la base. Dans un conteneur PostgreSQL :

```bash
docker compose exec -T db psql -U colibri -d colibri -v ON_ERROR_STOP=1 < backend/migrations/010_fournisseur_confidentiel.sql
```

Les données livrées avec le logiciel (`seed/extracteurs.sql` : extracteurs EDF et ENGIE) se rechargent de la même façon
après une mise à jour qui les change ; le fichier est rejouable.

## Historique

| Migration | ADR | Contenu |
|---|---|---|
| `001_schema.sql` | 0002 | Schéma initial (immeubles, lots, séjours, factures, provisions, régularisations, compteurs) |
| `002_repartition.sql` | 0002 | Moteur de répartition : `repartition`, `decompte`, `synthese` |
| `003_repartition_validated_only.sql` | 0003 | `repartition` ne prend que les factures validées |
| `004_regularisation_instantane.sql` | 0007 | Régularisation figée (`instantane`), date de création |
| `005_paiements.sql` | 0008 | Paiements reçus, provisions calculées (`v_provision`), dépôt de garantie, `montant_recu` calculé |
| `006_echeance.sql` | 0009 | Loyer et provision appelés par séjour, avec leur historique (`echeance`) |
| `007_regularisation_decision.sql` | 0010 | État des régularisations calculé, `statut` remplacé par `decision` |
| `008_affectation_ligne.sql` | 0013 | `recuperable` d'une ligne de facture remplacé par `affectation` (récupérable, propriétaire, hors immeuble) |
| `009_extracteur.sql` | 0013 | Extracteurs de factures versionnés et figés, `facture.extracteur_id`, total d'un brouillon facultatif |
| `010_fournisseur_confidentiel.sql` | 0014 | `fournisseur.confidentiel` : factures jamais jointes au justificatif |
| `011_travaux.sql` | 0015 | Factures de travaux du propriétaire (nature, date de paiement, PDF), pour la synthèse fiscale |
| `012_assemblees.sql` | 0016 | Société, associés et parts, assemblées générales (présences, résolutions), registre figé à la clôture |
| `013_facture_remplacee.sql` | 0017 | Facture validée remplacée (statut `remplacee`, par qui, quand, motif), brouillon de correction, numéro unique parmi les validées |
| `014_releves_bancaires.sql` | 0018 | Relevés bancaires et mouvements, extracteurs de relevés (`extracteur.type`), lien paiement / travaux → mouvement, PDF rangés par type (`factures/`, `releves/`, `travaux/`, `assemblees/`) |
| `015_categorie_mouvement.sql` | 0018 | Catégorie d'un mouvement bancaire (paiement de locataire, travaux, emprunt, assurance…) et note, à la place du motif « ignoré » |
| `016_reglements_depots_associes.sql` | 0019 | Règlements des travaux (payés en plusieurs fois, année fiscale de chaque paiement), versements de dépôt de garantie, catégories « associés » et « dépôt de garantie » |
| `017_authentification.sql` | 0020 | Comptes, passkeys (WebAuthn), sessions, liens d'enregistrement à usage unique, jetons d'API (empreintes seulement) |

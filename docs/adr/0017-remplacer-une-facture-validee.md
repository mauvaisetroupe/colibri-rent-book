# 17. Remplacer une facture validée

- Statut : Accepté
- Date : 2026-10-17

## Contexte

Une facture validée n'est plus modifiable (ADR 0003) : c'est ce qui garantit qu'un montant demandé à un locataire ne
change pas en silence. Mais il arrive qu'une facture validée soit fausse ou en double :

- une facture saisie à la main est remplacée plus tard par le vrai document (les TEOM saisies d'après le legacy,
  remplacées par les avis de taxe foncière : la TEOM 2023 a compté deux fois) ;
- une ligne validée est fausse (période, affectation, montant d'une ligne) ;
- le fournisseur envoie une facture rectificative, sous un autre numéro.

Jusqu'ici, la seule issue était une requête SQL, sans trace. L'ADR 0003 laissait le point ouvert.

## Décision

Une facture validée n'est **jamais modifiée ni supprimée** : elle est **remplacée**, de façon tracée.

- Nouveau statut `remplacee` : la facture reste en base, consultable, avec son PDF, mais n'entre plus dans les
  décomptes ni dans la synthèse fiscale (le moteur ne prend que `validee`). Elle porte la facture qui la remplace
  (`remplacee_par`), la date (`remplacee_le`) et le motif, obligatoire.
- **Remplacer par une autre facture** (facture rectificative, vrai document) : depuis une facture validée, choisir une
  facture validée du même immeuble, non remplacée, et donner le motif. Les deux sont liées dans les deux sens à
  l'écran.
- **Corriger** (ligne fausse) : crée un brouillon, copie de la facture (en-tête, lignes, PDF, extracteur), qui
  porte la facture qu'il remplacera (`remplace_id`). On le corrige comme tout brouillon ; sa **validation** passe
  l'ancienne en `remplacee` dans la même transaction (motif : « Corrigée », complété par la note). Supprimer le
  brouillon abandonne la correction ; l'ancienne reste validée.
- Le numéro reste unique chez un fournisseur parmi les factures **validées** (index partiel) : la copie d'une
  correction garde le numéro de l'original.
- Pas d'annulation : une facture remplacée le reste. Si la remplaçante est fausse à son tour, on la corrige ou on la
  remplace : la chaîne des remplacements garde la trace.

### Effet sur les régularisations

Une régularisation envoyée est figée (ADR 0007) : le remplacement ne la change pas. Le décompte, lui, change : l'écran
des régularisations signale déjà « à rectifier » celles dont le calcul refait diffère du montant envoyé, et le
rectificatif existe. Au moment du remplacement, l'écran liste les régularisations envoyées dont la période touche une
ligne récupérable de l'une des deux factures, pour qu'on aille les voir.

## Conséquences

- Fin des corrections en SQL : chaque changement d'une facture validée laisse une trace consultable (qui remplace qui,
  quand, pourquoi).
- La liste des factures montre les factures remplacées (pastille « Remplacée »), masquées par défaut.
- Migration 013 : valeur `remplacee` de `statut_facture`, colonnes `remplacee_par`, `remplacee_le`,
  `motif_remplacement`, `remplace_id`, index d'unicité partiel à la place de `UNIQUE (fournisseur_id, numero)`.

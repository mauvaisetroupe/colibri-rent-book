# 3. Factures prises en compte dans un décompte

- Statut : Accepté
- Date : 2026-10-12

## Contexte

Une facture importée est lue automatiquement ; le lecteur peut se tromper (libellé tronqué, mauvaise période avec un
montant juste). La SPEC laissait ouvert le choix entre « seules les factures validées » et « toutes, avec alerte ».
Aujourd'hui, la fonction SQL `repartition` ne regarde pas le statut : toutes les factures sont réparties (sans effet
sur le seed, dont toutes les factures sont validées).

## Décision

- Une facture importée est un **brouillon** (statut `a_verifier`) : ses lignes s'affichent dans la grille éditable,
  l'utilisateur les corrige, les contrôles s'affichent en direct.
- La **validation** (statut `validee`) est une action explicite de l'utilisateur ; le serveur la refuse si un contrôle
  bloquant échoue.
- **Seules les factures validées entrent dans les décomptes** : `repartition` filtre sur `statut = 'validee'`
  (migration de l'étape 1a ; `check_sql_golden.py` doit rester vert).

## Conséquences

- Une facture mal lue ne peut pas fausser un montant demandé à un locataire.
- Le décompte et l'écran de couverture signalent les brouillons dont la période touche l'exercice, pour qu'une facture
  oubliée en brouillon ne disparaisse pas silencieusement du calcul.
- Modification d'une facture déjà validée : jamais ; elle est remplacée, de façon tracée (ADR 0017).

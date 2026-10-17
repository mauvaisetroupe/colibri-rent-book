# 1. Enregistrer les décisions d'architecture

- Statut : Accepté
- Date : 2026-10-12

## Contexte

Les règles métier de Colibri (R1 à R11) sont dans `docs/SPEC.md`. Les choix techniques et les décisions prises en
cours de route avec le propriétaire risquent, eux, de rester implicites dans le code ou les messages de commit.

## Décision

Comme dans CountRep et Step Challenge, chaque décision importante est consignée dans un ADR au format de Michael
Nygard, dans `docs/adr/` :

- un fichier par décision : `NNNN-titre-en-kebab-case.md`, numérotation continue, en français ;
- sections : Contexte, Décision, Conséquences ;
- statut : Proposé, Accepté, Déprécié ou Remplacé par ADR-NNNN ;
- un ADR accepté n'est pas réécrit : on en crée un nouveau qui le remplace ;
- l'index est tenu à jour dans `docs/adr/README.md`.

Est « importante » une décision qui touche une règle métier, le schéma, un contrat d'API, la sécurité, ou qui serait
coûteuse à défaire. Une décision qui change une règle R1 à R11 met aussi la SPEC à jour.

## Conséquences

- Le pourquoi des choix est retrouvable, y compris par un agent de code (référencé dans `CLAUDE.md`).
- Léger coût d'écriture à chaque décision structurante.

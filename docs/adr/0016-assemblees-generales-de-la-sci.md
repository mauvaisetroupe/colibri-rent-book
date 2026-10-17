# 16. Assemblées générales de la SCI, procès-verbaux

- Statut : Accepté
- Date : 2026-10-18

## Contexte

Le propriétaire peut être une SCI. Elle tient chaque année une assemblée générale (approbation des comptes, répartition
du résultat entre associés pour une SCI à l'impôt sur le revenu), et parfois des assemblées extraordinaires. Les
décisions sont consignées dans des **procès-verbaux**, tenus dans un registre (numérotés, conservés, jamais modifiés
une fois établis).

Décisions du propriétaire (2026-10-18) : un procès-verbal en PDF ; le registre légal tenu dans l'application ; les
associés et leurs parts n'ont pas changé depuis la création (pas d'historique des cessions pour l'instant). Les noms des
associés sont des données saisies dans l'application, jamais dans le code.

## Décision

### La société et ses associés

- `societe` (une ligne) : dénomination, forme (« SCI »), capital, siège social, RCS (le nombre de parts est la somme de celles des associés) ; repris en tête
  de chaque procès-verbal.
- `associe` : nom, nombre de parts, gérant (oui ou non), adresse, note. La part de chacun est son nombre de parts sur
  le total. Pas d'historique des cessions : le jour où les parts changent, un ADR le prévoira (les procès-verbaux
  établis gardent, eux, la répartition du jour, voir plus bas).

### Les assemblées

- `assemblee` : type (`ordinaire` ou `extraordinaire`), date, heure, lieu, ordre du jour, président de séance,
  observations.
- Présence de chaque associé : présent, représenté (par qui), absent ; les parts présentes ou représentées donnent le
  quorum.
- `resolution` : ordre, titre, texte, parts pour, contre, abstention ; adoptée si les parts « pour » font plus de la
  moitié des parts présentes ou représentées (majorité simple ; une majorité renforcée prévue par les statuts se note
  dans le texte et se vérifie à la main).
- **Modèle d'assemblée annuelle** : l'ordre du jour et les résolutions habituelles (approbation des comptes de
  l'exercice, affectation et répartition du résultat entre les associés au prorata des parts, quitus à la gérance)
  sont proposés à la création, modifiables, ainsi qu'une résolution de pouvoirs pour les formalités. Le montant du
  résultat reste à compléter (`[montant]`) : la clôture est refusée tant qu'un texte entre crochets subsiste.

### Le registre et le procès-verbal

- Une assemblée est un **brouillon** tant qu'elle n'est pas **close**. La clôture lui donne le numéro suivant du
  registre (1, 2, 3…) et **fige** le procès-verbal : société, associés et parts, présences, résolutions et votes du
  jour, enregistrés tels quels (`instantane`, comme pour les régularisations, ADR 0007). Une assemblée close n'est plus
  ni modifiée ni supprimée (trigger), comme les extracteurs (ADR 0013).
- **PDF du procès-verbal** composé par pdfmake (comme le justificatif, ADR 0014) : en-tête de la société, date, lieu,
  présents et représentés, quorum, ordre du jour, résolutions avec le résultat du vote (« adoptée à l'unanimité »,
  « adoptée par N parts sur M »), place pour les signatures du président de séance et des associés. Pour un brouillon,
  le PDF est un projet (« Projet – non clos »).
- Le PDF signé (scanné) peut être joint à l'assemblée close : c'est le document du registre.

### Écrans

Un groupe de menu « SCI » : **Société** (fiche de la société, associés et parts), **Assemblées** (registre :
numéro, date, type, état ; création, édition du brouillon, résolutions et votes, clôture, PDF, PV signé joint).

## Conséquences

- Le registre des décisions est tenu dans l'application, avec des procès-verbaux figés et numérotés sans trou.
- Aucune donnée d'une SCI dans le dépôt : les tests utilisent une société et des associés fictifs.
- À voir plus tard : historique des cessions de parts ; lien entre le résultat de l'exercice et la synthèse fiscale
  (aujourd'hui, le montant du résultat se saisit dans la résolution) ; envoi des convocations.

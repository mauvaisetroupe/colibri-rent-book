# Architecture Decision Records

Voir [ADR 0001](0001-enregistrer-les-decisions-d-architecture.md) pour le format et les règles.

Ces décisions ont été prises pour la première exploitation du logiciel (une SCI, deux immeubles), dont le dépôt garde
les données et l'exploitation : les fixtures (vraies factures), `golden.json` (décomptes attendus au centime) et le
seed cités ici sont dans ce dépôt-là, qui lance aussi les tests sur ces données. Les ADR 0011 (hébergement) et 0012
(séparation du logiciel et de l'exploitation) sont des décisions d'exploitation, gardées dans ce dépôt-là.

| N° | Titre | Statut |
| -- | ----- | ------ |
| 0001 | [Enregistrer les décisions d'architecture](0001-enregistrer-les-decisions-d-architecture.md) | Accepté |
| 0002 | [Architecture et environnements](0002-architecture-et-environnements.md) | Accepté (environnements : voir l'exploitation) |
| 0003 | [Factures prises en compte dans un décompte](0003-factures-prises-en-compte.md) | Accepté |
| 0004 | [Lecteurs de factures par colonnes et contrôles bloquants](0004-lecteurs-et-controles-des-factures.md) | Remplacé par 0013 |
| 0005 | [Import et édition des factures](0005-import-et-edition-des-factures.md) | Accepté |
| 0006 | [Décompte, couverture des périodes et export Excel](0006-decompte-couverture-et-export.md) | Accepté |
| 0007 | [Régularisations figées, justificatif PDF et mails](0007-regularisations-justificatif-et-mails.md) | Accepté (justificatif : 0014) |
| 0008 | [Paiements reçus, suivi des régularisations et synthèse fiscale](0008-paiements-suivi-et-fiscal.md) | Accepté |
| 0009 | [Loyer et provision appelés](0009-loyer-et-provision-appeles.md) | Accepté |
| 0010 | [État calculé des régularisations, décision du propriétaire](0010-etat-calcule-des-regularisations.md) | Accepté |
| 0013 | [Extracteurs de factures éditables, versionnés, sur pdf.js](0013-extracteurs-de-factures-editables.md) | Accepté |
| 0014 | [Justificatif sans Chromium, factures en annexe, fournisseurs confidentiels](0014-justificatif-sans-chromium-factures-en-annexe.md) | Accepté |
| 0015 | [Factures de travaux du propriétaire](0015-travaux-du-proprietaire.md) | Accepté |
| 0016 | [Assemblées générales de la SCI, procès-verbaux](0016-assemblees-generales-de-la-sci.md) | Accepté |
| 0017 | [Remplacer une facture validée](0017-remplacer-une-facture-validee.md) | Accepté (complète 0003) |
| 0018 | [Relevés bancaires : extracteurs, mouvements, rapprochement](0018-releves-bancaires.md) | Accepté |
| 0019 | [Travaux payés en plusieurs fois, dépôts de garantie, associés](0019-reglements-depots-associes.md) | Accepté (complète 0015, 0018) |
| 0020 | [Authentification par passkey, dans l'application](0020-authentification-par-passkey.md) | Accepté |
| 0021 | [Dépôt de garantie géré depuis le séjour, retenue en paiements](0021-depot-de-garantie-gere-depuis-le-sejour.md) | Accepté |
| 0022 | [Factures réglées par la banque](0022-reglements-des-factures.md) | Accepté |
| 0023 | [Début de la gestion d'un immeuble](0023-debut-de-la-gestion.md) | Accepté |

La prochaine décision du logiciel prend le numéro 0022.

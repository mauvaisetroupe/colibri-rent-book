# 4. Lecteurs de factures par colonnes et contrôles bloquants

- Statut : Remplacé par l'ADR 0013 (lecteurs ; les contrôles restent, sans celui des kWh)
- Date : 2026-10-12

## Contexte

La SPEC (§ 6) demande de lire les factures EDF et ENGIE par position des colonnes (`pdftotext -bbox-layout`), et
liste des contrôles sans dire lesquels empêchent la validation. Les factures réelles s'écartent souvent d'une plage
« propre » : abonnement facturé jusqu'à 6 mois d'avance, locations ENGIE facturées un mois après, CTA EDF qui déborde
d'un jour, CTA et TICGN sans période imprimée. Trop d'alertes sur des cas normaux finissent par ne plus être lues.

## Décision

**Lecteurs** (`backend/src/invoices/`) : `pdftotext -bbox-layout` donne les mots et leurs coordonnées ; les mots sont
regroupés en rangées (2 points de tolérance verticale), puis rangés par colonne selon leur abscisse (bornes en points
PDF dans `edf.ts` et `engie.ts`). Une ligne de facture est une rangée qui a un montant HT et un taux de TVA (et un TTC
pour ENGIE). Libellés normalisés comme le lecteur Python de référence. Montants en chaînes décimales (`big.js`).
EDF n'imprime pas de TTC par ligne : HT × (1 + TVA), arrondi au centime au demi supérieur.

**Contrôles** (`checks.ts`, sans dépendance à Node pour être réutilisé par la grille) :

| Contrôle | Gravité |
|---|---|
| Somme des TTC = total imprimé, à 0,05 € près | erreur |
| Période incomplète, date invalide, début après la fin | erreur |
| Libellé vide | erreur |
| Pénalité marquée récupérable | erreur |
| Période attribuée par défaut (note R6) : « à confirmer » | avertissement |
| Trou ou chevauchement entre les sous-périodes de consommation | avertissement |
| Période éloignée de la consommation facturée : plus de 62 jours avant, plus de 31 jours après (200 pour l'abonnement) ; pénalités exclues | avertissement |

Une erreur empêche la validation ; un avertissement surligne la ligne sans bloquer. Les tolérances ont été mesurées sur
les 22 fixtures : seules les deux locations de 2022 rattrapées sur la facture ENGIE de mars 2024 sortent de la plage.

Non fait : comparer la somme des kWh au total de consommation imprimé (le lecteur ne lit pas encore ce total).

## Conséquences

- Les 22 fixtures sont lues à l'identique du lecteur Python et sont toutes validables sans retouche.
- Le trou et le chevauchement de consommation restent des avertissements : une option tarifaire à deux postes
  (heures pleines / creuses) aurait deux lignes de même période. À durcir si cela ne se présente jamais.
- Les bornes de colonnes dépendent de la mise en page des fournisseurs et de la version de poppler : une nouvelle
  mise en page se verra par un échec des fixtures ou par une facture importée vide ou non validable.

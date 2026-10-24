# 22. Factures réglées par la banque

- Statut : Accepté (prolonge 0018 et 0019)
- Date : 2026-10-23

## Contexte

Les factures des charges (gaz, électricité, eau, taxe foncière) sont payées par prélèvement ou par virement, et ces
paiements sont dans les relevés (ADR 0018), catégorisés « énergie », « eau » ou « impôts et taxes ». Mais rien ne relie
une facture à son paiement : la liste des factures ne dit pas lesquelles sont payées, et un prélèvement ne renvoie pas
à sa facture. L'ADR 0019 l'annonçait pour les travaux : « une autre sorte de facture payée à la banque (énergie)
suivrait la même règle ».

Ce qu'on voit dans les relevés d'une exploitation réelle :

- la plupart des factures sont payées par **un prélèvement du même montant** (une facture d'électricité tous les deux
  mois, une facture de gaz) ;
- une facture d'eau est parfois payée **en deux fois** (un rappel partiel, puis le solde), et le libellé d'un virement
  porte souvent le **numéro de la facture** ;
- un fournisseur peut passer à la **mensualisation** : des prélèvements mensuels, puis une facture qui les solde ;
- des prélèvements d'énergie concernent **un autre immeuble**, ou un contrat dont les factures ne sont pas (encore)
  saisies.

## Décision

- **Payé, c'est vu à la banque**, comme pour les travaux (ADR 0019) : une facture validée a ses **règlements**
  (`reglement_facture` : un mouvement, un montant positif). Un paiement en deux fois fait deux règlements ; un
  prélèvement qui paie deux factures, un règlement sur chacune. Leur total ne dépasse ni la facture ni le mouvement.
- **Un remboursement est un règlement négatif** (ajouté le 2026-10-23, migration 021) : une mensualisation qui a
  prélevé plus que la facture annuelle est remboursée par un crédit ; ce crédit (« énergie », « eau » ou « impôts et
  taxes », catégories désormais possibles pour un crédit) se rattache à la facture pour tout son reste, en négatif. La
  facture a alors d'autant plus à régler, ce que couvrent les mensualités : rattacher le remboursement d'abord.
- Se règle une facture **validée**, ou un **brouillon dont le total est saisi** (modifié le 2026-10-24) : une facture à
  retrouver se saisit d'après le virement (fournisseur, numéro, montant), le virement s'y rattache, et le brouillon se
  complète plus tard (PDF, lignes, validation). Un brouillon ne compte dans aucun décompte : le rattacher dit seulement
  ce que paie le virement. Son total ne peut plus descendre sous ce qui lui est rattaché ; supprimé, ses règlements
  disparaissent avec lui (le virement redevient à rattacher). Quand une facture est remplacée
  (« Corriger… » validé ou « Remplacer par… », ADR 0017), **ses règlements passent à la facture qui la remplace** : le
  paiement suit le document qui compte.
- **Un règlement naît d'un rattachement** : depuis le mouvement (Banque, « Rattacher à une facture… ») ou depuis la
  facture (« Rattacher un paiement… »). Il vaut ce qui reste du mouvement, au plus ce qui reste de la facture ;
  détacher le supprime. Se rattachent les débits « énergie », « eau » ou « impôts et taxes », ou sans catégorie (le
  rattachement leur donne celle de la facture : eau → « eau », ordures ménagères → « impôts et taxes », sinon
  « énergie »).
- **Propositions** : pour un débit, les factures validées dont le reste est son montant, ou dont le numéro (son dernier
  groupe d'au moins cinq chiffres) figure dans le libellé ou le détail du mouvement ; pour une facture, les débits de
  ces catégories qui ont un reste, ceux du même montant d'abord.
- **Ces catégories ont un détail, comme les autres** : un prélèvement « énergie », « eau » ou « impôts et taxes » que
  ses factures ne couvrent pas est **à rattacher** (statut `incomplet`). Un prélèvement d'un autre immeuble attend que
  ses factures soient saisies sur cet immeuble ; une mensualisation, la facture qui la solde. La liste à rattacher dit
  ainsi aussi quelles factures manquent.
- **Écran Banque en trois onglets** : « À catégoriser » ; « Rapprochement », les catégories qui ont un détail
  (paiements de locataire, travaux, dépôts, factures), avec « Seulement ceux à rattacher », cochée d'office ; « Autres
  catégories » (emprunt, assurance, frais bancaires…), où une catégorie suffit. « À compléter » devient **« à
  rattacher »** partout (Banque, Contrôles, Accueil) : c'est ce qu'il reste à faire.
- **Liste des factures** : une colonne « Payée » (✓ payée, partielle avec son reste, ou à payer) pour les factures
  validées, la date du dernier règlement, et un filtre « à payer ». Une facture remplacée ou un brouillon n'en a pas.
- Le montant couvert d'un mouvement (`couverture.ts`) compte aussi les règlements de factures, avec les mêmes
  vérifications (catégorie, signe, montant) que les autres rattachements.

## Conséquences

- La liste des factures dit lesquelles sont payées ; une facture renvoie à ses prélèvements, un prélèvement à sa
  facture.
- Une mensualisation se rattache comme un paiement en plusieurs fois : chaque prélèvement mensuel est un règlement de la
  facture qui les solde (une fois celle-ci reçue et validée).
- Migration 020 : table `reglement_facture`. Aucun règlement n'est repris : les rattachements de l'historique se font
  à l'écran (les propositions du même montant sont en un clic) ou par un script de l'exploitation.
- Les prélèvements d'énergie, d'eau et de taxes déjà catégorisés deviennent « à rattacher » tant que leurs factures ne
  sont pas rattachées : les Contrôles et l'Accueil les comptent. Ceux d'un immeuble dont les factures ne sont pas
  encore saisies le restent jusque-là.

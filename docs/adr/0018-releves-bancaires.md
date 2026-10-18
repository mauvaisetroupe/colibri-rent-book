# 18. Relevés bancaires : extracteurs, mouvements, rapprochement

- Statut : Accepté
- Date : 2026-10-18

## Contexte

Les paiements des locataires se saisissent à la main (ADR 0008), les factures de travaux aussi (ADR 0015), alors que
tout passe par le compte de la SCI. Les relevés de la banque arrivent en PDF tous les quinze jours. Les lire comme les
factures (ADR 0013) permettrait de proposer les paiements reçus et les dépenses, en brouillon, au lieu de les saisir ;
plus tard, d'autres dépenses (assurance, intérêts d'emprunt, frais bancaires : la déclaration des revenus fonciers en
a besoin).

Essai sur 109 relevés du Crédit Mutuel (2022 à 2026) avec une maquette : 96 lus au centime (solde précédent + crédits −
débits = nouveau solde, et égal au « Total des mouvements » imprimé), 536 mouvements. Les 13 autres : une facture de
commissions (pas un relevé) et 12 impressions « Microsoft Print to PDF » sans texte (des images : illisibles sans
reconnaissance de caractères). Deux constats :

- **Débit ou crédit se lit à la colonne**, pas au texte : un montant est sous « Débit EUROS » ou « Crédit EUROS ». Les
  lignes de texte des factures (regroupement, ADR 0013) perdent la position : un extracteur de relevé a besoin des
  morceaux de la ligne et de leur abscisse.
- Une opération tient sur plusieurs lignes (libellé, puis émetteur, référence, motif « LOYER 02/25 ») : les lignes qui
  suivent une opération, jusqu'à la suivante, sont son détail. Un code imprimé à la verticale dans la marge se glisse
  dans les lignes : à ignorer.

## Décision

### Extracteurs de relevés

- Même principe que les factures (ADR 0013) : une classe TypeScript par banque, écrite dans l'éditeur, stockée par
  version et figée, exécutée dans le navigateur seulement. Elle étend **`BankStatementExtractor`** (module
  `'bank-extractor'`), pas `InvoiceExtractor`.
- Ce qu'elle voit : les lignes de texte, et pour chaque ligne ses **morceaux avec leur abscisse** (`rows`). Méthodes :
  - `recognizes()` : ce PDF est-il un relevé de cette banque ;
  - `account()` : numéro de compte ;
  - `statementDate()` : date du relevé (« 16 octobre 2026 » : aide `longFrenchDate`) ;
  - `openingBalance()`, `closingBalance()` : solde précédent et nouveau solde (négatif s'il est débiteur) ;
  - `movementsZone()` : les lignes des opérations (par défaut, toutes) ;
  - `findMovement(row, context)` : cette ligne commence-t-elle une opération ;
  - `readMovement(match, context)` : date, date de valeur, libellé, montant et sens (débit, crédit) ; le moteur lui
    rattache les lignes suivantes comme détail ;
  - `printedTotals()` : facultatif, totaux imprimés des débits et des crédits (contrôle).
- Aides : `column(piece, headers)` (sous quel titre de colonne est un montant, par son bord droit),
  `amount` qui accepte « 1.697,54 » (point des milliers), `frenchDate`, `longFrenchDate`, `between`.
- Mêmes réglages de regroupement que les factures, plus une **marge** : les morceaux à gauche d'une abscisse sont
  ignorés (40 points pour le Crédit Mutuel). Le moteur (`moteurReleve.ts`) rattache à une opération les lignes qui la
  suivent, sauf celles que `ignoreRow` écarte, et refuse l'import d'un relevé dont les soldes ou les totaux imprimés ne
  retombent pas au centime.
- Écran d'édition propre aux relevés (`ExtracteurReleveView.vue`) : même éditeur Monaco, texte surligné (zone,
  opérations, détail), résultat avec le contrôle des soldes, « Tester sur les relevés » déjà importés.
- Table `extracteur` : colonne `type` (`facture`, `releve`) ; l'énergie n'a de sens que pour une facture. La banque est
  un fournisseur (écran Fournisseurs, comme EDF).
- Le Crédit Mutuel est livré comme EDF et ENGIE (le format est celui de la banque, pas de la SCI) ; les relevés de la
  SCI et leurs tests restent dans le dépôt d'exploitation (privé).

### Relevés et mouvements

- `releve_bancaire` (`releve` est déjà la table des relevés de compteurs) : banque (fournisseur), compte, date, solde
  précédent, nouveau solde, PDF, extracteur. Un relevé par compte et par date (doublon refusé). Contrôles obligatoires à
  l'import, refaits par le serveur : soldes et totaux imprimés au centime. La liste signale un relevé manquant (solde
  précédent différent du nouveau solde du relevé d'avant du même compte).
- `mouvement` : relevé, date, date de valeur, libellé, détail, montant signé (crédit positif), motif s'il est ignoré.
  Ce qu'il est devenu est de l'autre côté : `paiement.mouvement_id`, `travaux.mouvement_id` (plusieurs paiements pour
  un virement de plusieurs mois). Son état est calculé : `a_traiter`, `partiel` (paiements inférieurs au montant),
  `rapproche`, `ignore`. Supprimer le paiement remet le mouvement à traiter ; modifier un paiement ou des travaux depuis
  leur écran garde le lien.
- Un relevé dont un mouvement est rapproché n'est plus supprimé.

### Rapprochement (écran « Banque », Tenue des comptes)

- Les mouvements à traiter, du plus ancien au plus récent (filtres par année et par sens), avec une **proposition**
  calculée dans l'écran (`rapprochement.ts`) :
  - un paiement ou des travaux **déjà saisis à la main**, même montant à dix jours près (pour un crédit, ceux du
    locataire reconnu dans le libellé) : « Rattacher » ; « Rattacher les N déjà saisis » quand il n'y en a qu'un ;
  - un crédit dont le libellé ou le détail porte le nom d'un locataire présent : « paiement de <locataire> pour
    <mois> », montant comparé au loyer et à la provision appelés (ADR 0009) ; « Accepter » crée le paiement (ADR 0008),
    lié au mouvement ;
  - un débit : un motif d'après le libellé (emprunt, assurance, énergie, frais bancaires…) pour l'ignorer, ou
    « facture de travaux » (formulaire prérempli : fournisseur d'après le libellé, montant, date de paiement) ;
  - sinon : rattacher à la main, ou ignorer avec un motif.
- Le paiement créé depuis un mouvement en garde le lien : un mouvement n'est rapproché qu'une fois, et le paiement
  montre d'où il vient.

### Rangement des PDF

Le stockage des PDF a un dossier par type : `factures/`, `releves/`, `travaux/`, `assemblees/` ; les colonnes gardent
le chemin relatif (`factures/<empreinte>.pdf`). Pas de dossier par date : quelques centaines de fichiers par an, et un
fichier nommé par son empreinte n'a pas de date. La migration 014 change les chemins ; au démarrage, le serveur range
les fichiers encore à la racine (une seule fois, sans rien faire ensuite). La restauration (exploitation) recopie le
dossier entier.

## Conséquences

- La saisie des paiements devient une validation de propositions ; les écarts (loyer partiel, virement groupé) restent
  visibles comme mouvements à traiter.
- Plus tard, sans changer la lecture : les dépenses déductibles (assurance, intérêts, frais bancaires) dans la synthèse
  fiscale, le lien entre un prélèvement et sa facture d'énergie.
- Les relevés sans texte (impressions en image) ne se lisent pas : les télécharger à nouveau depuis l'espace client.

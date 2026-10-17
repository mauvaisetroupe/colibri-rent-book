# 7. Régularisations figées, justificatif PDF et mails

- Statut : Accepté
- Date : 2026-10-12

## Contexte

La phase 3 produit, pour chaque locataire, un justificatif PDF et le texte du mail de régularisation ou de
rectificatif (SPEC § 8). En 2026, des régularisations ont été envoyées avec des montants faux (SPEC § 11) : il faut
pouvoir dire ce qui a été envoyé, le corriger proprement, et ne jamais laisser un document envoyé changer après coup.

## Décision

- **Une régularisation fige ce qui est envoyé** : créée à partir du décompte d'un exercice, elle enregistre le montant
  dû et les provisions (arrondis au centime) et un **instantané** du justificatif (`regularisation.instantane`,
  migration 004) : quote-parts par rubrique, dépenses de l'immeuble, factures et périodes retenues. Son PDF est toujours
  produit depuis cet instantané : il reste identique même si les factures, les séjours ou les provisions changent.
- **Une seule régularisation en cours par séjour et par exercice.** Une correction est un **rectificatif** : une
  nouvelle régularisation, calculée sur le décompte du moment, qui remplace la précédente (`remplace_id`). Le rectificatif
  n'est possible que sur une régularisation envoyée ; un brouillon se supprime et se recrée.
- **Régularisation envoyée hors de l'application** : saisie à la main (montant demandé, provisions déduites, date
  d'envoi, montant déjà reçu), statut « envoyée », sans justificatif. Elle sert de base au rectificatif.
- **Justificatif** : page HTML autonome imprimée en PDF par Chromium (`playwright-core`) ; identité du logement et
  présence, explication de la formule (R3), dépenses de l'immeuble et quote-part par rubrique, provisions, solde, liste
  des factures avec la période retenue (bornée à la présence du locataire) et la part de chacune. Un aperçu non figé
  est disponible avant la création.
- **Mails** : texte généré par le serveur à partir des montants figés, modifiable dans l'écran, ouvert dans la
  messagerie (`mailto:`) ; rien n'est envoyé automatiquement, le justificatif est joint à la main. Rectificatif :
  excuses, montant initial, montant corrigé, versements déjà faits, reste à payer ou trop-perçu. Options : étalement en
  mensualités (centimes sur la dernière), nouvelle provision mensuelle proposée (charges par jour × 365 ÷ 12, arrondie
  aux 5 € supérieurs), signature (gardée dans le navigateur).
- **Statuts** : brouillon → envoyée dans cette phase ; payée, étalée, abandonnée, irrécouvrable et les paiements reçus
  viennent avec la phase 4.

- **Écrans** (révisés le 2026-10-15) : la liste de toutes les régularisations, quelle que soit leur période (en cours
  par défaut, un rectificatif à la place de celle qu'il remplace) ; une fiche par régularisation
  (`/regularisations/:id` : montants, versements, historique des rectificatifs, mail, justificatif, statut) ; la
  création sur une période choisie librement (`/regularisations/nouvelle`), avec la saisie d'une régularisation déjà
  envoyée.
- **À rectifier** (2026-10-15) : la liste et la fiche refont le décompte de chaque régularisation sur sa période (ce
  que donnerait un rectificatif) et le comparent au solde figé. Écart de 5 € ou plus : « à rectifier » (« à recréer »
  pour un brouillon), avec le montant ; en dessous, l'écart est seulement affiché (2023 : factures saisies d'après les
  totaux du legacy, environ 1 €). Pas de comparaison pour une régularisation abandonnée, irrécouvrable ou remplacée.
  Calcul dans `frontend/src/rectification.ts`, seuil `SEUIL_RECTIFICATION`.
- **Justificatif reconstitué** (2026-10-15) : une régularisation saisie à la main (envoyée hors de l'application, rien
  de figé) a quand même un PDF, refait le jour même sur le décompte de sa période, titré « Justificatif reconstitué ».
  Écart de moins de 5 € avec le solde envoyé : une ligne le dit (écart d'arrondi) ; au-delà, un avertissement encadré
  en rouge indique qu'il ne correspond pas à ce que le locataire a reçu. Ce PDF suit le décompte du jour : il n'est
  pas figé.

## Conséquences

- Les montants du justificatif sont ceux du décompte : vérifié en extrayant le texte du PDF généré
  (`backend/src/routes/regularisations.test.ts`).
- Chromium est nécessaire au serveur : Google Chrome installé sur le poste de développement
  (`PDF_BROWSER_CHANNEL=chrome`), `npx playwright-core install --with-deps chromium` sur le LXC de production et en CI.
- La correction d'une facture validée reste à décider (ADR 0003) ; elle passera par un rectificatif pour les
  régularisations déjà envoyées.

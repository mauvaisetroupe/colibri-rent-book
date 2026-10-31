<script setup lang="ts">
import Big from 'big.js'
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

import {
  aEncaisser, api, ENERGIES, type Couverture, type Decompte, type FactureResumee, type Mouvement, type Paiement,
  type Regularisation, type ReleveResume, type Sejour,
} from '../api'
import ChoixExercice from '../components/ChoixExercice.vue'
import { etatBanque } from '../controleBanque'
import { useExercice } from '../exercice'
import { dateFr, euros } from '../format'
import { useImmeuble } from '../immeuble'
import { anneesARegulariser, regularisationsManquantes, type Manquante } from '../regularisationsManquantes'

// Home: the yearly cycle as a checklist of the chosen exercise (real state of each step, link to its screen),
// then the user guide of every screen.

type Etat = 'ok' | 'attention' | 'a-faire'
type Etape = { number: number, title: string, lien: string, state: Etat, resume: string, details: string[] }

const { buildings, immeubleId, pret } = useImmeuble()
const debutGestion = () => buildings.value.find((i) => i.id === immeubleId.value)?.managed_from ?? null
const { start, end } = useExercice()
const invoices = ref<FactureResumee[]>([])
const charge_statement = ref<Decompte | null>(null)
const couverture = ref<Couverture | null>(null)
const charge_adjustments = ref<Regularisation[]>([])
const payments = ref<Paiement[]>([])
const tenancies = ref<Sejour[]>([])
const statements = ref<ReleveResume[]>([])
const mouvementsBanque = ref<Mouvement[]>([])
// Missing regularisations of every finished year, not only of the exercise chosen
const aRegulariser = ref<Manquante[]>([])
const erreur = ref<string | null>(null)

async function charger() {
  if (immeubleId.value === null) {
    return
  }
  const period = { building: immeubleId.value, start: start.value, end: end.value }
  try {
    const annees = [...new Set([Number(start.value.slice(0, 4)), Number(end.value.slice(0, 4))])]
    let lus: Paiement[][]
    ;[invoices.value, charge_statement.value, couverture.value, charge_adjustments.value, tenancies.value, statements.value,
      mouvementsBanque.value, ...lus] = await Promise.all([
      api.invoices(period.building), api.charge_statement(period), api.couverture(period),
      api.charge_adjustments(period.building), api.tenancies(period.building), api.statements(),
      api.transactions('tous', period.start, period.end),
      ...annees.map((a) => api.payments(period.building, a)),
    ])
    payments.value = lus.flat()
    const aujourdhui = new Date().toISOString().slice(0, 10)
    // Calendar years only (the statement of the exercise chosen when it is one of them)
    const decomptes = await Promise.all(anneesARegulariser(charge_adjustments.value, aujourdhui, debutGestion()).map((a) =>
      `${a}-01-01` === start.value && `${a}-12-31` === end.value
        ? charge_statement.value! : api.charge_statement({ building: period.building, start: `${a}-01-01`, end: `${a}-12-31` })))
    aRegulariser.value = decomptes.flatMap((x) => regularisationsManquantes(x, charge_adjustments.value, aujourdhui, debutGestion()))
      .sort((a, b) => a.start.localeCompare(b.start) || a.tenancy.unit.localeCompare(b.tenancy.unit))
    erreur.value = null
  } catch (e) {
    erreur.value = (e as Error).message
  }
}

onMounted(async () => {
  await pret
  await charger()
})
watch([immeubleId, start, end], charger)

// « 1 facture validée », « 17 factures validées »: singular and plural given whole
const nombre = (n: number, singulier: string, pluriel: string) => `${n} ${n > 1 ? pluriel : singulier}`

const etapes = computed<Etape[]>(() => {
  if (!charge_statement.value || !couverture.value) {
    return []
  }
  const d = charge_statement.value
  const c = couverture.value
  const query = `?start=${start.value}&end=${end.value}`

  // 1. Invoices touching the exercise
  const concernees = invoices.value.filter((f) => f.start && f.end && f.start <= end.value && f.end >= start.value)
  const brouillons = invoices.value.filter((f) => f.status === 'draft')
  const factureEtape: Etape = {
    number: 1, title: 'Factures', lien: '/factures',
    state: brouillons.length ? 'a-faire' : concernees.length ? 'ok' : 'attention',
    resume: `${nombre(concernees.filter((f) => f.status === 'validated').length, 'facture validée', 'factures validées')} sur l'exercice`
      + (brouillons.length ? ` · ${nombre(brouillons.length, 'brouillon', 'brouillons')} à vérifier puis valider` : ''),
    details: brouillons.map((f) => `Brouillon : ${f.supplier} n° ${f.number} du ${dateFr(f.invoice_date)}`),
  }

  // 2. Stays present during the exercise
  const presents = d.tenancies.filter((s) => s.days > 0)
  const transactions = presents.filter((s) => s.present_from !== start.value || s.present_to !== end.value)
  const sejourEtape: Etape = {
    number: 2, title: 'Locataires', lien: '/sejours',
    state: presents.length ? 'ok' : 'attention',
    resume: `${nombre(presents.length, 'séjour', 'séjours')} sur l'exercice`
      + (transactions.length ? ` · ${nombre(transactions.length, 'entrée ou sortie', 'entrées ou sorties')} en cours d'exercice` : ''),
    details: transactions.map((s) => `${s.tenant} (${s.unit}) : présent du ${dateFr(s.present_from)} au ${dateFr(s.present_to)}`),
  }

  // 3. Payments: provisions per stay and year, months without payment once monthly payments are recorded
  const manquantes = d.avertissements.filter((a) => a.startsWith('Aucune provision'))
  const avecMois = payments.value.filter((p) => p.month).map((p) => p.month!.slice(0, 7)).sort()
  const impayes: string[] = []
  if (avecMois[0]) {
    const finSuivi = [end.value.slice(0, 7), new Date().toISOString().slice(0, 7)].sort()[0]!
    for (const s of tenancies.value) {
      for (let m = avecMois[0]; m <= finSuivi; m = moisSuivant(m)) {
        const present = s.move_in <= `${m}-31` && (s.move_out === null || s.move_out >= `${m}-01`)
        if (present && m >= start.value.slice(0, 7) && !payments.value.some((p) => p.tenancy_id === s.id && p.month?.startsWith(m))) {
          impayes.push(`${s.tenant} (${s.unit}) : rien pour ${m.slice(5, 7)}/${m.slice(0, 4)}`)
        }
      }
    }
  }
  const provisionEtape: Etape = {
    number: 3, title: 'Paiements', lien: manquantes.length && !avecMois.length ? '/provisions' : '/paiements',
    state: manquantes.length ? 'a-faire' : impayes.length ? 'attention' : 'ok',
    resume: [
      manquantes.length ? `${nombre(manquantes.length, 'provision', 'provisions')} à saisir` : 'Provisions connues pour tous les séjours',
      ...(impayes.length ? [`${nombre(impayes.length, 'mois sans paiement', 'mois sans paiement')}`] : []),
    ].join(' · '),
    details: [...manquantes, ...impayes],
  }

  // 4. Bank: statements imported, movements categorised, payments seen on a statement
  const b = etatBanque(statements.value, mouvementsBanque.value, payments.value, start.value, end.value)
  const manquants = b.comptes.reduce((n, x) => n + x.manquants.length, 0)
  const banqueEtape: Etape = {
    number: 4, title: 'Banque', lien: b.aCategoriser.length || !statements.value.length ? '/banque' : `/controles${query}`,
    state: !statements.value.length ? 'attention' : manquants || b.finManquante || b.aCategoriser.length ? 'a-faire'
      : b.incomplets.length || b.sansMouvement.length ? 'attention' : 'ok',
    resume: !statements.value.length ? 'Aucun relevé importé' : [
      b.finManquante ? `relevés importés jusqu'au ${dateFr(b.finManquante)}` : manquants ? `${nombre(manquants, 'relevé manquant', 'relevés manquants')}` : 'Relevés à jour',
      b.aCategoriser.length ? `${nombre(b.aCategoriser.length, 'mouvement', 'mouvements')} à catégoriser` : 'tout est catégorisé',
      ...(b.incomplets.length ? [`${b.incomplets.length} à rattacher`] : []),
      ...(b.sansMouvement.length ? [`${nombre(b.sansMouvement.length, 'paiement absent', 'paiements absents')} des relevés`] : []),
    ].join(' · '),
    details: b.sansMouvement.map((p) => `Paiement du ${dateFr(p.payment_date)}, ${p.tenant} : sur aucun relevé`),
  }

  // 5. Checks: coverage, overlaps, drafts
  const trous = c.energies.flatMap((e) => e.trous.map((t) => ({ ...t, energy: e.energy })))
  const controleEtape: Etape = {
    number: 5, title: 'Contrôles', lien: `/controles${query}`,
    state: trous.length || c.brouillons.length ? 'a-faire' : c.chevauchements.length ? 'attention' : 'ok',
    resume: [
      trous.length ? `${nombre(trous.length, 'période', 'périodes')} sans facture validée` : 'Toute la période est facturée',
      c.chevauchements.length ? `${nombre(c.chevauchements.length, 'chevauchement', 'chevauchements')} à examiner` : 'aucun chevauchement',
    ].join(' · '),
    details: trous.map((t) => `${ENERGIES[t.energy]} : aucune facture validée du ${dateFr(t.start)} au ${dateFr(t.end)}`),
  }

  // 6. Statement
  const somme = (cle: 'total' | 'advances' | 'balance') =>
    d.tenancies.reduce((t, s) => t.plus(s[cle]), new Big(0)).toString()
  const decompteEtape: Etape = {
    number: 6, title: 'Décompte', lien: `/decompte${query}`,
    state: d.avertissements.some((a) => !a.includes('chevauchement')) ? 'attention' : 'ok',
    resume: `Charges des locataires ${euros(somme('total'))} · provisions ${euros(somme('advances'))} · `
      + `solde ${euros(somme('balance'))}`,
    details: [],
  }

  // 7. Regularisations of the exercise (current ones: not replaced)
  const courantes = charge_adjustments.value.filter((r) => r.start === start.value && r.end === end.value && !r.replaced_by)
  const envoyees = courantes.filter((r) => r.state !== 'draft')
  const enAttente = envoyees.filter(aEncaisser)
  // Missing over a finished year (this exercise or another): the creation page of the first one
  const manque = aRegulariser.value[0]
  const regularisationEtape: Etape = {
    // Stays still without a regularisation over the exercise: the creation page, else the list
    number: 7, title: 'Régularisations',
    lien: manque ? `/regularisations/nouvelle?start=${manque.start}&end=${manque.end}`
      : courantes.length < presents.length ? `/regularisations/nouvelle${query}` : '/regularisations',
    state: manque ? 'a-faire' : envoyees.length >= presents.length && presents.length ? 'ok' : courantes.length ? 'attention' : 'a-faire',
    resume: [
      ...(aRegulariser.value.length ? [nombre(aRegulariser.value.length, 'régularisation manquante', 'régularisations manquantes')] : []),
      `${nombre(envoyees.length, 'envoyée', 'envoyées')} sur ${nombre(presents.length, 'séjour', 'séjours')}`
        + (courantes.length > envoyees.length
          ? ` · ${nombre(courantes.length - envoyees.length, 'brouillon', 'brouillons')} à envoyer` : '')
        + (enAttente.length ? ` · ${enAttente.length} en attente de paiement ou de remboursement` : ''),
    ].join(' · '),
    details: [
      ...aRegulariser.value.map((m) => `Manquante : ${m.tenancy.tenant} (${m.tenancy.unit}), ${m.start.slice(0, 4)}`
        + (m.start.slice(0, 4) !== m.end.slice(0, 4) ? `-${m.end.slice(0, 4)}` : '') + ' : '
        + (new Big(m.tenancy.balance).gt(0) ? `${euros(m.tenancy.balance)} à réclamer`
          : new Big(m.tenancy.balance).lt(0) ? `${euros(new Big(m.tenancy.balance).neg().toString())} à rembourser` : 'solde nul')),
      ...enAttente.map((r) => `${r.tenant} : reste ${euros(new Big(r.balance).minus(r.amount_received).toString())}`),
    ],
  }

  // 8. Tax summary of the calendar year of the end of the exercise
  const anneeFiscale = Number(end.value.slice(0, 4))
  const fiscalEtape: Etape = {
    number: 8, title: 'Synthèse fiscale', lien: '/fiscal',
    state: 'ok',
    resume: `Charges non récupérées et vacance de ${anneeFiscale}, pour la déclaration de revenus fonciers`,
    details: [],
  }

  return [factureEtape, sejourEtape, provisionEtape, banqueEtape, controleEtape, decompteEtape, regularisationEtape, fiscalEtape]
})

function moisSuivant(m: string) {
  const [a, mm] = m.split('-').map(Number)
  return mm === 12 ? `${a! + 1}-01` : `${a}-${String(mm! + 1).padStart(2, '0')}`
}

const SYMBOLES: Record<Etat, string> = { ok: '✓', attention: '!', 'a-faire': '→' }
</script>

<template>
  <section class="entete-page">
    <h1>Accueil</h1>
    <ChoixExercice />
  </section>
  <p class="discret">
    Colibri répartit les charges des immeubles entre les locataires, au tantième et selon leurs jours de présence.
    Le travail suit un cycle par exercice (en général l'année civile) : choisir l'exercice, puis suivre les étapes.
  </p>
  <p v-if="erreur" class="message erreur">{{ erreur }}</p>

  <div class="cycle">
    <div class="phase">Tenue des comptes, au fil de l'année</div>
    <template v-for="e in etapes" :key="e.number">
      <div v-if="e.number === 5" class="phase">Bilan de l'exercice</div>
      <div v-if="e.number === 8" class="phase">Clôture</div>
      <RouterLink :to="e.lien" class="etape" :class="e.state">
        <span class="pastille-etape">{{ SYMBOLES[e.state] }}</span>
        <span class="numero">{{ e.number }}</span>
        <span class="contenu">
          <strong>{{ e.title }}</strong>
          <span>{{ e.resume }}</span>
          <ul v-if="e.details.length" class="details-etape">
            <li v-for="(d, i) in e.details.slice(0, 4)" :key="i">{{ d }}</li>
            <li v-if="e.details.length > 4">… et {{ e.details.length - 4 }} autre(s)</li>
          </ul>
        </span>
      </RouterLink>
    </template>
  </div>
  <p class="discret legende">
    <span class="ok">✓</span> fait · <span class="attention">!</span> à regarder · <span class="ko">→</span> à faire
  </p>

  <h2>Mode d'emploi</h2>

  <details>
    <summary><strong>Mise en place</strong> (une fois) : Immeuble, Locataires</summary>
    <ol>
      <li>Pour un autre immeuble : ⚙ Réglages › Immeuble › « + Nouvel immeuble », puis le choisir en haut à
        droite ; chaque écran travaille ensuite sur l'immeuble choisi.</li>
      <li><strong>Immeuble</strong> (menu ⚙ Réglages) : vérifier les lots et leurs tantièmes ; le total sert de diviseur
        à toute la répartition. Changer des tantièmes modifie aussi les décomptes passés.</li>
      <li><strong>Locataires</strong> : « + Nouveau locataire » ouvre la fiche : nom, e-mail (pour les mails de
        régularisation), téléphone, puis son séjour : lot, date d'entrée, date de sortie (vide tant que le locataire est
        là), dépôt de garantie prévu au bail, et le loyer et la provision appelés chaque mois (une ligne par changement,
        pour garder l'historique). Deux séjours ne peuvent pas se chevaucher sur un même lot. Un ancien locataire qui
        revient se choisit dans « Fiche » au lieu de « Nouveau locataire ».</li>
      <li><strong>Dépôt de garantie</strong> : l'encadré du même nom, dans la fiche d'un séjour enregistré (ses
        opérations sont enregistrées aussitôt, sans le bouton « Enregistrer » de la fiche). « Dépôt reçu… » et
        « Restitution… » : date, montant, virement de la banque (ou aucun : versé à l'agence, avant les relevés).
        « Retenue… » : au départ, ce que le dépôt couvre de ce que le locataire doit encore (mois impayés, régularisations
        envoyées), proposé du plus ancien au plus récent ; ces montants deviennent des paiements « retenue sur dépôt »,
        verrouillés ailleurs, jamais attendus à la banque. Le reste d'une régularisation non couverte se clôt ensuite par
        la décision « irrécouvrable ».</li>
    </ol>
  </details>

  <details>
    <summary><strong>1. Factures</strong> : importer ou saisir, vérifier, valider</summary>
    <ol>
      <li>Déposer les PDF sur la page : le navigateur les lit avec l'extracteur de leur fournisseur (EDF, ENGIE, taxe
        foncière… voir <strong>Fournisseurs</strong>) et chaque facture devient un <em>brouillon</em> avec ses lignes.
        Une facture déjà importée est refusée. Ce que l'extracteur ne trouve pas (le total de la taxe foncière, sur un
        autre PDF) se saisit dans le brouillon.</li>
      <li>Sans PDF, ou si aucun extracteur ne lit le PDF (eau reçue sur papier, scan) : <strong>+ Saisir une
        facture</strong> (ou « Saisir à la main avec ce PDF » sous le fichier refusé) crée un brouillon avec son
        en-tête ; ses lignes se saisissent dans la même grille.</li>
      <li>Chaque ligne a une <em>affectation</em> : <em>récupérable</em> (répartie entre les locataires),
        <em>propriétaire</em> (pénalités, taxe foncière hors ordures ménagères : dans la synthèse fiscale) ou
        <em>hors immeuble</em> (un autre bien sur la même facture, comme les garages sur l'avis de taxe foncière).</li>
      <li>Ouvrir le brouillon : la grille montre chaque ligne avec sa période ; le PDF est à côté pour comparer. Corriger
        une cellule, coller des lignes depuis Excel, ajouter ou supprimer une ligne si besoin.</li>
      <li><strong>Version locataire</strong> : une facture n'est jamais jointe au justificatif telle qu'elle a été
        reçue, mais dans sa version locataire, en images noir et blanc, où sont masqués le nom et l'adresse du gérant,
        les références client, le compte bancaire (termes de l'écran <strong>Fournisseurs</strong>, et ce que masque
        l'extracteur du fournisseur). Elle est créée à l'import (« Créer la version locataire » pour une facture saisie
        avec son PDF). L'afficher (« Version locataire », à côté de « Facture reçue »), la contrôler page par page,
        puis <strong>Rien de personnel : à joindre</strong>. S'il reste quelque chose : « Il reste une information
        personnelle… », recopier le texte (masqué ensuite sur toutes les factures) et « Masquer et recréer » ; pour un
        texte qui change à chaque facture ou un scan, « Modifier le masquage du fournisseur ». Seule une version
        contrôlée est jointe.</li>
      <li>Les contrôles tournent en direct : en rouge ce qui bloque (total qui ne retombe pas sur le montant imprimé,
        date invalide…), en jaune ce qui est à vérifier (période non imprimée, période inhabituelle).</li>
      <li><strong>Valider</strong> : seule une facture validée compte dans les décomptes. Une facture validée n'est plus
        modifiable.</li>
      <li>Une facture validée fausse ou en double ne se modifie pas : elle se <strong>remplace</strong>, avec une trace.
        <strong>Corriger…</strong> crée un brouillon, copie de la facture, qui la remplace à sa validation (jusque-là,
        l'originale compte) ; <strong>Remplacer par…</strong> la remplace par une autre facture validée (facture
        rectificative, vrai PDF d'une facture saisie à la main), avec le motif. La facture remplacée reste consultable
        (« Afficher les factures remplacées ») mais ne compte plus ; les régularisations envoyées touchées sont
        listées, l'écran Régularisations dit si l'une est « à rectifier ».</li>
      <li>Une facture validée est <strong>payée</strong> quand un mouvement bancaire la règle : colonne « Payée » de la
        liste (✓ et la date, partielle avec son reste, ou à payer ; « Seulement celles à payer »). Le prélèvement se
        rattache depuis la facture (« Rattacher un paiement… », les débits du même montant d'abord) ou depuis la Banque ;
        une facture payée en deux fois a deux paiements. Une facture remplacée passe ses paiements à celle qui la
        remplace.</li>
    </ol>
  </details>

  <details>
    <summary><strong>2. Locataires</strong> : tenir les entrées et sorties à jour</summary>
    <p>À chaque départ, cliquer la ligne du locataire et saisir sa date de sortie ; à chaque arrivée, « + Nouveau
      locataire ». La frise par lot montre les périodes occupées ; un trou est de la vacance, dont les charges restent au
      propriétaire. Supprimer un séjour supprime aussi la fiche du locataire s'il n'en a pas d'autre.</p>
  </details>

  <details>
    <summary><strong>3. Paiements</strong> : loyers et provisions reçus</summary>
    <ol>
      <li>Écran Paiements : <strong>une ligne par paiement reçu</strong> (virement, chèque…). « + Ajouter un
        paiement » ouvre le formulaire ; le choix du locataire reprend les montants de son dernier mois payé.
        Indiquer le montant du relevé, puis le répartir entre loyer, provision et régularisation : le paiement ne
        s'enregistre que si la répartition retombe sur le montant (✓). « Ajouter et en saisir un autre » garde la
        date et le mode, pour les lignes d'un même relevé.</li>
      <li>Un versement de régularisation (ou un remboursement, montant négatif) se saisit dans le même formulaire, en
        choisissant la régularisation concernée, ou seul avec loyer et provision vides. Cliquer une ligne pour la
        modifier ou la supprimer ; filtres par année, locataire, type.</li>
      <li>La colonne <strong>Banque</strong> coche un paiement vu sur un relevé (écran Banque) ; la coche ouvre son
        mouvement. Le filtre « Rapprochés / Non rapprochés » montre ceux qui manquent sur les relevés.</li>
      <li>Les provisions d'une année sont la somme de ses paiements. Pour les années d'avant (2024, 2025…), le total
        annuel se saisit dans « totaux annuels (historique) ».</li>
    </ol>
  </details>

  <details>
    <summary><strong>4. Banque</strong> : relevés bancaires, catégorisation des mouvements</summary>
    <ol>
      <li><strong>Banque › Relevés bancaires</strong> : déposer les relevés PDF ; l'extracteur de la banque (voir
        <strong>Fournisseurs</strong>) les lit dans le navigateur, et un relevé n'est enregistré que si solde précédent +
        crédits − débits retombe au centime sur le nouveau solde. La liste signale un relevé manquant. Ouvrir un relevé
        montre son PDF à côté des mouvements lus, pour vérifier la lecture (une erreur se corrige dans l'extracteur, puis
        on supprime et réimporte le relevé).</li>
      <li><strong>Banque › Catégorisation des mouvements</strong>, onglet « À catégoriser » : chaque mouvement reçoit une
        catégorie (paiement de locataire, travaux, dépôt de garantie, emprunt, assurance, énergie, frais bancaires,
        associés…). Le bouton bleu de la
        colonne « Proposition » donne la catégorie proposée (lue dans le libellé, le locataire nommé, ou un paiement ou des
        travaux déjà saisis qui lui correspondent) ; « Autre catégorie » ouvre la liste. « Accepter les N propositions »
        catégorise d'un coup.</li>
      <li>Onglet « Rapprochement » : un <strong>paiement de locataire</strong>, des <strong>travaux</strong>, un
        <strong>dépôt de garantie</strong> et un prélèvement d'<strong>énergie</strong>, d'<strong>eau</strong> ou
        d'<strong>impôts et taxes</strong> se rattachent à ce qu'ils paient ; la flèche ▸ déplie leur détail.
        « Seulement ceux à rattacher » (cochée d'office) ne montre que ceux dont le détail ne couvre pas le montant. « Ajouter un paiement du locataire… »
        ouvre la fenêtre de l'écran Paiements, préremplie (locataire, mois, loyer et provision du séjour encore dus,
        montant restant) : un reste reste à rattacher. « Dépôt de garantie… » ouvre le dépôt du séjour (écran
        Locataires), ce virement prérempli : le dépôt se saisit là, comme une facture dans son écran. Des travaux :
        la facture se saisit d'abord (écran Travaux), puis « Rattacher à une facture de travaux… » y accroche le virement
        (un acompte, puis le solde : deux virements pour une facture). « Rattacher… » reprend ce qui a été saisi (ce qui
        correspond est marqué ✓ et choisi d'office, une alerte signale un montant ou une date qui diffère). Un mouvement
        reste « à rattacher » tant que son détail ne couvre pas son montant (une note n'y suffit pas) ; ceux-là viennent
        en tête ; ✕ retire la catégorie.</li>
      <li>Un prélèvement d'énergie, d'eau ou de taxe se rattache à sa facture (« Rattacher à une facture… ») : la
        facture se saisit d'abord (écran Factures, sur son immeuble). Quand une facture validée a son montant, la
        proposition de l'onglet « À catégoriser » dit « + facture » et la rattache en même temps ; un virement qui porte
        le numéro de la facture est proposé aussi (eau payée en deux fois).</li>
      <li>Onglet « Autres catégories » : emprunt, assurance, frais bancaires… une catégorie suffit.</li>
    </ol>
  </details>

  <details>
    <summary><strong>5. Contrôles</strong> : rien d'oublié, rien de compté deux fois</summary>
    <p>Pour l'exercice choisi, chaque énergie doit être couverte par des factures validées du premier au dernier jour.
      Un <em>trou</em> signale une facture manquante ou encore en brouillon ; un <em>chevauchement</em>, une période
      facturée deux fois. À régler avant de calculer le décompte. Le bloc « Paiements » compare chaque mois le loyer et
      la provision reçus au montant appelé (fiche du locataire) : payé, payé en partie (en orange), rien reçu (✗), et
      le reste dû par locataire. Le bloc « Banque » liste les relevés manquants, les mouvements à catégoriser ou à
      compléter (un loyer reçu mais pas saisi, une facture de travaux à saisir) et les paiements de l'exercice
      qu'aucun relevé ne montre (saisie en double, paiement par l'agence, ou jamais reçu).</p>
  </details>

  <details>
    <summary><strong>6. Décompte</strong> : ce que doit chaque locataire</summary>
    <p>Une ligne par séjour : quote-part par énergie, total, provisions, solde (positif : à payer ; négatif : à
      rembourser). Cliquer sur un montant montre les lignes de facture qui le composent et le calcul. Les avertissements
      en tête signalent ce qui pourrait fausser le résultat. « Exporter en Excel » produit le fichier pour
      l'expert-comptable.</p>
  </details>

  <details>
    <summary><strong>7. Régularisations</strong> : figer, envoyer, corriger</summary>
    <ol>
      <li>L'écran liste toutes les régularisations, quelle que soit leur période, avec des filtres par période, état et
        locataire. « + Nouvelle
        régularisation » : choisir la période (une année, ou « Autre période… » pour 2024-2025 par exemple), vérifier
        le décompte et l'aperçu PDF de chaque locataire, puis <strong>Créer</strong> : les montants sont figés, le
        justificatif ne changera plus. Une régularisation envoyée avant Colibri se saisit sur la même page.</li>
      <li><strong>Régularisations manquantes</strong> : l'étape 7 ci-dessus et le bloc Régularisations des Contrôles
        signalent tout locataire présent sur une année terminée (depuis la première régularisation de l'immeuble) sans
        régularisation qui la couvre, que le solde du décompte soit à réclamer, à rembourser ou nul. Un séjour sans
        charges ni provisions n'en a pas besoin.</li>
      <li>Cliquer une régularisation ouvre sa fiche. <strong>Mail</strong> : le texte est prêt (étalement, nouvelle
        provision, signature) ; le relire, l'ouvrir dans la messagerie, joindre le PDF (le justificatif, puis la version
        locataire des factures en annexe ; celles d'un fournisseur confidentiel ou sans version contrôlée sont signalées
        « non jointe » : la fiche les liste avant l'envoi), envoyer, puis
        <strong>Marquer envoyée</strong> (« annuler l'envoi »
        reste possible tant qu'aucun versement n'est arrivé).</li>
      <li>La colonne « Écart avec le décompte » refait le décompte de chaque régularisation sur sa période :
        <strong>À rectifier</strong> (en orange, avec le montant) quand il a changé de 5 € ou plus depuis l'envoi
        (facture ajoutée ou corrigée, paiements saisis…) ; le filtre « À rectifier » les rassemble. Dans la fiche,
        <strong>Rectificatif</strong> recalcule sur le décompte actuel et prépare le mail d'excuses avec le montant
        initial, le montant corrigé et les versements déjà faits. La fiche garde l'historique des rectificatifs.</li>
      <li>Quand le locataire paie (ou quand tu rembourses, montant négatif) : le saisir dans
        <strong>Paiements</strong>, avec le reste du paiement ; la fiche montre les versements, le total reçu et le
        reste. L'état se calcule tout seul : <em>brouillon</em> tant qu'elle n'est pas envoyée, <em>en attente</em>, puis
        <em>soldée</em> quand le reste tombe à zéro (à 1 € près). La seule chose à décider, dans la fiche : abandonner
        le reste (charge offerte) ou le déclarer irrécouvrable.</li>
    </ol>
  </details>

  <details>
    <summary><strong>Travaux</strong> (tenue des comptes) : factures de travaux du propriétaire</summary>
    <p>Écran Travaux : « + Ajouter une facture de travaux » (fournisseur, description, nature, logement ou parties
      communes, date, montant, PDF). Elle est payée par les virements de la banque qu'on lui rattache, depuis la facture
      (« Rattacher un virement… ») ou depuis la catégorisation des mouvements : payé, c'est vu à la banque. Les travaux
      ne sont jamais répartis entre les locataires : ils servent à la déclaration. Entretien, réparation et amélioration
      sont déductibles (2044, ligne 224), chaque virement l'année où il est passé ; construction et agrandissement non.
      La synthèse fiscale les reprend.</p>
  </details>

  <details>
    <summary><strong>8. Synthèse fiscale</strong> : pour la déclaration de revenus fonciers</summary>
    <p>Pour une année civile : charges de la vacance, charges restées impayées par les locataires partis dans l'année
      (sur tout leur séjour, versements reçus au 31 décembre), dépôts de garantie conservés pour charges : la part de la
      retenue sur le dépôt qui couvre des régularisations (fiche du séjour, encadré « Dépôt de garantie »). Méthode à faire valider par
      l'expert-comptable.</p>
  </details>

  <details>
    <summary><strong>SCI</strong> : société, associés, assemblées générales</summary>
    <ol>
      <li>« Société et associés » (menu ⚙ Réglages) : la dénomination, le capital, le siège, le RCS, et les associés avec leurs parts et
        le gérant ; repris en tête des procès-verbaux.</li>
      <li>« Assemblées » (menu Clôture) : « + Nouvelle assemblée » (annuelle : ordre du jour et résolutions habituelles proposés,
        approbation des comptes, répartition du résultat au prorata des parts, quitus, pouvoirs). Dans le brouillon :
        présences, texte des résolutions (compléter le montant du résultat), votes ; « Projet de procès-verbal »
        pour le relire.</li>
      <li><strong>Clore l'assemblée</strong> : elle reçoit le numéro suivant du registre et son procès-verbal est figé
        (plus de modification possible). Imprimer le procès-verbal, le faire signer, puis « Joindre le PV signé ».</li>
    </ol>
  </details>

  <details>
    <summary><strong>Mon compte</strong> (menu ⚙ Réglages) : passkeys, autres appareils, jetons d'API</summary>
    <p>On se connecte par passkey : l'empreinte, le visage ou le code de l'appareil, sans mot de passe. « Mon compte »
      liste vos passkeys ; « Ajouter une passkey ici » en crée une sur cet appareil, « Ajouter un autre appareil »
      affiche un QR code (valable 15 minutes, une seule fois) que le téléphone scanne pour créer la sienne. Gardez au
      moins deux appareils. Les jetons d'API servent aux scripts ; « Se déconnecter » ferme la session.</p>
  </details>

  <details>
    <summary><strong>Fournisseurs</strong> (menu ⚙ Réglages) : extracteurs, factures confidentielles, termes masqués</summary>
    <ol>
      <li>La liste montre chaque fournisseur, ses factures et la version de son extracteur. Sur la page d'un
        fournisseur : <strong>Confidentiel</strong> (ses factures, comme l'avis de taxe foncière, ne sont jamais jointes
        au justificatif d'une régularisation : elles y sont listées, « consultable sur demande »), et les versions de
        son extracteur, d'où s'ouvre l'éditeur (« Écrire un extracteur » s'il n'en a pas).</li>
      <li><strong>Termes masqués</strong> (bas de la liste) : un par ligne, cherchés dans toutes les factures pour leur
        version locataire (espaces et majuscules ignorés). Ce qui est propre à un fournisseur (références
        client fixes, point de livraison) peut aussi y aller. Dans l'éditeur, l'onglet <strong>Masquage</strong> montre
        en noir, dans le texte du PDF d'exemple, ce qui sera caché ; sélectionner un texte l'ajoute aux termes masqués.
        Seul ce qui change d'une facture à l'autre (un motif) demande du code : la méthode
        <code>redactions()</code> (« Ajouter redactions() au code »). « Vérifier le masquage… » montre la version locataire
        du PDF de travail. Après un changement, « Recréer les versions locataire » sur la page du fournisseur, puis les
        contrôler.</li>
      <li><strong>Zones tracées à la main</strong> : le texte lu par le scanner n'est pas fiable, une page scannée n'est
        masquée que par des zones tracées à la souris ; sur une page de texte, elles masquent ce que la recherche ne
        trouve pas (une image, un QR code) et s'ajoutent aux termes et à l'extracteur. Sur la page du fournisseur,
        « Zones masquées à la main » : choisir une de ses factures, tracer les zones (les déplacer, les redimensionner
        par le coin, les retirer avec × ou Suppr), les enregistrer, puis recréer les versions locataire. Sur une facture,
        « Il reste une information personnelle » permet de les ajuster pour elle seule.</li>
      <li>Un extracteur lit les PDF d'un fournisseur : une classe TypeScript qui étend <code>InvoiceExtractor</code>,
        surtout des expressions régulières, une méthode par information (reconnaître le PDF, numéro, date, total ;
        pour les lignes : où chercher, quelles lignes, comment lire chacune).</li>
      <li>Dans l'éditeur (ou « Nouveau fournisseur », modèle commenté), onglet <strong>Extraction</strong> : à droite du
        code, le texte du PDF de travail (« Changer… » en haut : une facture du fournisseur ou un autre PDF, et le
        regroupement en lignes) tel que l'extracteur le reçoit, avec ce que le code trouve surligné (une ligne trouvée
        mais mal lue en rouge) ; en dessous, un résumé en direct. « Agrandir » met le code et le texte en plein
        écran.</li>
      <li>Avant d'enregistrer, « Vérifier l'extraction… » relance le code sur les PDF des factures déjà en base de ce
        fournisseur (✓ ou ✗ pour chacune, et ce qui change ; cliquer une facture la prend comme PDF de travail) et
        détaille ce qu'il lit du PDF de travail.</li>
      <li>Une version enregistrée ne change plus : la corriger, c'est enregistrer la suivante. Chaque facture garde la
        version qui l'a lue ; seule la dernière version d'un fournisseur sert à l'import.</li>
    </ol>
  </details>
</template>

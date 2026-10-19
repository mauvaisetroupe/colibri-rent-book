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
type Etape = { numero: number, titre: string, lien: string, etat: Etat, resume: string, details: string[] }

const { immeubleId, pret } = useImmeuble()
const { debut, fin } = useExercice()
const factures = ref<FactureResumee[]>([])
const decompte = ref<Decompte | null>(null)
const couverture = ref<Couverture | null>(null)
const regularisations = ref<Regularisation[]>([])
const paiements = ref<Paiement[]>([])
const sejours = ref<Sejour[]>([])
const releves = ref<ReleveResume[]>([])
const mouvementsBanque = ref<Mouvement[]>([])
// Missing regularisations of every finished year, not only of the exercise chosen
const aRegulariser = ref<Manquante[]>([])
const erreur = ref<string | null>(null)

async function charger() {
  if (immeubleId.value === null) {
    return
  }
  const exercice = { immeuble: immeubleId.value, debut: debut.value, fin: fin.value }
  try {
    const annees = [...new Set([Number(debut.value.slice(0, 4)), Number(fin.value.slice(0, 4))])]
    let lus: Paiement[][]
    ;[factures.value, decompte.value, couverture.value, regularisations.value, sejours.value, releves.value,
      mouvementsBanque.value, ...lus] = await Promise.all([
      api.factures(exercice.immeuble), api.decompte(exercice), api.couverture(exercice),
      api.regularisations(exercice.immeuble), api.sejours(exercice.immeuble), api.releves(),
      api.mouvements('tous', exercice.debut, exercice.fin),
      ...annees.map((a) => api.paiements(exercice.immeuble, a)),
    ])
    paiements.value = lus.flat()
    const aujourdhui = new Date().toISOString().slice(0, 10)
    // Calendar years only (the statement of the exercise chosen when it is one of them)
    const decomptes = await Promise.all(anneesARegulariser(regularisations.value, aujourdhui).map((a) =>
      `${a}-01-01` === debut.value && `${a}-12-31` === fin.value
        ? decompte.value! : api.decompte({ immeuble: exercice.immeuble, debut: `${a}-01-01`, fin: `${a}-12-31` })))
    aRegulariser.value = decomptes.flatMap((x) => regularisationsManquantes(x, regularisations.value, aujourdhui))
      .sort((a, b) => a.debut.localeCompare(b.debut) || a.sejour.lot.localeCompare(b.sejour.lot))
    erreur.value = null
  } catch (e) {
    erreur.value = (e as Error).message
  }
}

onMounted(async () => {
  await pret
  await charger()
})
watch([immeubleId, debut, fin], charger)

// « 1 facture validée », « 17 factures validées »: singular and plural given whole
const nombre = (n: number, singulier: string, pluriel: string) => `${n} ${n > 1 ? pluriel : singulier}`

const etapes = computed<Etape[]>(() => {
  if (!decompte.value || !couverture.value) {
    return []
  }
  const d = decompte.value
  const c = couverture.value
  const query = `?debut=${debut.value}&fin=${fin.value}`

  // 1. Invoices touching the exercise
  const concernees = factures.value.filter((f) => f.debut && f.fin && f.debut <= fin.value && f.fin >= debut.value)
  const brouillons = factures.value.filter((f) => f.statut === 'a_verifier')
  const factureEtape: Etape = {
    numero: 1, titre: 'Factures', lien: '/factures',
    etat: brouillons.length ? 'a-faire' : concernees.length ? 'ok' : 'attention',
    resume: `${nombre(concernees.filter((f) => f.statut === 'validee').length, 'facture validée', 'factures validées')} sur l'exercice`
      + (brouillons.length ? ` · ${nombre(brouillons.length, 'brouillon', 'brouillons')} à vérifier puis valider` : ''),
    details: brouillons.map((f) => `Brouillon : ${f.fournisseur} n° ${f.numero} du ${dateFr(f.date_facture)}`),
  }

  // 2. Stays present during the exercise
  const presents = d.sejours.filter((s) => s.jours > 0)
  const mouvements = presents.filter((s) => s.present_du !== debut.value || s.present_au !== fin.value)
  const sejourEtape: Etape = {
    numero: 2, titre: 'Locataires', lien: '/sejours',
    etat: presents.length ? 'ok' : 'attention',
    resume: `${nombre(presents.length, 'séjour', 'séjours')} sur l'exercice`
      + (mouvements.length ? ` · ${nombre(mouvements.length, 'entrée ou sortie', 'entrées ou sorties')} en cours d'exercice` : ''),
    details: mouvements.map((s) => `${s.locataire} (${s.lot}) : présent du ${dateFr(s.present_du)} au ${dateFr(s.present_au)}`),
  }

  // 3. Payments: provisions per stay and year, months without payment once monthly payments are recorded
  const manquantes = d.avertissements.filter((a) => a.startsWith('Aucune provision'))
  const avecMois = paiements.value.filter((p) => p.mois).map((p) => p.mois!.slice(0, 7)).sort()
  const impayes: string[] = []
  if (avecMois[0]) {
    const finSuivi = [fin.value.slice(0, 7), new Date().toISOString().slice(0, 7)].sort()[0]!
    for (const s of sejours.value) {
      for (let m = avecMois[0]; m <= finSuivi; m = moisSuivant(m)) {
        const present = s.entree <= `${m}-31` && (s.sortie === null || s.sortie >= `${m}-01`)
        if (present && m >= debut.value.slice(0, 7) && !paiements.value.some((p) => p.sejour_id === s.id && p.mois?.startsWith(m))) {
          impayes.push(`${s.locataire} (${s.lot}) : rien pour ${m.slice(5, 7)}/${m.slice(0, 4)}`)
        }
      }
    }
  }
  const provisionEtape: Etape = {
    numero: 3, titre: 'Paiements', lien: manquantes.length && !avecMois.length ? '/provisions' : '/paiements',
    etat: manquantes.length ? 'a-faire' : impayes.length ? 'attention' : 'ok',
    resume: [
      manquantes.length ? `${nombre(manquantes.length, 'provision', 'provisions')} à saisir` : 'Provisions connues pour tous les séjours',
      ...(impayes.length ? [`${nombre(impayes.length, 'mois sans paiement', 'mois sans paiement')}`] : []),
    ].join(' · '),
    details: [...manquantes, ...impayes],
  }

  // 4. Bank: statements imported, movements categorised, payments seen on a statement
  const b = etatBanque(releves.value, mouvementsBanque.value, paiements.value, debut.value, fin.value)
  const manquants = b.comptes.reduce((n, x) => n + x.manquants.length, 0)
  const banqueEtape: Etape = {
    numero: 4, titre: 'Banque', lien: b.aCategoriser.length || !releves.value.length ? '/banque' : `/controles${query}`,
    etat: !releves.value.length ? 'attention' : manquants || b.finManquante || b.aCategoriser.length ? 'a-faire'
      : b.incomplets.length || b.sansMouvement.length ? 'attention' : 'ok',
    resume: !releves.value.length ? 'Aucun relevé importé' : [
      b.finManquante ? `relevés importés jusqu'au ${dateFr(b.finManquante)}` : manquants ? `${nombre(manquants, 'relevé manquant', 'relevés manquants')}` : 'Relevés à jour',
      b.aCategoriser.length ? `${nombre(b.aCategoriser.length, 'mouvement', 'mouvements')} à catégoriser` : 'tout est catégorisé',
      ...(b.incomplets.length ? [`${b.incomplets.length} à compléter`] : []),
      ...(b.sansMouvement.length ? [`${nombre(b.sansMouvement.length, 'paiement absent', 'paiements absents')} des relevés`] : []),
    ].join(' · '),
    details: b.sansMouvement.map((p) => `Paiement du ${dateFr(p.date_paiement)}, ${p.locataire} : sur aucun relevé`),
  }

  // 5. Checks: coverage, overlaps, drafts
  const trous = c.energies.flatMap((e) => e.trous.map((t) => ({ ...t, energie: e.energie })))
  const controleEtape: Etape = {
    numero: 5, titre: 'Contrôles', lien: `/controles${query}`,
    etat: trous.length || c.brouillons.length ? 'a-faire' : c.chevauchements.length ? 'attention' : 'ok',
    resume: [
      trous.length ? `${nombre(trous.length, 'période', 'périodes')} sans facture validée` : 'Toute la période est facturée',
      c.chevauchements.length ? `${nombre(c.chevauchements.length, 'chevauchement', 'chevauchements')} à examiner` : 'aucun chevauchement',
    ].join(' · '),
    details: trous.map((t) => `${ENERGIES[t.energie]} : aucune facture validée du ${dateFr(t.debut)} au ${dateFr(t.fin)}`),
  }

  // 6. Statement
  const somme = (cle: 'total' | 'provisions' | 'solde') =>
    d.sejours.reduce((t, s) => t.plus(s[cle]), new Big(0)).toString()
  const decompteEtape: Etape = {
    numero: 6, titre: 'Décompte', lien: `/decompte${query}`,
    etat: d.avertissements.some((a) => !a.includes('chevauchement')) ? 'attention' : 'ok',
    resume: `Charges des locataires ${euros(somme('total'))} · provisions ${euros(somme('provisions'))} · `
      + `solde ${euros(somme('solde'))}`,
    details: [],
  }

  // 7. Regularisations of the exercise (current ones: not replaced)
  const courantes = regularisations.value.filter((r) => r.debut === debut.value && r.fin === fin.value && !r.remplacee_par)
  const envoyees = courantes.filter((r) => r.etat !== 'brouillon')
  const enAttente = envoyees.filter(aEncaisser)
  // Missing over a finished year (this exercise or another): the creation page of the first one
  const manque = aRegulariser.value[0]
  const regularisationEtape: Etape = {
    // Stays still without a regularisation over the exercise: the creation page, else the list
    numero: 7, titre: 'Régularisations',
    lien: manque ? `/regularisations/nouvelle?debut=${manque.debut}&fin=${manque.fin}`
      : courantes.length < presents.length ? `/regularisations/nouvelle${query}` : '/regularisations',
    etat: manque ? 'a-faire' : envoyees.length >= presents.length && presents.length ? 'ok' : courantes.length ? 'attention' : 'a-faire',
    resume: [
      ...(aRegulariser.value.length ? [nombre(aRegulariser.value.length, 'régularisation manquante', 'régularisations manquantes')] : []),
      `${nombre(envoyees.length, 'envoyée', 'envoyées')} sur ${nombre(presents.length, 'séjour', 'séjours')}`
        + (courantes.length > envoyees.length
          ? ` · ${nombre(courantes.length - envoyees.length, 'brouillon', 'brouillons')} à envoyer` : '')
        + (enAttente.length ? ` · ${enAttente.length} en attente de paiement ou de remboursement` : ''),
    ].join(' · '),
    details: [
      ...aRegulariser.value.map((m) => `Manquante : ${m.sejour.locataire} (${m.sejour.lot}), ${m.debut.slice(0, 4)}`
        + (m.debut.slice(0, 4) !== m.fin.slice(0, 4) ? `-${m.fin.slice(0, 4)}` : '') + ' : '
        + (new Big(m.sejour.solde).gt(0) ? `${euros(m.sejour.solde)} à réclamer`
          : new Big(m.sejour.solde).lt(0) ? `${euros(new Big(m.sejour.solde).neg().toString())} à rembourser` : 'solde nul')),
      ...enAttente.map((r) => `${r.locataire} : reste ${euros(new Big(r.solde).minus(r.montant_recu).toString())}`),
    ],
  }

  // 8. Tax summary of the calendar year of the end of the exercise
  const anneeFiscale = Number(fin.value.slice(0, 4))
  const fiscalEtape: Etape = {
    numero: 8, titre: 'Synthèse fiscale', lien: '/fiscal',
    etat: 'ok',
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
    <template v-for="e in etapes" :key="e.numero">
      <div v-if="e.numero === 5" class="phase">Bilan de l'exercice</div>
      <div v-if="e.numero === 8" class="phase">Clôture</div>
      <RouterLink :to="e.lien" class="etape" :class="e.etat">
        <span class="pastille-etape">{{ SYMBOLES[e.etat] }}</span>
        <span class="numero">{{ e.numero }}</span>
        <span class="contenu">
          <strong>{{ e.titre }}</strong>
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
      <li><strong>Dépôt de garantie</strong> : le bouton « Dépôt… » d'un séjour ouvre son dépôt. « Dépôt reçu… » et
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
      <li>Onglet « Catégorisés » : un <strong>paiement de locataire</strong>, des <strong>travaux</strong> et un
        <strong>dépôt de garantie</strong> ont un détail ; la flèche ▸ le déplie. « Ajouter un paiement du locataire… »
        ouvre la fenêtre de l'écran Paiements, préremplie (locataire, mois, loyer et provision du séjour encore dus,
        montant restant) : un reste reste à rattacher. « Dépôt de garantie… » ouvre le dépôt du séjour (écran
        Locataires), ce virement prérempli : le dépôt se saisit là, comme une facture dans son écran. Des travaux :
        la facture se saisit d'abord (écran Travaux), puis « Rattacher à une facture de travaux… » y accroche le virement
        (un acompte, puis le solde : deux virements pour une facture). « Rattacher… » reprend ce qui a été saisi (ce qui
        correspond est marqué ✓ et choisi d'office, une alerte signale un montant ou une date qui diffère). Un mouvement
        reste « à compléter » tant que son détail ne couvre pas son montant (une note n'y suffit pas) ; ceux-là viennent
        en tête ; ✕ retire la catégorie.</li>
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
        provision, signature) ; le relire, l'ouvrir dans la messagerie, joindre le PDF (le justificatif, puis les
        factures en annexe, sauf celles d'un fournisseur confidentiel, signalées), envoyer, puis
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
      retenue sur le dépôt qui couvre des régularisations (Locataires, « Dépôt… »). Méthode à faire valider par
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
    <summary><strong>Fournisseurs</strong> (menu ⚙ Réglages) : extracteurs, factures confidentielles</summary>
    <ol>
      <li>La liste montre chaque fournisseur, ses factures et la version de son extracteur. Sur la page d'un
        fournisseur : <strong>Confidentiel</strong> (ses factures, comme l'avis de taxe foncière, ne sont jamais jointes
        au justificatif d'une régularisation : elles y sont listées, « consultable sur demande »), et les versions de
        son extracteur, d'où s'ouvre l'éditeur (« Écrire un extracteur » s'il n'en a pas).</li>
      <li>Un extracteur lit les PDF d'un fournisseur : une classe TypeScript qui étend <code>InvoiceExtractor</code>,
        surtout des expressions régulières, une méthode par information (reconnaître le PDF, numéro, date, total ;
        pour les lignes : où chercher, quelles lignes, comment lire chacune).</li>
      <li>Dans l'éditeur (ou « Nouveau fournisseur », modèle commenté) : à droite, le texte du PDF
        d'exemple ligne par ligne, tel que l'extracteur le reçoit, avec ce que le code trouve surligné (une ligne
        trouvée mais mal lue en rouge) ; en dessous, le résultat en direct : chaque champ, les lignes lues, la somme
        comparée au total. « Agrandir » met le code et le texte en plein écran.</li>
      <li>Avant d'enregistrer, « Tester sur les factures » relance la version sur les PDF des factures déjà en base de
        ce fournisseur : ✓ ou ✗ pour chacune, et ce qui change.</li>
      <li>Une version enregistrée ne change plus : la corriger, c'est enregistrer la suivante. Chaque facture garde la
        version qui l'a lue ; seule la dernière version d'un fournisseur sert à l'import.</li>
    </ol>
  </details>
</template>

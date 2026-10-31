<script setup lang="ts">
import Big from 'big.js'
import { computed, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'

import {
  api, DECISIONS_REGULARISATION, libelleRegularisation, NOMS_MODES, type Decompte, type Paiement, type Regularisation,
  type RegularisationDetail,
} from '../api'
import RedactionMail from '../components/RedactionMail.vue'
import { dateFr, euros } from '../format'
import { comparer, decomptesDesPeriodes, SEUIL_RECTIFICATION } from '../rectification'

// One regularisation (ADR 0007, 0008): its frozen amounts and status, the payments received (entered in Paiements),
// its history (the regularisation it corrects, its corrective one), the comparison with the statement of its period
// recomputed today, and the actions: send, mail, PDF, corrective.

const props = defineProps<{ id: number }>()
const router = useRouter()

const r = ref<Regularisation | null>(null)
const toutes = ref<Regularisation[]>([])
const versements = ref<Paiement[]>([])
const decomptes = ref(new Map<string, Decompte>())
const message = ref<{ text: string, type: 'info' | 'erreur' } | null>(null)
const redaction = ref(false)
const dateEnvoi = ref(new Date().toISOString().slice(0, 10))
const occupe = ref(false)
// Invoices whose copy is not verified: not joined to the supporting document (ADR 0024)
const nonJointes = ref<RegularisationDetail['tenant_copies']>([])

async function charger() {
  try {
    const detail = await api.charge_adjustment(props.id)
    ;[toutes.value, versements.value, decomptes.value] = await Promise.all([
      api.charge_adjustments(detail.building_id),
      detail.state === 'draft' ? Promise.resolve([]) : api.paiementsRegularisation(detail.building_id, detail.id),
      decomptesDesPeriodes(detail.building_id, [detail]),
    ])
    r.value = detail
    nonJointes.value = detail.tenant_copies.filter((a) => a.state === 'to_make' || a.state === 'to_check')
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
  }
}
watch(() => props.id, () => {
  redaction.value = false
  message.value = null
  charger()
}, { immediate: true })

const comparaison = computed(() => (r.value ? comparer(r.value, decomptes.value) : null))
const ecartDe = (actuel: string, fige: string) => new Big(actuel).minus(fige).toString()

const remaining = computed(() => (r.value ? new Big(r.value.balance).minus(r.value.amount_received).toString() : '0'))
const actuelle = computed(() => r.value !== null && !r.value.replaced_by)
// A decision is taken on a sent regularisation still waiting for its payment, and can be withdrawn
const decidable = computed(() => actuelle.value && r.value!.state !== 'draft'
  && (r.value!.state === 'pending' || r.value!.decision !== null))

// The corrective chain, oldest first: the regularisations this one replaces, then those that replace it
const historique = computed(() => {
  if (!r.value) {
    return []
  }
  const parId = new Map(toutes.value.map((x) => [x.id, x]))
  const avant: Regularisation[] = []
  for (let p = r.value.replaces_id ? parId.get(r.value.replaces_id) : undefined; p; p = p.replaces_id ? parId.get(p.replaces_id) : undefined) {
    avant.unshift(p)
  }
  const apres: Regularisation[] = []
  for (let n = r.value.replaced_by ? parId.get(r.value.replaced_by) : undefined; n; n = n.replaced_by ? parId.get(n.replaced_by) : undefined) {
    apres.push(n)
  }
  return [...avant, r.value, ...apres]
})

async function action(f: () => Promise<unknown>, succes: string) {
  occupe.value = true
  try {
    await f()
    message.value = { text: succes, type: 'info' }
    await charger()
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
  } finally {
    occupe.value = false
  }
}

function sent() {
  if (confirm(`Marquer envoyée le ${dateFr(dateEnvoi.value)} ? Les montants et le justificatif sont ceux qui ont été envoyés au locataire.`)) {
    action(() => api.marquerEnvoyee(props.id, dateEnvoi.value), `Marquée envoyée le ${dateFr(dateEnvoi.value)}`)
  }
}

// Undoing the sending: only while no payment toward it, no decision, no corrective (checked again by the API)
const annulable = computed(() => actuelle.value && r.value!.state !== 'draft' && r.value!.decision === null
  && !versements.value.some((v) => v.charge_adjustment_id === r.value!.id))

function annulerEnvoi() {
  if (confirm('Annuler l\'envoi ? La régularisation redevient un brouillon (à marquer envoyée de nouveau, ou à supprimer).')) {
    action(() => api.annulerEnvoi(props.id), 'Envoi annulé : la régularisation est redevenue un brouillon')
  }
}

// The only thing chosen by the owner (ADR 0010): what remains is given up (charge « offerte ») or unrecoverable
const DECISIONS: { decision: NonNullable<Regularisation['decision']>, bouton: string, sens: string }[] = [
  { decision: 'written_off', bouton: 'Abandonner le reste…', sens: 'charge offerte au locataire' },
  { decision: 'unrecoverable', bouton: 'Déclarer irrécouvrable…', sens: 'ne sera jamais payée (départ sans payer…)' },
]

async function decider(decision: Regularisation['decision']) {
  const message = decision === 'written_off'
    ? `Abandonner le reste (${euros(remaining.value)}), charge offerte ? Pour le fisc, il ne sera déductible qu'au départ du locataire.`
    : decision === 'unrecoverable'
      ? `Déclarer le reste (${euros(remaining.value)}) irrécouvrable ?`
      : 'Annuler la décision ? La régularisation redevient en attente de paiement.'
  if (!confirm(message)) {
    return
  }
  await action(() => api.decisionRegularisation(props.id, decision),
    decision ? `Décision : ${DECISIONS_REGULARISATION[decision]}` : 'Décision annulée')
}

async function rectifier() {
  if (!confirm(`Créer un rectificatif pour ${r.value!.tenant} à partir du décompte actuel ?`)) {
    return
  }
  try {
    const nouvelle = await api.rectificatif(props.id)
    await router.push({ name: 'charge_adjustment', params: { id: nouvelle.id } })
    message.value = { text: 'Rectificatif créé : vérifier, puis préparer le mail', type: 'info' }
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
  }
}

async function supprimer() {
  if (!confirm(`Supprimer le brouillon de ${r.value!.tenant} ?`)) {
    return
  }
  try {
    await api.supprimerRegularisation(props.id)
    await router.push({ name: 'charge_adjustments' })
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
  }
}
</script>

<template>
  <p><RouterLink :to="{ name: 'charge_adjustments' }">← Régularisations</RouterLink></p>
  <p v-if="message" class="message" :class="message.type">{{ message.text }}</p>

  <template v-if="r">
    <section class="entete-page">
      <h1>
        {{ r.tenant }}
        <span class="pastille" :class="r.state === 'draft' ? 'draft' : r.decision ? 'decision' : r.state">{{ libelleRegularisation(r) }}</span>
      </h1>
      <div class="actions-titre">
        <a v-if="r.supporting_statement" class="bouton" :href="api.justificatifUrl(r.id)" target="_blank">Justificatif PDF</a>
        <a
          v-else
          class="bouton"
          :href="api.justificatifUrl(r.id)"
          target="_blank"
          title="Envoyée hors de l'application : justificatif refait aujourd'hui sur le décompte de la période, comparé au montant envoyé"
        >PDF reconstitué</a>
        <button v-if="actuelle" type="button" :class="{ actif: redaction }" @click="redaction = !redaction">
          {{ redaction ? 'Fermer le mail' : 'Mail' }}
        </button>
        <button
          v-if="actuelle && r.state !== 'draft'"
          type="button"
          :class="{ principal: comparaison?.state === 'a_rectifier' }"
          :disabled="occupe"
          @click="rectifier"
        >Rectificatif</button>
      </div>
    </section>
    <p>
      {{ r.unit }} · régularisation {{ r.replaces_id ? 'rectificative ' : '' }}des charges du
      <strong>{{ dateFr(r.start) }} au {{ dateFr(r.end) }}</strong>
    </p>
    <p v-if="r.replaced_by" class="message avertissement">
      Remplacée par un rectificatif :
      <RouterLink :to="{ name: 'charge_adjustment', params: { id: r.replaced_by } }">ouvrir la régularisation en cours</RouterLink>.
    </p>

    <RedactionMail v-if="redaction" :key="r.id" :charge_adjustment="r" @fermer="redaction = false" />

    <div class="grille-blocs">
      <section class="bloc">
        <h2>Montants demandés</h2>
        <p class="bilan">Solde : {{ euros(r.balance) }} <span class="discret">({{ new Big(r.balance).lt(0) ? 'à rembourser au locataire' : 'à payer par le locataire' }})</span></p>
        <table class="liste montants-regularisation">
          <tbody>
            <tr class="sans-clic"><td>Charges de la période</td><td class="nombre">{{ euros(r.amount_due) }}</td></tr>
            <tr class="sans-clic"><td>Provisions versées</td><td class="nombre">− {{ euros(r.advances) }}</td></tr>
            <tr class="sans-clic"><td><strong>Solde</strong></td><td class="nombre"><strong>{{ euros(r.balance) }}</strong></td></tr>
          </tbody>
        </table>
        <p class="discret">
          {{ r.supporting_statement ? 'Montants figés à la création, comme dans le justificatif.' : 'Saisie manuelle (envoyée hors de l\'application)' }}{{ !r.supporting_statement && r.note ? ` : ${r.note}` : '' }}
        </p>
      </section>

      <section v-if="comparaison" class="bloc">
        <h2>Contrôle avec le décompte actuel</h2>
        <p v-if="comparaison.state === 'juste'" class="bilan ok">✓ Le décompte de la période donne toujours le même solde</p>
        <p v-else-if="comparaison.state === 'arrondi'" class="bilan">
          Écart de {{ euros(comparaison.ecart) }} <span class="discret">: sous le seuil de {{ euros(SEUIL_RECTIFICATION.toString()) }}, pas de rectificatif</span>
        </p>
        <p v-else class="bilan ko">
          {{ comparaison.state === 'a_recreer' ? 'À recréer' : 'À rectifier' }} : {{ euros(comparaison.ecart) }}
          ({{ new Big(comparaison.ecart).lt(0) ? 'trop demandé' : 'pas assez demandé' }})
        </p>
        <table v-if="comparaison.state !== 'juste'" class="liste montants-regularisation">
          <thead>
            <tr><th /><th class="nombre">{{ r.state === 'draft' ? 'Brouillon' : 'Envoyé' }}</th><th class="nombre">Décompte actuel</th><th class="nombre">Écart</th></tr>
          </thead>
          <tbody>
            <tr class="sans-clic">
              <td>Charges</td><td class="nombre">{{ euros(r.amount_due) }}</td><td class="nombre">{{ euros(comparaison.actuel.total) }}</td>
              <td class="nombre">{{ euros(ecartDe(comparaison.actuel.total, r.amount_due)) }}</td>
            </tr>
            <tr class="sans-clic">
              <td>Provisions</td><td class="nombre">{{ euros(r.advances) }}</td><td class="nombre">{{ euros(comparaison.actuel.advances) }}</td>
              <td class="nombre">{{ euros(ecartDe(comparaison.actuel.advances, r.advances)) }}</td>
            </tr>
            <tr class="sans-clic">
              <td><strong>Solde</strong></td><td class="nombre"><strong>{{ euros(r.balance) }}</strong></td>
              <td class="nombre"><strong>{{ euros(comparaison.actuel.balance) }}</strong></td>
              <td class="nombre"><strong>{{ euros(comparaison.ecart) }}</strong></td>
            </tr>
          </tbody>
        </table>
        <p v-if="comparaison.state === 'a_rectifier'" class="discret">
          Le décompte refait aujourd'hui sur la période diffère du solde envoyé. « Rectificatif » (en haut) le recalcule et
          prépare le mail d'excuses.
        </p>
        <p v-else-if="comparaison.state === 'a_recreer'" class="discret">
          Le décompte a changé depuis la création de ce brouillon : le supprimer puis le recréer depuis « Nouvelle
          régularisation ».
        </p>
      </section>
    </div>

    <section class="bloc">
      <h2>Envoi et paiement</h2>
      <template v-if="r.state === 'draft'">
        <p class="bilan">Pas encore envoyée</p>
        <div v-if="nonJointes.length" class="message erreur">
          {{ nonJointes.length }} facture(s) ne seront pas jointes au justificatif, leur version locataire n'étant pas contrôlée
          (elles y sont listées « non jointe, consultable sur demande ») :
          <template v-for="(a, i) in nonJointes" :key="a.invoice_id">{{ i ? ', ' : ' ' }}<RouterLink
            :to="{ name: 'invoice', params: { id: a.invoice_id } }">{{ a.supplier }} n° {{ a.number }}</RouterLink>
            ({{ a.state === 'to_make' ? 'à créer' : 'à contrôler' }})</template>.
          Les contrôler avant de l'envoyer : le justificatif se refait à chaque ouverture.
        </div>
        <div class="actions-page">
          <label class="aligne">Envoyée le <input v-model="dateEnvoi" type="date"></label>
          <button type="button" class="principal" :disabled="occupe" @click="sent">Marquer envoyée</button>
          <button type="button" class="danger" :disabled="occupe" @click="supprimer">Supprimer le brouillon</button>
        </div>
      </template>
      <template v-else>
        <p class="bilan" :class="r.state === 'settled' ? 'ok' : r.decision ? '' : 'ko'">
          {{ r.state === 'settled' ? '✓ Soldée' : r.decision ? `${DECISIONS_REGULARISATION[r.decision]} : reste ${euros(remaining)}` : `Reste à payer : ${euros(remaining)}` }}
          <span class="discret">
            · envoyée le {{ dateFr(r.sent_on) }}
            <button v-if="annulable" type="button" class="lien" :disabled="occupe" @click="annulerEnvoi">annuler l'envoi</button><template v-if="r.settled_on">, soldée le {{ dateFr(r.settled_on) }}</template>
            · reçu {{ euros(r.amount_received) }} sur {{ euros(r.balance) }}
          </span>
        </p>
        <div v-if="decidable" class="actions-page">
          <template v-if="r.decision">
            <span>Décision : <strong>{{ DECISIONS_REGULARISATION[r.decision] }}</strong></span>
            <button type="button" :disabled="occupe" @click="decider(null)">Annuler la décision</button>
          </template>
          <template v-else>
            <span v-for="d in DECISIONS" :key="d.decision" class="decision">
              <button type="button" :disabled="occupe" @click="decider(d.decision)">{{ d.bouton }}</button>
              <span class="discret">{{ d.sens }}</span>
            </span>
          </template>
        </div>
        <p class="discret">
          L'état (en attente, soldée) se calcule tout seul à partir des versements ; seule une décision (abandon,
          irrécouvrable) se choisit ici.
        </p>
        <h3>Versements reçus</h3>
        <table class="liste">
          <thead>
            <tr><th>Date</th><th class="nombre">Versement</th><th>Mode</th><th>Note</th></tr>
          </thead>
          <tbody>
            <tr v-for="v in versements" :key="v.id" class="sans-clic">
              <td>{{ dateFr(v.payment_date) }}</td>
              <td class="nombre">{{ euros(v.charge_adjustment) }}</td>
              <td>{{ v.method ? NOMS_MODES[v.method] : '' }}</td>
              <td class="discret">
                {{ v.note }}<template v-if="v.charge_adjustment_id !== r.id"> (versé sur la régularisation remplacée)</template>
              </td>
            </tr>
            <tr v-if="!versements.length" class="sans-clic"><td colspan="4" class="discret">Aucun versement reçu.</td></tr>
          </tbody>
        </table>
        <p class="discret">Les versements (ou remboursements) se saisissent dans <RouterLink to="/paiements">Paiements</RouterLink>.</p>
      </template>
    </section>

    <section v-if="historique.length > 1" class="bloc">
      <h2>Historique</h2>
      <table class="liste">
        <thead>
          <tr><th>Régularisation</th><th class="nombre">Solde</th><th>Statut</th><th /></tr>
        </thead>
        <tbody>
          <tr
            v-for="h in historique"
            :key="h.id"
            :class="{ 'sans-clic': h.id === r.id, ouverte: h.id === r.id }"
            @click="h.id !== r.id && router.push({ name: 'charge_adjustment', params: { id: h.id } })"
          >
            <td>{{ h.replaces_id ? 'Rectificatif' : 'Première régularisation' }}{{ h.id === r.id ? ' (celle-ci)' : '' }}</td>
            <td class="nombre">{{ euros(h.balance) }}</td>
            <td>{{ libelleRegularisation(h) }}{{ h.sent_on ? `, envoyée le ${dateFr(h.sent_on)}` : '' }}</td>
            <td class="discret">{{ h.replaced_by ? 'remplacée' : 'en cours' }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </template>
</template>

<script setup lang="ts">
import Big from 'big.js'
import { computed, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'

import {
  api, DECISIONS_REGULARISATION, libelleRegularisation, MODES_PAIEMENT, type Decompte, type Paiement, type Regularisation,
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
const message = ref<{ texte: string, type: 'info' | 'erreur' } | null>(null)
const redaction = ref(false)
const dateEnvoi = ref(new Date().toISOString().slice(0, 10))
const occupe = ref(false)

async function charger() {
  try {
    const detail = await api.regularisation(props.id)
    ;[toutes.value, versements.value, decomptes.value] = await Promise.all([
      api.regularisations(detail.immeuble_id),
      detail.etat === 'brouillon' ? Promise.resolve([]) : api.paiementsRegularisation(detail.immeuble_id, detail.id),
      decomptesDesPeriodes(detail.immeuble_id, [detail]),
    ])
    r.value = detail
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}
watch(() => props.id, () => {
  redaction.value = false
  message.value = null
  charger()
}, { immediate: true })

const comparaison = computed(() => (r.value ? comparer(r.value, decomptes.value) : null))
const ecartDe = (actuel: string, fige: string) => new Big(actuel).minus(fige).toString()

const reste = computed(() => (r.value ? new Big(r.value.solde).minus(r.value.montant_recu).toString() : '0'))
const actuelle = computed(() => r.value !== null && !r.value.remplacee_par)
// A decision is taken on a sent regularisation still waiting for its payment, and can be withdrawn
const decidable = computed(() => actuelle.value && r.value!.etat !== 'brouillon'
  && (r.value!.etat === 'en_attente' || r.value!.decision !== null))

// The corrective chain, oldest first: the regularisations this one replaces, then those that replace it
const historique = computed(() => {
  if (!r.value) {
    return []
  }
  const parId = new Map(toutes.value.map((x) => [x.id, x]))
  const avant: Regularisation[] = []
  for (let p = r.value.remplace_id ? parId.get(r.value.remplace_id) : undefined; p; p = p.remplace_id ? parId.get(p.remplace_id) : undefined) {
    avant.unshift(p)
  }
  const apres: Regularisation[] = []
  for (let n = r.value.remplacee_par ? parId.get(r.value.remplacee_par) : undefined; n; n = n.remplacee_par ? parId.get(n.remplacee_par) : undefined) {
    apres.push(n)
  }
  return [...avant, r.value, ...apres]
})

async function action(f: () => Promise<unknown>, succes: string) {
  occupe.value = true
  try {
    await f()
    message.value = { texte: succes, type: 'info' }
    await charger()
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  } finally {
    occupe.value = false
  }
}

function envoyee() {
  if (confirm(`Marquer envoyée le ${dateFr(dateEnvoi.value)} ? Les montants et le justificatif sont ceux qui ont été envoyés au locataire.`)) {
    action(() => api.marquerEnvoyee(props.id, dateEnvoi.value), `Marquée envoyée le ${dateFr(dateEnvoi.value)}`)
  }
}

// Undoing the sending: only while no payment toward it, no decision, no corrective (checked again by the API)
const annulable = computed(() => actuelle.value && r.value!.etat !== 'brouillon' && r.value!.decision === null
  && !versements.value.some((v) => v.regularisation_id === r.value!.id))

function annulerEnvoi() {
  if (confirm('Annuler l\'envoi ? La régularisation redevient un brouillon (à marquer envoyée de nouveau, ou à supprimer).')) {
    action(() => api.annulerEnvoi(props.id), 'Envoi annulé : la régularisation est redevenue un brouillon')
  }
}

// The only thing chosen by the owner (ADR 0010): what remains is given up (charge « offerte ») or unrecoverable
const DECISIONS: { decision: NonNullable<Regularisation['decision']>, bouton: string, sens: string }[] = [
  { decision: 'abandonnee', bouton: 'Abandonner le reste…', sens: 'charge offerte au locataire' },
  { decision: 'irrecouvrable', bouton: 'Déclarer irrécouvrable…', sens: 'ne sera jamais payée (départ sans payer…)' },
]

async function decider(decision: Regularisation['decision']) {
  const message = decision === 'abandonnee'
    ? `Abandonner le reste (${euros(reste.value)}), charge offerte ? Pour le fisc, il ne sera déductible qu'au départ du locataire.`
    : decision === 'irrecouvrable'
      ? `Déclarer le reste (${euros(reste.value)}) irrécouvrable ?`
      : 'Annuler la décision ? La régularisation redevient en attente de paiement.'
  if (!confirm(message)) {
    return
  }
  await action(() => api.decisionRegularisation(props.id, decision),
    decision ? `Décision : ${DECISIONS_REGULARISATION[decision]}` : 'Décision annulée')
}

async function rectifier() {
  if (!confirm(`Créer un rectificatif pour ${r.value!.locataire} à partir du décompte actuel ?`)) {
    return
  }
  try {
    const nouvelle = await api.rectificatif(props.id)
    await router.push({ name: 'regularisation', params: { id: nouvelle.id } })
    message.value = { texte: 'Rectificatif créé : vérifier, puis préparer le mail', type: 'info' }
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}

async function supprimer() {
  if (!confirm(`Supprimer le brouillon de ${r.value!.locataire} ?`)) {
    return
  }
  try {
    await api.supprimerRegularisation(props.id)
    await router.push({ name: 'regularisations' })
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}
</script>

<template>
  <p><RouterLink :to="{ name: 'regularisations' }">← Régularisations</RouterLink></p>
  <p v-if="message" class="message" :class="message.type">{{ message.texte }}</p>

  <template v-if="r">
    <section class="entete-page">
      <h1>
        {{ r.locataire }}
        <span class="pastille" :class="r.etat === 'brouillon' ? 'a_verifier' : r.decision ? 'decision' : r.etat">{{ libelleRegularisation(r) }}</span>
      </h1>
      <div class="actions-titre">
        <a v-if="r.justificatif" class="bouton" :href="api.justificatifUrl(r.id)" target="_blank">Justificatif PDF</a>
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
          v-if="actuelle && r.etat !== 'brouillon'"
          type="button"
          :class="{ principal: comparaison?.etat === 'a_rectifier' }"
          :disabled="occupe"
          @click="rectifier"
        >Rectificatif</button>
      </div>
    </section>
    <p>
      {{ r.lot }} · régularisation {{ r.remplace_id ? 'rectificative ' : '' }}des charges du
      <strong>{{ dateFr(r.debut) }} au {{ dateFr(r.fin) }}</strong>
    </p>
    <p v-if="r.remplacee_par" class="message avertissement">
      Remplacée par un rectificatif :
      <RouterLink :to="{ name: 'regularisation', params: { id: r.remplacee_par } }">ouvrir la régularisation en cours</RouterLink>.
    </p>

    <RedactionMail v-if="redaction" :key="r.id" :regularisation="r" @fermer="redaction = false" />

    <div class="grille-blocs">
      <section class="bloc">
        <h2>Montants demandés</h2>
        <p class="bilan">Solde : {{ euros(r.solde) }} <span class="discret">({{ new Big(r.solde).lt(0) ? 'à rembourser au locataire' : 'à payer par le locataire' }})</span></p>
        <table class="liste montants-regularisation">
          <tbody>
            <tr class="sans-clic"><td>Charges de la période</td><td class="nombre">{{ euros(r.montant_du) }}</td></tr>
            <tr class="sans-clic"><td>Provisions versées</td><td class="nombre">− {{ euros(r.provisions) }}</td></tr>
            <tr class="sans-clic"><td><strong>Solde</strong></td><td class="nombre"><strong>{{ euros(r.solde) }}</strong></td></tr>
          </tbody>
        </table>
        <p class="discret">
          {{ r.justificatif ? 'Montants figés à la création, comme dans le justificatif.' : 'Saisie manuelle (envoyée hors de l\'application)' }}{{ !r.justificatif && r.note ? ` : ${r.note}` : '' }}
        </p>
      </section>

      <section v-if="comparaison" class="bloc">
        <h2>Contrôle avec le décompte actuel</h2>
        <p v-if="comparaison.etat === 'juste'" class="bilan ok">✓ Le décompte de la période donne toujours le même solde</p>
        <p v-else-if="comparaison.etat === 'arrondi'" class="bilan">
          Écart de {{ euros(comparaison.ecart) }} <span class="discret">: sous le seuil de {{ euros(SEUIL_RECTIFICATION.toString()) }}, pas de rectificatif</span>
        </p>
        <p v-else class="bilan ko">
          {{ comparaison.etat === 'a_recreer' ? 'À recréer' : 'À rectifier' }} : {{ euros(comparaison.ecart) }}
          ({{ new Big(comparaison.ecart).lt(0) ? 'trop demandé' : 'pas assez demandé' }})
        </p>
        <table v-if="comparaison.etat !== 'juste'" class="liste montants-regularisation">
          <thead>
            <tr><th /><th class="nombre">{{ r.etat === 'brouillon' ? 'Brouillon' : 'Envoyé' }}</th><th class="nombre">Décompte actuel</th><th class="nombre">Écart</th></tr>
          </thead>
          <tbody>
            <tr class="sans-clic">
              <td>Charges</td><td class="nombre">{{ euros(r.montant_du) }}</td><td class="nombre">{{ euros(comparaison.actuel.total) }}</td>
              <td class="nombre">{{ euros(ecartDe(comparaison.actuel.total, r.montant_du)) }}</td>
            </tr>
            <tr class="sans-clic">
              <td>Provisions</td><td class="nombre">{{ euros(r.provisions) }}</td><td class="nombre">{{ euros(comparaison.actuel.provisions) }}</td>
              <td class="nombre">{{ euros(ecartDe(comparaison.actuel.provisions, r.provisions)) }}</td>
            </tr>
            <tr class="sans-clic">
              <td><strong>Solde</strong></td><td class="nombre"><strong>{{ euros(r.solde) }}</strong></td>
              <td class="nombre"><strong>{{ euros(comparaison.actuel.solde) }}</strong></td>
              <td class="nombre"><strong>{{ euros(comparaison.ecart) }}</strong></td>
            </tr>
          </tbody>
        </table>
        <p v-if="comparaison.etat === 'a_rectifier'" class="discret">
          Le décompte refait aujourd'hui sur la période diffère du solde envoyé. « Rectificatif » (en haut) le recalcule et
          prépare le mail d'excuses.
        </p>
        <p v-else-if="comparaison.etat === 'a_recreer'" class="discret">
          Le décompte a changé depuis la création de ce brouillon : le supprimer puis le recréer depuis « Nouvelle
          régularisation ».
        </p>
      </section>
    </div>

    <section class="bloc">
      <h2>Envoi et paiement</h2>
      <template v-if="r.etat === 'brouillon'">
        <p class="bilan">Pas encore envoyée</p>
        <div class="actions-page">
          <label class="aligne">Envoyée le <input v-model="dateEnvoi" type="date"></label>
          <button type="button" class="principal" :disabled="occupe" @click="envoyee">Marquer envoyée</button>
          <button type="button" class="danger" :disabled="occupe" @click="supprimer">Supprimer le brouillon</button>
        </div>
      </template>
      <template v-else>
        <p class="bilan" :class="r.etat === 'soldee' ? 'ok' : r.decision ? '' : 'ko'">
          {{ r.etat === 'soldee' ? '✓ Soldée' : r.decision ? `${DECISIONS_REGULARISATION[r.decision]} : reste ${euros(reste)}` : `Reste à payer : ${euros(reste)}` }}
          <span class="discret">
            · envoyée le {{ dateFr(r.date_envoi) }}
            <button v-if="annulable" type="button" class="lien" :disabled="occupe" @click="annulerEnvoi">annuler l'envoi</button><template v-if="r.date_solde">, soldée le {{ dateFr(r.date_solde) }}</template>
            · reçu {{ euros(r.montant_recu) }} sur {{ euros(r.solde) }}
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
              <td>{{ dateFr(v.date_paiement) }}</td>
              <td class="nombre">{{ euros(v.regularisation) }}</td>
              <td>{{ v.mode ? MODES_PAIEMENT[v.mode] : '' }}</td>
              <td class="discret">
                {{ v.note }}<template v-if="v.regularisation_id !== r.id"> (versé sur la régularisation remplacée)</template>
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
            @click="h.id !== r.id && router.push({ name: 'regularisation', params: { id: h.id } })"
          >
            <td>{{ h.remplace_id ? 'Rectificatif' : 'Première régularisation' }}{{ h.id === r.id ? ' (celle-ci)' : '' }}</td>
            <td class="nombre">{{ euros(h.solde) }}</td>
            <td>{{ libelleRegularisation(h) }}{{ h.date_envoi ? `, envoyée le ${dateFr(h.date_envoi)}` : '' }}</td>
            <td class="discret">{{ h.remplacee_par ? 'remplacée' : 'en cours' }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </template>
</template>

<script setup lang="ts">
import Big from 'big.js'
import { computed, ref, watch } from 'vue'

import { api, type Paiement, type Regularisation } from '../api'
import { dateFr, euros, exerciceCourt } from '../format'
import { useImmeuble } from '../immeuble'
import { regularisationsManquantes, type Manquante } from '../regularisationsManquantes'

// Control: the regularisations sent (current ones, not replaced) that concern the exercise: still to be paid, or paid
// toward during it. The payments toward each are shown by month of payment (no amount is called per month), then the
// balance, what was received in all (previous regularisations of a corrective chain included, ADR 0010) and the rest:
// settled within 1 euro (green), to be paid or refunded (red), given up by the owner (grey). First, the regularisations
// missing for a finished exercise (regularisationsManquantes): a stay present without one, whichever way its balance goes.

const props = defineProps<{ building: number, start: string, end: string }>()
const { buildings } = useImmeuble()

const charge_adjustments = ref<Regularisation[]>([])
const payments = ref<Paiement[]>([])
const manquantes = ref<Manquante[]>([])
const erreur = ref<string | null>(null)

const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']

const annees = computed(() => {
  const premiere = Number(props.start.slice(0, 4))
  return Array.from({ length: Number(props.end.slice(0, 4)) - premiere + 1 }, (_, i) => premiere + i)
})

// Months of the exercise, 'AAAA-MM'
const moisExercice = computed(() => {
  const liste: string[] = []
  for (let m = props.start.slice(0, 7); m <= props.end.slice(0, 7);) {
    liste.push(m)
    const suivant = Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7))
    m = `${Math.floor(suivant / 12)}-${String((suivant % 12) + 1).padStart(2, '0')}`
  }
  return liste
})

async function charger() {
  try {
    const [r, lus, d] = await Promise.all([
      api.charge_adjustments(props.building), Promise.all(annees.value.map((a) => api.payments(props.building, a))),
      api.charge_statement({ building: props.building, start: props.start, end: props.end }),
    ])
    charge_adjustments.value = r
    payments.value = lus.flat()
    manquantes.value = regularisationsManquantes(d, r, new Date().toISOString().slice(0, 10),
      buildings.value.find((i) => i.id === props.building)?.managed_from ?? null)
    erreur.value = null
  } catch (e) {
    erreur.value = (e as Error).message
  }
}
watch(() => [props.building, props.start, props.end], charger, { immediate: true })

// Settled within 1 euro, as the regularisation's own state (ADR 0010)
const TOLERANCE = new Big('1')

// The regularisation and those it replaces: their payments count toward it
function chaine(r: Regularisation) {
  const ids = [r.id]
  for (let p = r.replaces_id; p !== null;) {
    ids.push(p)
    p = charge_adjustments.value.find((x) => x.id === p)?.replaces_id ?? null
  }
  return ids
}

const tableau = computed(() =>
  charge_adjustments.value
    .filter((r) => r.state !== 'draft' && !r.replaced_by && r.sent_on !== null && r.sent_on <= props.end)
    .map((r) => {
      const ids = chaine(r)
      const siens = payments.value.filter((p) => p.charge_adjustment_id !== null && ids.includes(p.charge_adjustment_id))
      const cases = moisExercice.value.map((m) => {
        const duMois = siens.filter((p) => p.payment_date.startsWith(m))
        return { month: m, recu: duMois.length ? duMois.reduce((t, p) => t.plus(p.charge_adjustment), new Big(0)).toString() : null }
      })
      const remaining = new Big(r.balance).minus(r.amount_received)
      return { r, cases, remaining: remaining.toString(), dansExercice: cases.some((c) => c.recu !== null) }
    })
    // Still to be paid (or refunded), or paid toward during the exercise
    .filter((x) => x.r.state === 'pending' || x.dansExercice)
    .sort((a, b) => a.r.unit.localeCompare(b.r.unit) || a.r.start.localeCompare(b.r.start)),
)

const ouvert = (x: { r: Regularisation, remaining: string }) => !x.r.decision && new Big(x.remaining).abs().gt(TOLERANCE)
const enAttente = computed(() => tableau.value.filter(ouvert))
const resteDu = computed(() => enAttente.value.filter((x) => new Big(x.remaining).gt(0))
  .reduce((t, x) => t.plus(x.remaining), new Big(0)).toString())
const aRembourser = computed(() => enAttente.value.filter((x) => new Big(x.remaining).lt(0))
  .reduce((t, x) => t.minus(x.remaining), new Big(0)).toString())
</script>

<template>
  <section class="bloc">
    <h2>Régularisations</h2>
    <p class="bilan" :class="enAttente.length || manquantes.length ? 'ko' : 'ok'">
      <template v-if="enAttente.length || manquantes.length">
        <template v-if="manquantes.length">{{ manquantes.length }} régularisation(s) manquante(s)</template>
        <template v-if="manquantes.length && enAttente.length"> · </template>
        <template v-if="enAttente.length">
          {{ enAttente.length }} régularisation(s) en attente · reste dû {{ euros(resteDu) }}
          <template v-if="new Big(aRembourser).gt(0)"> · à rembourser {{ euros(aRembourser) }}</template>
        </template>
      </template>
      <template v-else-if="tableau.length">✓ Toutes les régularisations envoyées sont soldées</template>
      <template v-else>Aucune régularisation envoyée en attente ni payée sur l'exercice</template>
    </p>
    <p v-if="erreur" class="message erreur">{{ erreur }}</p>
    <template v-if="manquantes.length">
      <h3>Régularisations manquantes</h3>
      <p class="discret">
        Locataires présents sur l'exercice, terminé, sans régularisation qui le couvre. Le solde est celui du décompte
        d'aujourd'hui : à réclamer s'il est positif, à rembourser s'il est négatif.
      </p>
      <ul class="constats">
        <li v-for="m in manquantes" :key="m.tenancy.tenancy_id" class="avertissement">
          <strong>{{ m.tenancy.tenant }}</strong> ({{ m.tenancy.unit }}, présent du {{ dateFr(m.tenancy.present_from) }} au
          {{ dateFr(m.tenancy.present_to) }}) :
          <template v-if="new Big(m.tenancy.balance).gt(0)">{{ euros(m.tenancy.balance) }} à réclamer</template>
          <template v-else-if="new Big(m.tenancy.balance).lt(0)">{{ euros(new Big(m.tenancy.balance).neg().toString()) }} à rembourser</template>
          <template v-else>solde nul, décompte à envoyer</template>
          · <RouterLink :to="{ name: 'nouvelle-regularisation', query: { start: m.start, end: m.end } }">Créer la régularisation</RouterLink>
        </li>
      </ul>
    </template>
    <div v-if="tableau.length" class="defilement">
      <table class="liste paiements-annee">
        <thead>
          <tr>
            <th>Lot</th><th>Locataire</th><th>Exercice régularisé</th>
            <th v-for="m in moisExercice" :key="m" class="nombre">
              {{ MOIS[Number(m.slice(5, 7)) - 1] }}<template v-if="annees.length > 1"><br>{{ m.slice(0, 4) }}</template>
            </th>
            <th class="nombre">Solde</th><th class="nombre">Reçu</th><th class="nombre">Reste dû</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="x in tableau" :key="x.r.id" class="sans-clic">
            <td>{{ x.r.unit }}</td>
            <td>{{ x.r.tenant }}</td>
            <td>
              <RouterLink :to="{ name: 'charge_adjustment', params: { id: x.r.id } }">{{ exerciceCourt(x.r.start, x.r.end) }}</RouterLink>
              <div class="discret">envoyée le {{ dateFr(x.r.sent_on) }}</div>
            </td>
            <td
              v-for="c in x.cases" :key="c.month" class="nombre case-mois" :class="c.recu ? 'paid' : ''"
              :title="c.recu ? `${MOIS[Number(c.month.slice(5, 7)) - 1]} ${c.month.slice(0, 4)} : ${euros(c.recu)} versés` : ''"
            >
              <template v-if="c.recu">{{ euros(c.recu) }}</template>
            </td>
            <td class="nombre">{{ euros(x.r.balance) }}</td>
            <td class="nombre">{{ euros(x.r.amount_received) }}</td>
            <td class="nombre">
              <span v-if="x.r.decision" class="discret">{{ x.r.decision === 'written_off' ? 'abandonnée' : 'irrécouvrable' }} ({{ euros(x.remaining) }})</span>
              <strong v-else-if="new Big(x.remaining).gt(TOLERANCE)" class="ko">{{ euros(x.remaining) }}</strong>
              <strong v-else-if="new Big(x.remaining).lt(TOLERANCE.neg())" class="ko">à rembourser {{ euros(new Big(x.remaining).neg().toString()) }}</strong>
              <strong v-else class="ok">✓ soldée</strong>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="legende discret">
      Régularisations envoyées encore à payer, ou payées en partie pendant l'exercice ; versements par mois de paiement.
      Reste dû : solde − reçu, soldée à 1 € près. Les versements se saisissent dans l'écran Paiements.
    </p>
  </section>
</template>

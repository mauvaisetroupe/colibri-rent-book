<script setup lang="ts">
import Big from 'big.js'
import { computed, ref, watch } from 'vue'

import { api, type Paiement, type Regularisation } from '../api'
import { dateFr, euros, exerciceCourt } from '../format'

// Control: the regularisations sent (current ones, not replaced) that concern the exercise: still to be paid, or paid
// toward during it. The payments toward each are shown by month of payment (no amount is called per month), then the
// balance, what was received in all (previous regularisations of a corrective chain included, ADR 0010) and the rest:
// settled within 1 euro (green), to be paid or refunded (red), given up by the owner (grey).

const props = defineProps<{ immeuble: number, debut: string, fin: string }>()

const regularisations = ref<Regularisation[]>([])
const paiements = ref<Paiement[]>([])
const erreur = ref<string | null>(null)

const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']

const annees = computed(() => {
  const premiere = Number(props.debut.slice(0, 4))
  return Array.from({ length: Number(props.fin.slice(0, 4)) - premiere + 1 }, (_, i) => premiere + i)
})

// Months of the exercise, 'AAAA-MM'
const moisExercice = computed(() => {
  const liste: string[] = []
  for (let m = props.debut.slice(0, 7); m <= props.fin.slice(0, 7);) {
    liste.push(m)
    const suivant = Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7))
    m = `${Math.floor(suivant / 12)}-${String((suivant % 12) + 1).padStart(2, '0')}`
  }
  return liste
})

async function charger() {
  try {
    const [r, lus] = await Promise.all([
      api.regularisations(props.immeuble), Promise.all(annees.value.map((a) => api.paiements(props.immeuble, a))),
    ])
    regularisations.value = r
    paiements.value = lus.flat()
    erreur.value = null
  } catch (e) {
    erreur.value = (e as Error).message
  }
}
watch(() => [props.immeuble, props.debut, props.fin], charger, { immediate: true })

// Settled within 1 euro, as the regularisation's own state (ADR 0010)
const TOLERANCE = new Big('1')

// The regularisation and those it replaces: their payments count toward it
function chaine(r: Regularisation) {
  const ids = [r.id]
  for (let p = r.remplace_id; p !== null;) {
    ids.push(p)
    p = regularisations.value.find((x) => x.id === p)?.remplace_id ?? null
  }
  return ids
}

const tableau = computed(() =>
  regularisations.value
    .filter((r) => r.etat !== 'brouillon' && !r.remplacee_par && r.date_envoi !== null && r.date_envoi <= props.fin)
    .map((r) => {
      const ids = chaine(r)
      const siens = paiements.value.filter((p) => p.regularisation_id !== null && ids.includes(p.regularisation_id))
      const cases = moisExercice.value.map((m) => {
        const duMois = siens.filter((p) => p.date_paiement.startsWith(m))
        return { mois: m, recu: duMois.length ? duMois.reduce((t, p) => t.plus(p.regularisation), new Big(0)).toString() : null }
      })
      const reste = new Big(r.solde).minus(r.montant_recu)
      return { r, cases, reste: reste.toString(), dansExercice: cases.some((c) => c.recu !== null) }
    })
    // Still to be paid (or refunded), or paid toward during the exercise
    .filter((x) => x.r.etat === 'en_attente' || x.dansExercice)
    .sort((a, b) => a.r.lot.localeCompare(b.r.lot) || a.r.debut.localeCompare(b.r.debut)),
)

const ouvert = (x: { r: Regularisation, reste: string }) => !x.r.decision && new Big(x.reste).abs().gt(TOLERANCE)
const enAttente = computed(() => tableau.value.filter(ouvert))
const resteDu = computed(() => enAttente.value.filter((x) => new Big(x.reste).gt(0))
  .reduce((t, x) => t.plus(x.reste), new Big(0)).toString())
const aRembourser = computed(() => enAttente.value.filter((x) => new Big(x.reste).lt(0))
  .reduce((t, x) => t.minus(x.reste), new Big(0)).toString())
</script>

<template>
  <section class="bloc">
    <h2>Régularisations</h2>
    <p class="bilan" :class="enAttente.length ? 'ko' : 'ok'">
      <template v-if="enAttente.length">
        {{ enAttente.length }} régularisation(s) en attente · reste dû {{ euros(resteDu) }}
        <template v-if="new Big(aRembourser).gt(0)"> · à rembourser {{ euros(aRembourser) }}</template>
      </template>
      <template v-else-if="tableau.length">✓ Toutes les régularisations envoyées sont soldées</template>
      <template v-else>Aucune régularisation envoyée en attente ni payée sur l'exercice</template>
    </p>
    <p v-if="erreur" class="message erreur">{{ erreur }}</p>
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
            <td>{{ x.r.lot }}</td>
            <td>{{ x.r.locataire }}</td>
            <td>
              <RouterLink :to="{ name: 'regularisation', params: { id: x.r.id } }">{{ exerciceCourt(x.r.debut, x.r.fin) }}</RouterLink>
              <div class="discret">envoyée le {{ dateFr(x.r.date_envoi) }}</div>
            </td>
            <td
              v-for="c in x.cases" :key="c.mois" class="nombre case-mois" :class="c.recu ? 'paye' : ''"
              :title="c.recu ? `${MOIS[Number(c.mois.slice(5, 7)) - 1]} ${c.mois.slice(0, 4)} : ${euros(c.recu)} versés` : ''"
            >
              <template v-if="c.recu">{{ euros(c.recu) }}</template>
            </td>
            <td class="nombre">{{ euros(x.r.solde) }}</td>
            <td class="nombre">{{ euros(x.r.montant_recu) }}</td>
            <td class="nombre">
              <span v-if="x.r.decision" class="discret">{{ x.r.decision === 'abandonnee' ? 'abandonnée' : 'irrécouvrable' }} ({{ euros(x.reste) }})</span>
              <strong v-else-if="new Big(x.reste).gt(TOLERANCE)" class="ko">{{ euros(x.reste) }}</strong>
              <strong v-else-if="new Big(x.reste).lt(TOLERANCE.neg())" class="ko">à rembourser {{ euros(new Big(x.reste).neg().toString()) }}</strong>
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

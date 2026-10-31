<script setup lang="ts">
import Big from 'big.js'
import { computed, ref, watch } from 'vue'

import { api, type Echeance, type Paiement, type Sejour } from '../api'
import { attendu } from '../echeances'
import { euros } from '../format'

// Control: rent and provision received month by month over an exercise, per tenant, against the amount called
// (ADR 0009): paid, paid in part, not paid. A month without amount called recorded shows what was received only.
// Months are checked from the first month with a payment on record (before: yearly totals, no detail).

const props = defineProps<{ building: number, start: string, end: string }>()

const payments = ref<Paiement[]>([])
const tenancies = ref<Sejour[]>([])
const rent_schedules = ref<Echeance[]>([])
const erreur = ref<string | null>(null)
const aujourdhui = new Date().toISOString().slice(0, 10)

const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']
const moisFr = (m: string) => `${MOIS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`

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
    const [lus, s, e] = await Promise.all([
      Promise.all(annees.value.map((a) => api.payments(props.building, a))), api.tenancies(props.building),
      api.rent_schedules(props.building),
    ])
    payments.value = lus.flat()
    tenancies.value = s
    rent_schedules.value = e
    erreur.value = null
  } catch (e) {
    erreur.value = (e as Error).message
  }
}
watch(() => [props.building, props.start, props.end], charger, { immediate: true })

const present = (s: Sejour, m: string) => s.move_in <= `${m}-31` && (s.move_out === null || s.move_out >= `${m}-01`)

const debutSuivi = computed(() => payments.value.filter((p) => p.month).map((p) => p.month!.slice(0, 7)).sort()[0] ?? null)

// Received within 1 euro of the amount called counts as paid: the legacy rounds a pro rata month to the euro
// (e.g. 266 paid for 266.12 called)
const TOLERANCE = new Big('1')

type EtatMois = 'absent' | 'avenir' | 'paid' | 'partiel' | 'impaye' | 'recu'

const tableau = computed(() =>
  tenancies.value
    .filter((s) => moisExercice.value.some((m) => present(s, m)))
    .map((s) => {
      const siens = payments.value.filter((p) => p.tenancy_id === s.id && p.month)
      let remaining = new Big(0)
      let sansAppel = false
      const cases = moisExercice.value.map((m) => {
        const duMois = siens.filter((p) => p.month!.startsWith(m))
        const recu = duMois.reduce((t, p) => t.plus(p.rent).plus(p.charge_advance), new Big(0))
        const appel = present(s, m) ? attendu(rent_schedules.value, s, m) : null
        const suivi = m <= aujourdhui.slice(0, 7) && debutSuivi.value !== null && m >= debutSuivi.value
        let state: EtatMois
        if (!present(s, m)) {
          state = 'absent'
        } else if (!suivi) {
          state = duMois.length ? 'recu' : 'avenir'
        } else if (appel) {
          const manque = new Big(appel.total).minus(recu)
          remaining = remaining.plus(manque)
          state = manque.lte(TOLERANCE) ? 'paid' : recu.gt(0) ? 'partiel' : 'impaye'
        } else {
          sansAppel = true
          state = duMois.length ? 'recu' : 'impaye'
        }
        return { month: m, state, recu: duMois.length ? recu.toString() : null, appel: appel?.total ?? null }
      })
      return { tenancy: s, cases, remaining: remaining.toString(), sansAppel }
    }),
)

const account = (state: EtatMois) => tableau.value.reduce((n, r) => n + r.cases.filter((c) => c.state === state).length, 0)
const impayes = computed(() => account('impaye'))
const partiels = computed(() => account('partiel'))
const resteTotal = computed(() =>
  tableau.value.reduce((t, r) => (new Big(r.remaining).gt(0) ? t.plus(r.remaining) : t), new Big(0)).toString())
const sansAppel = computed(() => tableau.value.filter((r) => r.sansAppel).map((r) => r.tenancy.tenant))

const title = (c: { month: string, state: EtatMois, recu: string | null, appel: string | null }) => ({
  absent: '', avenir: '',
  paid: `${moisFr(c.month)} : payé`,
  partiel: `${moisFr(c.month)} : ${euros(c.recu)} reçus sur ${euros(c.appel)} appelés`,
  impaye: `${moisFr(c.month)} : aucun paiement${c.appel ? ` (${euros(c.appel)} appelés)` : ''}`,
  recu: `${moisFr(c.month)} : ${euros(c.recu)} reçus (montant appelé non renseigné)`,
})[c.state]
</script>

<template>
  <section class="bloc">
    <h2>Paiements</h2>
    <p class="bilan" :class="impayes || partiels ? 'ko' : 'ok'">
      <template v-if="impayes || partiels">
        {{ impayes }} mois sans paiement · {{ partiels }} mois payés en partie · reste dû {{ euros(resteTotal) }}
      </template>
      <template v-else>✓ Tous les mois suivis sont payés</template>
    </p>
    <p v-if="erreur" class="message erreur">{{ erreur }}</p>
    <p v-if="sansAppel.length" class="message avertissement">
      Montant appelé non renseigné ({{ sansAppel.join(', ') }}) : un mois payé en partie ne peut pas être repéré.
      Le renseigner dans la fiche du locataire (écran Locataires).
    </p>
    <div class="defilement">
      <table class="liste paiements-annee">
        <thead>
          <tr>
            <th>Lot</th><th>Locataire</th>
            <th v-for="m in moisExercice" :key="m" class="nombre">
              {{ MOIS[Number(m.slice(5, 7)) - 1] }}<template v-if="annees.length > 1"><br>{{ m.slice(0, 4) }}</template>
            </th>
            <th class="nombre">Reste dû</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in tableau" :key="r.tenancy.id" class="sans-clic">
            <td>{{ r.tenancy.unit }}</td>
            <td>{{ r.tenancy.tenant }}</td>
            <td v-for="c in r.cases" :key="c.month" class="nombre case-mois" :class="c.state" :title="title(c)">
              <template v-if="c.state === 'paid' || c.state === 'recu'">{{ euros(c.recu) }}</template>
              <template v-else-if="c.state === 'partiel'">{{ euros(c.recu) }}<div class="sur">sur {{ euros(c.appel) }}</div></template>
              <template v-else-if="c.state === 'impaye'">✗</template>
              <template v-else-if="c.state === 'avenir'">·</template>
            </td>
            <td class="nombre">
              <strong v-if="new Big(r.remaining).gt(TOLERANCE)" class="ko">{{ euros(r.remaining) }}</strong>
              <span v-else-if="new Big(r.remaining).lt(TOLERANCE.neg())" class="discret">trop-perçu {{ euros(new Big(r.remaining).neg().toString()) }}</span>
              <span v-else class="discret">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="legende discret">
      <span class="case-mois paye">payé</span> <span class="case-mois partiel">payé en partie</span>
      <span class="case-mois impaye">✗ rien reçu</span> <span class="case-mois recu">reçu, montant appelé inconnu</span>
      · loyer + provision reçus pour le mois, à partir du premier mois suivi{{ debutSuivi ? ` (${moisFr(debutSuivi)})` : '' }} ;
      « · » : mois à venir ou non suivi. Les paiements se saisissent dans l'écran Paiements.
    </p>
  </section>
</template>

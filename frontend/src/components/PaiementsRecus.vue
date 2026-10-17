<script setup lang="ts">
import Big from 'big.js'
import { computed, ref, watch } from 'vue'

import { api, type Echeance, type Paiement, type Sejour } from '../api'
import { attendu } from '../echeances'
import { euros } from '../format'

// Control: rent and provision received month by month over an exercise, per tenant, against the amount called
// (ADR 0009): paid, paid in part, not paid. A month without amount called recorded shows what was received only.
// Months are checked from the first month with a payment on record (before: yearly totals, no detail).

const props = defineProps<{ immeuble: number, debut: string, fin: string }>()

const paiements = ref<Paiement[]>([])
const sejours = ref<Sejour[]>([])
const echeances = ref<Echeance[]>([])
const erreur = ref<string | null>(null)
const aujourdhui = new Date().toISOString().slice(0, 10)

const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']
const moisFr = (m: string) => `${MOIS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`

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
    const [lus, s, e] = await Promise.all([
      Promise.all(annees.value.map((a) => api.paiements(props.immeuble, a))), api.sejours(props.immeuble),
      api.echeances(props.immeuble),
    ])
    paiements.value = lus.flat()
    sejours.value = s
    echeances.value = e
    erreur.value = null
  } catch (e) {
    erreur.value = (e as Error).message
  }
}
watch(() => [props.immeuble, props.debut, props.fin], charger, { immediate: true })

const present = (s: Sejour, m: string) => s.entree <= `${m}-31` && (s.sortie === null || s.sortie >= `${m}-01`)

const debutSuivi = computed(() => paiements.value.filter((p) => p.mois).map((p) => p.mois!.slice(0, 7)).sort()[0] ?? null)

// Received within 1 euro of the amount called counts as paid: the legacy rounds a pro rata month to the euro
// (e.g. 266 paid for 266.12 called)
const TOLERANCE = new Big('1')

type EtatMois = 'absent' | 'avenir' | 'paye' | 'partiel' | 'impaye' | 'recu'

const tableau = computed(() =>
  sejours.value
    .filter((s) => moisExercice.value.some((m) => present(s, m)))
    .map((s) => {
      const siens = paiements.value.filter((p) => p.sejour_id === s.id && p.mois)
      let reste = new Big(0)
      let sansAppel = false
      const cases = moisExercice.value.map((m) => {
        const duMois = siens.filter((p) => p.mois!.startsWith(m))
        const recu = duMois.reduce((t, p) => t.plus(p.loyer).plus(p.provision), new Big(0))
        const appel = present(s, m) ? attendu(echeances.value, s, m) : null
        const suivi = m <= aujourdhui.slice(0, 7) && debutSuivi.value !== null && m >= debutSuivi.value
        let etat: EtatMois
        if (!present(s, m)) {
          etat = 'absent'
        } else if (!suivi) {
          etat = duMois.length ? 'recu' : 'avenir'
        } else if (appel) {
          const manque = new Big(appel.total).minus(recu)
          reste = reste.plus(manque)
          etat = manque.lte(TOLERANCE) ? 'paye' : recu.gt(0) ? 'partiel' : 'impaye'
        } else {
          sansAppel = true
          etat = duMois.length ? 'recu' : 'impaye'
        }
        return { mois: m, etat, recu: duMois.length ? recu.toString() : null, appel: appel?.total ?? null }
      })
      return { sejour: s, cases, reste: reste.toString(), sansAppel }
    }),
)

const compte = (etat: EtatMois) => tableau.value.reduce((n, r) => n + r.cases.filter((c) => c.etat === etat).length, 0)
const impayes = computed(() => compte('impaye'))
const partiels = computed(() => compte('partiel'))
const resteTotal = computed(() =>
  tableau.value.reduce((t, r) => (new Big(r.reste).gt(0) ? t.plus(r.reste) : t), new Big(0)).toString())
const sansAppel = computed(() => tableau.value.filter((r) => r.sansAppel).map((r) => r.sejour.locataire))

const titre = (c: { mois: string, etat: EtatMois, recu: string | null, appel: string | null }) => ({
  absent: '', avenir: '',
  paye: `${moisFr(c.mois)} : payé`,
  partiel: `${moisFr(c.mois)} : ${euros(c.recu)} reçus sur ${euros(c.appel)} appelés`,
  impaye: `${moisFr(c.mois)} : aucun paiement${c.appel ? ` (${euros(c.appel)} appelés)` : ''}`,
  recu: `${moisFr(c.mois)} : ${euros(c.recu)} reçus (montant appelé non renseigné)`,
})[c.etat]
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
          <tr v-for="r in tableau" :key="r.sejour.id" class="sans-clic">
            <td>{{ r.sejour.lot }}</td>
            <td>{{ r.sejour.locataire }}</td>
            <td v-for="c in r.cases" :key="c.mois" class="nombre case-mois" :class="c.etat" :title="titre(c)">
              <template v-if="c.etat === 'paye' || c.etat === 'recu'">{{ euros(c.recu) }}</template>
              <template v-else-if="c.etat === 'partiel'">{{ euros(c.recu) }}<div class="sur">sur {{ euros(c.appel) }}</div></template>
              <template v-else-if="c.etat === 'impaye'">✗</template>
              <template v-else-if="c.etat === 'avenir'">·</template>
            </td>
            <td class="nombre">
              <strong v-if="new Big(r.reste).gt(TOLERANCE)" class="ko">{{ euros(r.reste) }}</strong>
              <span v-else-if="new Big(r.reste).lt(TOLERANCE.neg())" class="discret">trop-perçu {{ euros(new Big(r.reste).neg().toString()) }}</span>
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

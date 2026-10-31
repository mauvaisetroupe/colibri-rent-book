<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import { api, ENERGIES, type Couverture } from '../api'
import ChoixExercice from '../components/ChoixExercice.vue'
import ControleBanque from '../components/ControleBanque.vue'
import Frise, { type Piste } from '../components/Frise.vue'
import PaiementsRecus from '../components/PaiementsRecus.vue'
import RegularisationsRecues from '../components/RegularisationsRecues.vue'
import { useExercice } from '../exercice'
import { dateFr } from '../format'
import { useImmeuble } from '../immeuble'

// Checks of an exercise, in four groups. Invoices: coverage of the exercise by validated invoices (SPEC R1), a gap is a
// period nobody is charged for (forgotten invoice, draft), an overlap a period charged twice; gas and electricity:
// consumption lines only. Payments: each month received against the amount called (PaiementsRecus); regularisations
// sent, their payments and what remains (RegularisationsRecues). Bank: statements,
// movements and payments seen on them (ControleBanque).

const { immeubleId, pret } = useImmeuble()
const { start, end } = useExercice()
const couverture = ref<Couverture | null>(null)
const erreur = ref<string | null>(null)

async function charger() {
  if (immeubleId.value === null) {
    return
  }
  try {
    couverture.value = await api.couverture({ building: immeubleId.value, start: start.value, end: end.value })
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

const nbTrous = computed(() => (couverture.value?.energies ?? []).reduce((n, e) => n + e.trous.length, 0))
const problemesFactures = computed(() =>
  nbTrous.value + (couverture.value?.brouillons.length ?? 0) + (couverture.value?.chevauchements.length ?? 0))

const pistes = computed<Piste[]>(() =>
  (couverture.value?.energies ?? []).map((e) => ({
    label: ENERGIES[e.energy],
    segments: [
      ...e.covered.map((p) => ({ ...p, label: '', classe: 'covered', title: `Couvert : ${dateFr(p.start)} → ${dateFr(p.end)}` })),
      ...e.trous.map((p) => ({ ...p, label: 'trou', classe: 'trou', title: `Aucune facture validée : ${dateFr(p.start)} → ${dateFr(p.end)}` })),
    ],
  })),
)
</script>

<template>
  <section class="entete-page">
    <h1>Contrôles</h1>
    <ChoixExercice />
  </section>
  <p v-if="erreur" class="message erreur">{{ erreur }}</p>

  <section v-if="couverture" class="bloc">
    <h2>Factures</h2>
    <p class="bilan" :class="problemesFactures ? 'ko' : 'ok'">
      <template v-if="problemesFactures">
        {{ nbTrous }} trou(s) · {{ couverture.brouillons.length }} brouillon(s) · {{ couverture.chevauchements.length }}
        chevauchement(s)
      </template>
      <template v-else>✓ Chaque jour de l'exercice est couvert par une facture validée, une seule fois</template>
    </p>
    <p class="discret">
      Gaz et électricité : lignes de consommation ; eau et ordures ménagères : toutes les lignes récupérables.
    </p>
    <Frise :start="couverture.start" :end="couverture.end" :pistes="pistes" />

    <template v-if="nbTrous">
      <h3>Trous</h3>
      <ul class="constats">
        <template v-for="e in couverture.energies" :key="e.energy">
          <li v-for="t in e.trous" :key="t.start" class="erreur">
            <strong>{{ ENERGIES[e.energy] }}</strong> : aucune facture validée du {{ dateFr(t.start) }} au {{ dateFr(t.end) }}
          </li>
        </template>
      </ul>
    </template>

    <template v-if="couverture.brouillons.length">
      <h3>Brouillons sur la période</h3>
      <ul class="constats">
        <li v-for="b in couverture.brouillons" :key="b.id" class="avertissement">
          <RouterLink :to="{ name: 'invoice', params: { id: b.id } }">{{ b.supplier }} n° {{ b.number }}</RouterLink>
          ({{ ENERGIES[b.energy] }}, {{ dateFr(b.invoice_date) }}) : à vérifier puis valider pour qu'elle compte
        </li>
      </ul>
    </template>

    <template v-if="couverture.chevauchements.length">
      <h3>Chevauchements</h3>
      <table class="liste">
        <thead>
          <tr><th>Énergie</th><th>Jours comptés deux fois</th><th>Ligne</th><th>Avec la ligne</th></tr>
        </thead>
        <tbody>
          <tr v-for="(c, i) in couverture.chevauchements" :key="i" class="sans-clic">
            <td>{{ ENERGIES[c.energy] }}</td>
            <td>{{ dateFr(c.start) }} → {{ dateFr(c.end) }}</td>
            <td>
              <RouterLink :to="{ name: 'invoice', params: { id: c.line_a.invoice_id } }">{{ c.line_a.number }}</RouterLink>
              {{ c.line_a.label }} ({{ dateFr(c.line_a.start) }} → {{ dateFr(c.line_a.end) }})
            </td>
            <td>
              <RouterLink :to="{ name: 'invoice', params: { id: c.line_b.invoice_id } }">{{ c.line_b.number }}</RouterLink>
              {{ c.line_b.label }} ({{ dateFr(c.line_b.start) }} → {{ dateFr(c.line_b.end) }})
            </td>
          </tr>
        </tbody>
      </table>
    </template>
  </section>

  <PaiementsRecus v-if="immeubleId !== null" :building="immeubleId" :start="start" :end="end" />
  <RegularisationsRecues v-if="immeubleId !== null" :building="immeubleId" :start="start" :end="end" />
  <ControleBanque v-if="immeubleId !== null" :building="immeubleId" :start="start" :end="end" />
</template>

<script setup lang="ts">
import Big from 'big.js'
import { computed, onMounted, ref, watch } from 'vue'

import { api, type Provision, type Sejour } from '../api'
import { dateFr, euros, nombreApi, nombreFr } from '../format'
import { useImmeuble } from '../immeuble'

// Provisions paid, per stay and calendar year (SPEC R9): one amount per stay present during the year.

type Saisie = { tenancy: Sejour, charge_advance: Provision | null, amount: string, note: string }

const { immeubleId, pret } = useImmeuble()
const tenancies = ref<Sejour[]>([])
const advances = ref<Provision[]>([])
const year = ref(new Date().getFullYear() - 1)
const saisies = ref<Saisie[]>([])
const message = ref<{ text: string, type: 'info' | 'erreur' } | null>(null)

async function charger() {
  if (immeubleId.value === null) {
    return
  }
  ;[tenancies.value, advances.value] = await Promise.all([api.tenancies(immeubleId.value), api.advances(immeubleId.value)])
  preparer()
}

const presentPendant = (s: Sejour, a: number) => s.move_in <= `${a}-12-31` && (s.move_out === null || s.move_out >= `${a}-01-01`)

function preparer() {
  saisies.value = tenancies.value
    .filter((s) => presentPendant(s, year.value))
    .map((tenancy) => {
      const charge_advance = advances.value.find((p) => p.tenancy_id === tenancy.id && p.year === year.value) ?? null
      return { tenancy, charge_advance, amount: nombreFr(charge_advance?.amount ?? null), note: charge_advance?.note ?? '' }
    })
}

onMounted(async () => {
  await pret
  await charger().catch((e) => { message.value = { text: e.message, type: 'erreur' } })
})
watch(immeubleId, charger)
watch(year, preparer)

// Every year from the first stay of the building to the current one (plus any year that already has a provision)
const annees = computed(() => {
  const current = new Date().getFullYear()
  const premiere = Math.min(current, ...tenancies.value.map((s) => Number(s.move_in.slice(0, 4))))
  const toutes = new Set(advances.value.map((p) => p.year))
  for (let a = premiere; a <= current; a++) {
    toutes.add(a)
  }
  return [...toutes].sort((a, b) => b - a)
})

// Sum of the stored amounts (decimal, not float)
const total = computed(() =>
  saisies.value.reduce((sum, s) => (s.charge_advance ? sum.plus(s.charge_advance.amount) : sum), new Big(0)).toString())

const attendance = (s: Sejour) => {
  const start = s.move_in > `${year.value}-01-01` ? s.move_in : `${year.value}-01-01`
  const end = s.move_out !== null && s.move_out < `${year.value}-12-31` ? s.move_out : `${year.value}-12-31`
  return `${dateFr(start)} → ${dateFr(end)}`
}

async function enregistrer(saisie: Saisie) {
  try {
    const amount = nombreApi(saisie.amount)
    if (amount === null) {
      if (saisie.charge_advance?.id && confirm('Montant vide : supprimer la provision de cette année ?')) {
        await api.supprimerProvision(saisie.charge_advance.id)
      }
    } else {
      await api.enregistrerProvision({ tenancy_id: saisie.tenancy.id, year: year.value, amount, note: saisie.note || null })
    }
    message.value = { text: `Provision ${year.value} de ${saisie.tenancy.tenant} enregistrée`, type: 'info' }
    await charger()
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
  }
}
</script>

<template>
  <section class="entete-page">
    <h1>Provisions</h1>
    <label>Année
      <select v-model="year">
        <option v-for="a in annees" :key="a" :value="a">{{ a }}</option>
      </select>
    </label>
  </section>
  <p class="discret">
    Provisions sur charges versées pendant l'année civile, par séjour. Dès qu'une année a des paiements mensuels
    (écran Paiements), ses provisions en sont la somme ; sinon, on saisit ici le total de l'année (historique). Un
    exercice sur plusieurs années additionne les années concernées (R9).
  </p>
  <p v-if="message" class="message" :class="message.type">{{ message.text }}</p>

  <table class="liste">
    <thead>
      <tr><th>Lot</th><th>Locataire</th><th>Présence en {{ year }}</th><th class="nombre">Provisions {{ year }}</th><th>Note</th><th /></tr>
    </thead>
    <tbody>
      <tr v-for="s in saisies" :key="s.tenancy.id" class="sans-clic">
        <td>{{ s.tenancy.unit }}</td>
        <td>{{ s.tenancy.tenant }}</td>
        <td>{{ attendance(s.tenancy) }}</td>
        <template v-if="s.charge_advance?.source === 'payments'">
          <td class="nombre">{{ euros(s.charge_advance.amount) }}</td>
          <td colspan="2" class="discret">
            Somme des provisions des <RouterLink to="/paiements">paiements mensuels</RouterLink> de {{ year }}
          </td>
        </template>
        <template v-else>
          <td class="nombre"><input v-model="s.amount" class="nombre" size="10" :placeholder="s.charge_advance ? '' : 'non saisi'"></td>
          <td><input v-model="s.note" size="28" placeholder="ex. 7 × 130 + 5 × 170"></td>
          <td><button type="button" @click="enregistrer(s)">Enregistrer</button></td>
        </template>
      </tr>
    </tbody>
    <tfoot>
      <tr>
        <th colspan="3">Total enregistré</th>
        <th class="nombre">{{ euros(total) }}</th>
        <th colspan="2" />
      </tr>
    </tfoot>
  </table>
</template>

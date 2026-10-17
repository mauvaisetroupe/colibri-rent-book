<script setup lang="ts">
import Big from 'big.js'
import { computed, onMounted, ref, watch } from 'vue'

import { api, type Provision, type Sejour } from '../api'
import { dateFr, euros, nombreApi, nombreFr } from '../format'
import { useImmeuble } from '../immeuble'

// Provisions paid, per stay and calendar year (SPEC R9): one amount per stay present during the year.

type Saisie = { sejour: Sejour, provision: Provision | null, montant: string, note: string }

const { immeubleId, pret } = useImmeuble()
const sejours = ref<Sejour[]>([])
const provisions = ref<Provision[]>([])
const annee = ref(new Date().getFullYear() - 1)
const saisies = ref<Saisie[]>([])
const message = ref<{ texte: string, type: 'info' | 'erreur' } | null>(null)

async function charger() {
  if (immeubleId.value === null) {
    return
  }
  ;[sejours.value, provisions.value] = await Promise.all([api.sejours(immeubleId.value), api.provisions(immeubleId.value)])
  preparer()
}

const presentPendant = (s: Sejour, a: number) => s.entree <= `${a}-12-31` && (s.sortie === null || s.sortie >= `${a}-01-01`)

function preparer() {
  saisies.value = sejours.value
    .filter((s) => presentPendant(s, annee.value))
    .map((sejour) => {
      const provision = provisions.value.find((p) => p.sejour_id === sejour.id && p.annee === annee.value) ?? null
      return { sejour, provision, montant: nombreFr(provision?.montant ?? null), note: provision?.note ?? '' }
    })
}

onMounted(async () => {
  await pret
  await charger().catch((e) => { message.value = { texte: e.message, type: 'erreur' } })
})
watch(immeubleId, charger)
watch(annee, preparer)

// Every year from the first stay of the building to the current one (plus any year that already has a provision)
const annees = computed(() => {
  const courante = new Date().getFullYear()
  const premiere = Math.min(courante, ...sejours.value.map((s) => Number(s.entree.slice(0, 4))))
  const toutes = new Set(provisions.value.map((p) => p.annee))
  for (let a = premiere; a <= courante; a++) {
    toutes.add(a)
  }
  return [...toutes].sort((a, b) => b - a)
})

// Sum of the stored amounts (decimal, not float)
const total = computed(() =>
  saisies.value.reduce((sum, s) => (s.provision ? sum.plus(s.provision.montant) : sum), new Big(0)).toString())

const presence = (s: Sejour) => {
  const debut = s.entree > `${annee.value}-01-01` ? s.entree : `${annee.value}-01-01`
  const fin = s.sortie !== null && s.sortie < `${annee.value}-12-31` ? s.sortie : `${annee.value}-12-31`
  return `${dateFr(debut)} → ${dateFr(fin)}`
}

async function enregistrer(saisie: Saisie) {
  try {
    const montant = nombreApi(saisie.montant)
    if (montant === null) {
      if (saisie.provision?.id && confirm('Montant vide : supprimer la provision de cette année ?')) {
        await api.supprimerProvision(saisie.provision.id)
      }
    } else {
      await api.enregistrerProvision({ sejour_id: saisie.sejour.id, annee: annee.value, montant, note: saisie.note || null })
    }
    message.value = { texte: `Provision ${annee.value} de ${saisie.sejour.locataire} enregistrée`, type: 'info' }
    await charger()
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}
</script>

<template>
  <section class="entete-page">
    <h1>Provisions</h1>
    <label>Année
      <select v-model="annee">
        <option v-for="a in annees" :key="a" :value="a">{{ a }}</option>
      </select>
    </label>
  </section>
  <p class="discret">
    Provisions sur charges versées pendant l'année civile, par séjour. Dès qu'une année a des paiements mensuels
    (écran Paiements), ses provisions en sont la somme ; sinon, on saisit ici le total de l'année (historique). Un
    exercice sur plusieurs années additionne les années concernées (R9).
  </p>
  <p v-if="message" class="message" :class="message.type">{{ message.texte }}</p>

  <table class="liste">
    <thead>
      <tr><th>Lot</th><th>Locataire</th><th>Présence en {{ annee }}</th><th class="nombre">Provisions {{ annee }}</th><th>Note</th><th /></tr>
    </thead>
    <tbody>
      <tr v-for="s in saisies" :key="s.sejour.id" class="sans-clic">
        <td>{{ s.sejour.lot }}</td>
        <td>{{ s.sejour.locataire }}</td>
        <td>{{ presence(s.sejour) }}</td>
        <template v-if="s.provision?.source === 'paiements'">
          <td class="nombre">{{ euros(s.provision.montant) }}</td>
          <td colspan="2" class="discret">
            Somme des provisions des <RouterLink to="/paiements">paiements mensuels</RouterLink> de {{ annee }}
          </td>
        </template>
        <template v-else>
          <td class="nombre"><input v-model="s.montant" class="nombre" size="10" :placeholder="s.provision ? '' : 'non saisi'"></td>
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

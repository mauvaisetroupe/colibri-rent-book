<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { useExercice } from '../exercice'
import { dateFr } from '../format'

// Exercise picker, beside the page title: one click per calendar year, or « Autre période » for any two dates (both
// included) in a small panel.

const { start, end, choisir, year } = useExercice()

const current = new Date().getFullYear()
const annees = computed(() => [current - 3, current - 2, current - 1, current])
const estAnnee = (a: number) => start.value === `${a}-01-01` && end.value === `${a}-12-31`
const autrePeriode = computed(() => !annees.value.some(estAnnee))

const ouvert = ref(false)
const saisieDebut = ref(start.value)
const saisieFin = ref(end.value)
const racine = ref<HTMLElement | null>(null)

function basculer() {
  saisieDebut.value = start.value
  saisieFin.value = end.value
  ouvert.value = !ouvert.value
}

const valide = computed(() => Boolean(saisieDebut.value && saisieFin.value && saisieDebut.value <= saisieFin.value))

function appliquer() {
  if (valide.value) {
    choisir(saisieDebut.value, saisieFin.value)
    ouvert.value = false
  }
}

// Closes on a click outside or on Escape
function clicDehors(event: MouseEvent) {
  if (!racine.value?.contains(event.target as Node)) {
    ouvert.value = false
  }
}
function touche(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    ouvert.value = false
  }
}
function ecouter(oui: boolean) {
  if (oui) {
    document.addEventListener('mousedown', clicDehors)
    document.addEventListener('keydown', touche)
  } else {
    document.removeEventListener('mousedown', clicDehors)
    document.removeEventListener('keydown', touche)
  }
}
watch(ouvert, ecouter)
onBeforeUnmount(() => ecouter(false))
</script>

<template>
  <div ref="racine" class="choix-exercice">
    <button v-for="a in annees" :key="a" type="button" :class="{ actif: estAnnee(a) }" @click="year(a)">{{ a }}</button>
    <button type="button" :class="{ actif: autrePeriode }" :aria-expanded="ouvert" @click="basculer">
      {{ autrePeriode ? `${dateFr(start)} → ${dateFr(end)}` : 'Autre période…' }}
    </button>

    <form v-if="ouvert" class="panneau" @submit.prevent="appliquer">
      <label>Du <input v-model="saisieDebut" type="date" required></label>
      <label>Au (inclus) <input v-model="saisieFin" type="date" required></label>
      <p v-if="saisieDebut && saisieFin && !valide" class="ko">La fin est avant le début.</p>
      <div class="boutons-panneau">
        <button type="submit" class="principal" :disabled="!valide">Appliquer</button>
        <button type="button" @click="ouvert = false">Annuler</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.choix-exercice {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}

.panneau {
  position: absolute;
  top: calc(100% + 0.3rem);
  right: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.8rem;
  border: 1px solid var(--bord);
  border-radius: 8px;
  background: var(--fond);
  box-shadow: 0 6px 18px rgb(0 0 0 / 12%);
}

.panneau label {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.85rem;
  color: var(--discret);
}

.panneau p {
  margin: 0;
}

.boutons-panneau {
  display: flex;
  gap: 0.5rem;
}
</style>

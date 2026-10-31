<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

// Month picker that works in every browser ('AAAA-MM'): <input type="month"> has no picker in Firefox and an
// awkward one for the year in Chrome. A button opens a calendar of the 12 months of a year; previous / next month
// buttons beside it for the usual case. « facultatif »: the value may stay empty (no month), shown as « — ».

const props = defineProps<{ modelValue: string, facultatif?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre',
  'novembre', 'décembre']
const MOIS_COURTS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']

const ceMois = new Date().toISOString().slice(0, 7)
// Empty value (nothing chosen yet): the current month is shown, or « — » when the month is optional
const vide = computed(() => !props.modelValue && props.facultatif)
const valeur = computed(() => props.modelValue || ceMois)
const year = computed(() => Number(valeur.value.slice(0, 4)))
const month = computed(() => Number(valeur.value.slice(5, 7)))

const ouvert = ref(false)
// Year shown in the calendar, browsed without changing the value
const anneeAffichee = ref(year.value)
const racine = ref<HTMLElement | null>(null)

const cle = (a: number, m: number) => `${a}-${String(m).padStart(2, '0')}`

function choisir(a: number, m: number) {
  emit('update:modelValue', cle(a, m))
  ouvert.value = false
}

function effacer() {
  emit('update:modelValue', '')
  ouvert.value = false
}

function decaler(n: number) {
  const index = year.value * 12 + month.value - 1 + n
  choisir(Math.floor(index / 12), (index % 12) + 1)
}

function basculer() {
  anneeAffichee.value = year.value
  ouvert.value = !ouvert.value
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
watch(ouvert, (o) => {
  if (o) {
    document.addEventListener('mousedown', clicDehors)
    document.addEventListener('keydown', touche)
  } else {
    document.removeEventListener('mousedown', clicDehors)
    document.removeEventListener('keydown', touche)
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', clicDehors)
  document.removeEventListener('keydown', touche)
})
</script>

<template>
  <span ref="racine" class="choix-mois">
    <button v-if="!vide" type="button" title="Mois précédent" aria-label="Mois précédent" @click="decaler(-1)">‹</button>
    <button type="button" class="valeur" :aria-expanded="ouvert" aria-haspopup="dialog" @click="basculer">
      {{ vide ? '—' : `${MOIS[month - 1]} ${year}` }}
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path fill="currentColor" d="M4.5 0a.5.5 0 0 1 .5.5V1h6V.5a.5.5 0 0 1 1 0V1h1.5A1.5 1.5 0 0 1 15 2.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 13.5v-11A1.5 1.5 0 0 1 2.5 1H4V.5a.5.5 0 0 1 .5-.5ZM2 5v8.5a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5V5H2Z" />
      </svg>
    </button>
    <button v-if="!vide" type="button" title="Mois suivant" aria-label="Mois suivant" @click="decaler(1)">›</button>

    <div v-if="ouvert" class="calendrier" role="dialog" aria-label="Choisir un mois">
      <div class="annee">
        <button type="button" aria-label="Année précédente" @click="anneeAffichee--">‹</button>
        <strong>{{ anneeAffichee }}</strong>
        <button type="button" aria-label="Année suivante" @click="anneeAffichee++">›</button>
      </div>
      <div class="grille-mois">
        <button
          v-for="(name, i) in MOIS_COURTS"
          :key="i"
          type="button"
          :class="{ choisi: !vide && cle(anneeAffichee, i + 1) === valeur, courant: cle(anneeAffichee, i + 1) === ceMois }"
          :aria-label="`${MOIS[i]} ${anneeAffichee}`"
          @click="choisir(anneeAffichee, i + 1)"
        >{{ name }}</button>
      </div>
      <button v-if="facultatif" type="button" class="aucun" @click="effacer">Aucun mois</button>
    </div>
  </span>
</template>

<style scoped>
.choix-mois {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}

.valeur {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 8.5rem;
  white-space: nowrap;
  justify-content: space-between;
}

.calendrier {
  position: absolute;
  top: calc(100% + 0.3rem);
  left: 0;
  z-index: 10;
  padding: 0.6rem;
  border: 1px solid var(--bord);
  border-radius: 8px;
  background: var(--fond);
  box-shadow: 0 6px 18px rgb(0 0 0 / 12%);
}

.annee {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}

.grille-mois {
  display: grid;
  grid-template-columns: repeat(3, 4.5rem);
  gap: 0.3rem;
}

.grille-mois button {
  padding: 0.4rem 0;
}

.grille-mois button.courant {
  border-color: var(--accent);
}

.aucun {
  width: 100%;
  margin-top: 0.5rem;
}

.grille-mois button.choisi {
  background: var(--accent);
  border-color: var(--accent);
  color: #ffffff;
}
</style>

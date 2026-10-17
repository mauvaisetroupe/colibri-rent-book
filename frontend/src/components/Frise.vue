<script setup lang="ts">
import { computed } from 'vue'

import { dateFr } from '../format'

// Periods drawn on a time axis: one track per lot (stays) or per energy (coverage). Bounds are inclusive ISO
// dates; an open segment (fin null) runs to the end of the window.

export type Segment = { debut: string, fin: string | null, libelle: string, classe?: string, titre?: string }
export type Piste = { libelle: string, segments: Segment[] }

const props = defineProps<{ debut: string, fin: string, pistes: Piste[] }>()

const jour = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000
const origine = computed(() => jour(props.debut))
const etendue = computed(() => jour(props.fin) + 1 - origine.value)

function position(s: Segment) {
  const debut = Math.max(jour(s.debut), origine.value)
  const fin = Math.min(s.fin === null ? Infinity : jour(s.fin) + 1, origine.value + etendue.value)
  return {
    left: `${((debut - origine.value) / etendue.value) * 100}%`,
    width: `${(Math.max(fin - debut, 0) / etendue.value) * 100}%`,
  }
}

const visibles = (piste: Piste) =>
  piste.segments.filter((s) => (s.fin === null || s.fin >= props.debut) && s.debut <= props.fin)

// One tick per 1st of January inside the window
const graduations = computed(() => {
  const result: { libelle: string, left: string }[] = []
  for (let annee = Number(props.debut.slice(0, 4)); annee <= Number(props.fin.slice(0, 4)) + 1; annee++) {
    const j = jour(`${annee}-01-01`)
    if (j >= origine.value && j <= origine.value + etendue.value) {
      result.push({ libelle: String(annee), left: `${((j - origine.value) / etendue.value) * 100}%` })
    }
  }
  return result
})
</script>

<template>
  <div class="frise">
    <div class="frise-axe">
      <span v-for="g in graduations" :key="g.libelle" class="frise-graduation" :style="{ left: g.left }">{{ g.libelle }}</span>
    </div>
    <div v-for="piste in pistes" :key="piste.libelle" class="frise-piste">
      <div class="frise-libelle">{{ piste.libelle }}</div>
      <div class="frise-rail">
        <span v-for="g in graduations" :key="g.libelle" class="frise-repere" :style="{ left: g.left }" />
        <div
          v-for="(s, i) in visibles(piste)"
          :key="i"
          class="frise-segment"
          :class="s.classe"
          :style="position(s)"
          :title="s.titre ?? `${s.libelle} : ${dateFr(s.debut)} → ${s.fin ? dateFr(s.fin) : 'en cours'}`"
        >
          {{ s.libelle }}
        </div>
      </div>
    </div>
  </div>
</template>

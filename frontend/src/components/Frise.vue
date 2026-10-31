<script setup lang="ts">
import { computed } from 'vue'

import { dateFr } from '../format'

// Periods drawn on a time axis: one track per lot (stays) or per energy (coverage). Bounds are inclusive ISO
// dates; an open segment (fin null) runs to the end of the window.

export type Segment = { start: string, end: string | null, label: string, classe?: string, title?: string }
export type Piste = { label: string, segments: Segment[] }

const props = defineProps<{ start: string, end: string, pistes: Piste[] }>()

const jour = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000
const origin = computed(() => jour(props.start))
const span = computed(() => jour(props.end) + 1 - origin.value)

function position(s: Segment) {
  const start = Math.max(jour(s.start), origin.value)
  const end = Math.min(s.end === null ? Infinity : jour(s.end) + 1, origin.value + span.value)
  return {
    left: `${((start - origin.value) / span.value) * 100}%`,
    width: `${(Math.max(end - start, 0) / span.value) * 100}%`,
  }
}

const visibles = (piste: Piste) =>
  piste.segments.filter((s) => (s.end === null || s.end >= props.start) && s.start <= props.end)

// One tick per 1st of January inside the window
const graduations = computed(() => {
  const result: { label: string, left: string }[] = []
  for (let year = Number(props.start.slice(0, 4)); year <= Number(props.end.slice(0, 4)) + 1; year++) {
    const j = jour(`${year}-01-01`)
    if (j >= origin.value && j <= origin.value + span.value) {
      result.push({ label: String(year), left: `${((j - origin.value) / span.value) * 100}%` })
    }
  }
  return result
})
</script>

<template>
  <div class="frise">
    <div class="frise-axe">
      <span v-for="g in graduations" :key="g.label" class="frise-graduation" :style="{ left: g.left }">{{ g.label }}</span>
    </div>
    <div v-for="piste in pistes" :key="piste.label" class="frise-piste">
      <div class="frise-libelle">{{ piste.label }}</div>
      <div class="frise-rail">
        <span v-for="g in graduations" :key="g.label" class="frise-repere" :style="{ left: g.left }" />
        <div
          v-for="(s, i) in visibles(piste)"
          :key="i"
          class="frise-segment"
          :class="s.classe"
          :style="position(s)"
          :title="s.title ?? `${s.label} : ${dateFr(s.start)} → ${s.end ? dateFr(s.end) : 'en cours'}`"
        >
          {{ s.label }}
        </div>
      </div>
    </div>
  </div>
</template>

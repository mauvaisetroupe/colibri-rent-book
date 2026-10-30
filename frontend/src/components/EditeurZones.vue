<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'

import type { ZoneSaisie } from '../api'
import type { ApercuPage } from '../extraction/navigateur'

// Zones masked on the scans of an invoice, drawn with the mouse (ADR 0025): on a scanned page, dragging on the page
// draws a zone, dragging a zone moves it, its corner resizes it, × or the Delete key removes the selected one. A page of
// text is shown without zones: the masked terms and the extractor mask it. Bounds in fractions of the page.

const props = defineProps<{ modelValue: ZoneSaisie[], contenu: Uint8Array | null, largeur?: number }>()
const emit = defineEmits<{ 'update:modelValue': [zones: ZoneSaisie[]] }>()

const LARGEUR = props.largeur ?? 620
// Smaller than this (fraction of the page), a drawn zone is a click: not kept
const MINIMUM = 0.005

const pages = ref<ApercuPage[]>([])
const chargement = ref(false)
const erreur = ref<string | null>(null)
// Index of the selected zone in modelValue
const choisie = ref<number | null>(null)

function oublierPages() {
  pages.value.forEach((p) => URL.revokeObjectURL(p.url))
  pages.value = []
}

watch(() => props.contenu, async (contenu) => {
  oublierPages()
  choisie.value = null
  erreur.value = null
  if (!contenu) {
    return
  }
  chargement.value = true
  try {
    const { apercuPages } = await import('../extraction/navigateur')
    pages.value = await apercuPages(contenu.slice(), LARGEUR)
  } catch (e) {
    erreur.value = (e as Error).message
  } finally {
    chargement.value = false
  }
}, { immediate: true })

onBeforeUnmount(() => {
  oublierPages()
  document.removeEventListener('keydown', touche)
})

const arrondi = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000

/** The point of a pointer event in fractions of the page under it. */
function point(event: PointerEvent, surface: HTMLElement) {
  const r = surface.getBoundingClientRect()
  return { x: (event.clientX - r.left) / r.width, y: (event.clientY - r.top) / r.height }
}

// What a drag does: draw a new zone, move a zone, resize it from a corner
type Geste = { type: 'tracer' | 'deplacer' | 'coin', index: number, depart: { x: number, y: number }, avant: ZoneSaisie }
let geste: Geste | null = null

function remplacer(index: number, zone: ZoneSaisie) {
  emit('update:modelValue', props.modelValue.map((z, i) => (i === index ? zone : z)))
}

function commencer(event: PointerEvent, page: number, type: Geste['type'], index: number | null) {
  if (event.button !== 0) {
    return
  }
  const surface = (event.currentTarget as HTMLElement).closest('.surface') as HTMLElement
  surface.setPointerCapture(event.pointerId)
  const depart = point(event, surface)
  if (type === 'tracer') {
    const zone = { page, x0: arrondi(depart.x), y0: arrondi(depart.y), x1: arrondi(depart.x), y1: arrondi(depart.y) }
    emit('update:modelValue', [...props.modelValue, zone])
    index = props.modelValue.length
  }
  choisie.value = index
  geste = { type, index: index!, depart, avant: { ...(props.modelValue[index!] ?? { page, x0: depart.x, y0: depart.y, x1: depart.x, y1: depart.y }) } }
  event.stopPropagation()
}

function suivre(event: PointerEvent) {
  if (!geste) {
    return
  }
  const p = point(event, event.currentTarget as HTMLElement)
  const { avant, depart } = geste
  if (geste.type === 'tracer') {
    remplacer(geste.index, {
      page: avant.page, x0: arrondi(Math.min(depart.x, p.x)), y0: arrondi(Math.min(depart.y, p.y)),
      x1: arrondi(Math.max(depart.x, p.x)), y1: arrondi(Math.max(depart.y, p.y)),
    })
  } else if (geste.type === 'deplacer') {
    // The whole zone stays on the page
    const dx = Math.min(1 - avant.x1, Math.max(-avant.x0, p.x - depart.x))
    const dy = Math.min(1 - avant.y1, Math.max(-avant.y0, p.y - depart.y))
    remplacer(geste.index, {
      page: avant.page, x0: arrondi(avant.x0 + dx), y0: arrondi(avant.y0 + dy), x1: arrondi(avant.x1 + dx), y1: arrondi(avant.y1 + dy),
    })
  } else {
    remplacer(geste.index, {
      page: avant.page, x0: avant.x0, y0: avant.y0,
      x1: arrondi(Math.max(avant.x0 + MINIMUM, p.x)), y1: arrondi(Math.max(avant.y0 + MINIMUM, p.y)),
    })
  }
}

function finir() {
  if (geste?.type === 'tracer') {
    const z = props.modelValue[geste.index]
    if (z && (z.x1 - z.x0 < MINIMUM || z.y1 - z.y0 < MINIMUM)) {
      supprimer(geste.index)
    }
  }
  geste = null
}

function supprimer(index: number) {
  emit('update:modelValue', props.modelValue.filter((_, i) => i !== index))
  choisie.value = null
}

function touche(event: KeyboardEvent) {
  const cible = event.target as HTMLElement
  if (choisie.value !== null && (event.key === 'Delete' || event.key === 'Backspace')
    && !['INPUT', 'TEXTAREA', 'SELECT'].includes(cible.tagName)) {
    event.preventDefault()
    supprimer(choisie.value)
  }
}
document.addEventListener('keydown', touche)

const pourcent = (v: number) => `${(v * 100).toFixed(3)}%`
</script>

<template>
  <div class="editeur-zones">
    <p v-if="chargement" class="discret">Dessin des pages…</p>
    <p v-if="erreur" class="ko">PDF illisible : {{ erreur }}</p>
    <div v-for="(page, i) in pages" :key="page.url" class="page-zones">
      <p class="discret">
        Page {{ i + 1 }} :
        <template v-if="page.scannee">scan, tracer à la souris ce qui est à masquer</template>
        <template v-else>texte, masquée par les termes et l'extracteur (pas de zones)</template>
      </p>
      <div
        class="surface" :class="{ scannee: page.scannee }" :style="{ width: `${LARGEUR}px`, aspectRatio: `${page.largeur} / ${page.hauteur}` }"
        @pointerdown="page.scannee && commencer($event, i + 1, 'tracer', null)" @pointermove="suivre" @pointerup="finir"
        @pointercancel="finir"
      >
        <img :src="page.url" alt="" draggable="false">
        <template v-if="page.scannee">
          <template v-for="(z, index) in modelValue" :key="index">
            <div
              v-if="z.page === i + 1" class="zone" :class="{ choisie: choisie === index }"
              :style="{ left: pourcent(z.x0), top: pourcent(z.y0), width: pourcent(z.x1 - z.x0), height: pourcent(z.y1 - z.y0) }"
              @pointerdown="commencer($event, i + 1, 'deplacer', index)"
            >
              <button
                v-if="choisie === index" type="button" class="retirer" title="Retirer cette zone"
                @pointerdown.stop @click="supprimer(index)"
              >×</button>
              <span class="coin" title="Redimensionner" @pointerdown="commencer($event, i + 1, 'coin', index)"></span>
            </div>
          </template>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-zones {
  margin-bottom: 1rem;
}
.surface {
  position: relative;
  max-width: 100%;
  border: 1px solid var(--bord);
  user-select: none;
  touch-action: none;
}
.surface.scannee {
  cursor: crosshair;
}
.surface img {
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.zone {
  position: absolute;
  background: rgb(0 0 0 / 0.65);
  outline: 1px solid #000;
  cursor: move;
}
.zone.choisie {
  outline: 2px solid var(--accent);
}
.retirer {
  position: absolute;
  top: -0.9rem;
  right: -0.9rem;
  width: 1.6rem;
  height: 1.6rem;
  padding: 0;
  border-radius: 50%;
  line-height: 1;
}
.coin {
  position: absolute;
  right: -5px;
  bottom: -5px;
  width: 10px;
  height: 10px;
  background: var(--accent);
  cursor: nwse-resize;
}
</style>

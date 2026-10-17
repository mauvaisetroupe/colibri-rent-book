<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'

import { api } from './api'
import { useImmeuble } from './immeuble'

const { immeubles, immeubleId } = useImmeuble()

// The screens set once (buildings, company, providers) sit in the « Réglages » menu, at the right of the bar
const REGLAGES = [
  { to: '/immeuble', nom: 'Immeuble' },
  { to: '/societe', nom: 'Société et associés' },
  { to: '/fournisseurs', nom: 'Fournisseurs' },
]
const route = useRoute()
const reglages = ref<HTMLElement | null>(null)
const ouvert = ref(false)
const reglageActif = computed(() => REGLAGES.some((r) => route.path.startsWith(r.to)))
watch(() => route.fullPath, () => { ouvert.value = false })
const fermer = (event: Event) => {
  if (ouvert.value && !reglages.value?.contains(event.target as Node)) {
    ouvert.value = false
  }
}
const echap = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    ouvert.value = false
  }
}
onMounted(() => {
  document.addEventListener('click', fermer)
  document.addEventListener('keydown', echap)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', fermer)
  document.removeEventListener('keydown', echap)
})

// The commit of colibri-rent-book running (shown at the right of the bar, linked to GitHub); « dev » in development
const version = ref<string | null>(null)
onMounted(async () => {
  version.value = (await api.sante().catch(() => null))?.version ?? null
})
</script>

<template>
  <header class="barre">
    <RouterLink to="/" class="marque" title="Accueil">
      <svg viewBox="0 0 40 32" aria-hidden="true" class="marque-logo">
        <path d="M1 10.5 L10.5 12.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        <circle cx="12.8" cy="12.2" r="2.9" fill="currentColor" />
        <path d="M11 14 C13 19.5 19.5 22.5 25.5 22.5 L33.5 30 L31 23.5 L36 25 L28.5 20 C25.5 16 20 13 15 11.2 Z" fill="currentColor" />
        <path d="M15.5 11.6 C17.5 6 23 1.8 31.5 0.8 C28.5 5 24.5 10 19.5 14.5 Z" fill="currentColor" opacity="0.5" />
      </svg>
      <span class="marque-texte">Colibri<small>rent book</small></span>
    </RouterLink>
    <nav>
      <div class="groupe premier">
        <span class="groupe-titre">Vue d'ensemble</span>
        <RouterLink to="/" class="accueil">Accueil</RouterLink>
      </div>
      <div class="groupe">
        <span class="groupe-titre">Tenue des comptes</span>
        <RouterLink to="/factures">Factures</RouterLink>
        <RouterLink to="/paiements">Paiements</RouterLink>
        <RouterLink to="/travaux">Travaux</RouterLink>
        <RouterLink to="/sejours">Locataires</RouterLink>
      </div>
      <div class="groupe">
        <span class="groupe-titre">Bilan de l'exercice</span>
        <RouterLink to="/controles">Contrôles</RouterLink>
        <RouterLink to="/decompte">Décompte</RouterLink>
        <RouterLink to="/regularisations">Régularisations</RouterLink>
      </div>
      <div class="groupe">
        <span class="groupe-titre">Clôture</span>
        <RouterLink to="/fiscal">Synthèse fiscale</RouterLink>
        <RouterLink to="/assemblees">Assemblées</RouterLink>
      </div>
    </nav>
    <select v-if="immeubles.length > 1" v-model="immeubleId" class="choix-immeuble" aria-label="Immeuble">
      <option v-for="i in immeubles" :key="i.id" :value="i.id">{{ i.nom }}</option>
    </select>
    <div ref="reglages" class="reglages">
      <button
        type="button" class="reglages-bouton" :class="{ actif: reglageActif }" :aria-expanded="ouvert"
        @click="ouvert = !ouvert"
      >⚙ Réglages ▾</button>
      <div v-if="ouvert" class="reglages-menu" role="menu">
        <RouterLink v-for="r in REGLAGES" :key="r.to" :to="r.to" role="menuitem">{{ r.nom }}</RouterLink>
        <a
          v-if="version && version !== 'dev'" class="version" title="Version de colibri-rent-book en service"
          :href="`https://github.com/mauvaisetroupe/colibri-rent-book/commit/${version}`" target="_blank"
        >version {{ version }}</a>
        <span v-else-if="version" class="version">version de développement</span>
      </div>
    </div>
  </header>
  <main>
    <RouterView />
  </main>
</template>

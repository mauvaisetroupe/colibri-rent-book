<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink, RouterView } from 'vue-router'

import { api } from './api'
import { useImmeuble } from './immeuble'

const { immeubles, immeubleId } = useImmeuble()

// The commit of colibri-rent-book running (shown at the right of the bar, linked to GitHub); « dev » in development
const version = ref<string | null>(null)
onMounted(async () => {
  version.value = (await api.sante().catch(() => null))?.version ?? null
})
</script>

<template>
  <header class="barre">
    <RouterLink to="/" class="marque">Colibri</RouterLink>
    <nav>
      <RouterLink to="/" class="accueil">Accueil</RouterLink>
      <div class="groupe">
        <span class="groupe-titre">Tenue des comptes</span>
        <RouterLink to="/factures">Factures</RouterLink>
        <RouterLink to="/paiements">Paiements</RouterLink>
        <RouterLink to="/travaux">Travaux</RouterLink>
      </div>
      <div class="groupe">
        <span class="groupe-titre">Bilan de l'exercice</span>
        <RouterLink to="/controles">Contrôles</RouterLink>
        <RouterLink to="/decompte">Décompte</RouterLink>
        <RouterLink to="/regularisations">Régularisations</RouterLink>
      </div>
      <div class="groupe">
        <span class="groupe-titre">Déclaration</span>
        <RouterLink to="/fiscal">Synthèse fiscale</RouterLink>
      </div>
      <div class="groupe">
        <span class="groupe-titre">Gestion des immeubles</span>
        <RouterLink to="/immeuble">Immeuble</RouterLink>
        <RouterLink to="/sejours">Locataires</RouterLink>
      </div>
      <div class="groupe">
        <span class="groupe-titre">SCI</span>
        <RouterLink to="/societe">Société</RouterLink>
        <RouterLink to="/assemblees">Assemblées</RouterLink>
      </div>
      <div class="groupe">
        <span class="groupe-titre">Administration</span>
        <RouterLink to="/fournisseurs">Fournisseurs</RouterLink>
      </div>
    </nav>
    <select v-if="immeubles.length > 1" v-model="immeubleId" class="choix-immeuble" aria-label="Immeuble">
      <option v-for="i in immeubles" :key="i.id" :value="i.id">{{ i.nom }}</option>
    </select>
    <a
      v-if="version && version !== 'dev'" class="version discret" title="Version de colibri-rent-book en service"
      :href="`https://github.com/mauvaisetroupe/colibri-rent-book/commit/${version}`" target="_blank"
    >version {{ version }}</a>
    <span v-else-if="version" class="version discret">développement</span>
  </header>
  <main>
    <RouterView />
  </main>
</template>

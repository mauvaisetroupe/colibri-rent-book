<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'

import { useImmeuble } from './immeuble'

const { immeubles, immeubleId } = useImmeuble()
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
        <span class="groupe-titre">Administration</span>
        <RouterLink to="/fournisseurs">Fournisseurs</RouterLink>
      </div>
    </nav>
    <select v-if="immeubles.length > 1" v-model="immeubleId" class="choix-immeuble" aria-label="Immeuble">
      <option v-for="i in immeubles" :key="i.id" :value="i.id">{{ i.nom }}</option>
    </select>
    <span v-else-if="immeubles[0]" class="choix-immeuble discret">{{ immeubles[0].nom }}</span>
  </header>
  <main>
    <RouterView />
  </main>
</template>

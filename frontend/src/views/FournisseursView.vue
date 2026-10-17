<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'

import { api, ENERGIES, type Fournisseur } from '../api'

// Suppliers (ADR 0013, 0014): every supplier of an invoice or of an extractor. A supplier opens on its page:
// « confidentiel », and the versions of its extractor.

const router = useRouter()
const fournisseurs = ref<Fournisseur[]>([])
const erreur = ref<string | null>(null)

onMounted(async () => {
  try {
    fournisseurs.value = await api.fournisseurs()
  } catch (e) {
    erreur.value = (e as Error).message
  }
})

const energies = (f: Fournisseur) => (f.energies ?? []).map((e) => ENERGIES[e]).join(', ')
</script>

<template>
  <section class="entete-page">
    <h1>Fournisseurs</h1>
  </section>
  <p class="discret">
    Un fournisseur qui a un extracteur voit ses factures PDF lues automatiquement à l'import. Les factures d'un
    fournisseur confidentiel ne sont jamais jointes au justificatif d'une régularisation (données fiscales…) : elles y
    sont seulement listées, « consultable sur demande ».
  </p>

  <p v-if="erreur" class="message erreur">{{ erreur }}</p>

  <div class="actions-page">
    <RouterLink :to="{ name: 'nouvel-extracteur' }" class="bouton">+ Nouveau fournisseur (avec son extracteur)</RouterLink>
  </div>

  <table v-if="fournisseurs.length" class="liste">
    <thead>
      <tr>
        <th>Fournisseur</th><th>Énergie</th><th class="nombre">Factures</th><th class="nombre">dont PDF</th>
        <th>Extracteur</th><th>Confidentiel</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="f in fournisseurs" :key="f.id" @click="router.push({ name: 'fournisseur', params: { id: f.id } })">
        <td><strong>{{ f.nom }}</strong></td>
        <td>{{ energies(f) }}</td>
        <td class="nombre">{{ f.nb_factures }}</td>
        <td class="nombre">{{ f.nb_pdf }}</td>
        <td>{{ f.extracteur ? `v${f.extracteur.version}` : '—' }}</td>
        <td>{{ f.confidentiel ? 'oui' : '' }}</td>
      </tr>
    </tbody>
  </table>
  <p v-else-if="!erreur" class="discret">Aucun fournisseur.</p>
</template>

<style scoped>
.liste tr {
  cursor: pointer;
}
</style>

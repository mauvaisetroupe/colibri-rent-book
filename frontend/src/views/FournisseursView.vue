<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'

import { api, ENERGIES, type Fournisseur } from '../api'

// Suppliers (ADR 0013, 0014): every supplier of an invoice or of an extractor. A supplier opens on its page:
// « confidentiel », and the versions of its extractor. The terms masked on the copies of every invoice joined to the
// supporting documents (ADR 0024).

const router = useRouter()
const suppliers = ref<Fournisseur[]>([])
const erreur = ref<string | null>(null)
// One term per line, as typed
const terms = ref('')
const termesEnregistres = ref('')
const messageTermes = ref<{ text: string, type: 'info' | 'erreur' } | null>(null)

onMounted(async () => {
  try {
    const [liste, masques] = await Promise.all([api.suppliers(), api.termesMasques()])
    suppliers.value = liste
    terms.value = termesEnregistres.value = masques.join('\n')
  } catch (e) {
    erreur.value = (e as Error).message
  }
})

async function enregistrerTermes() {
  try {
    const masques = await api.modifierTermesMasques(terms.value.split('\n'))
    terms.value = termesEnregistres.value = masques.join('\n')
    messageTermes.value = {
      text: 'Termes enregistrés : ils s\'appliquent aux versions locataire créées à partir de maintenant (recréer les autres '
        + 'depuis la page de leur fournisseur)',
      type: 'info',
    }
  } catch (e) {
    messageTermes.value = { text: (e as Error).message, type: 'erreur' }
  }
}

const energies = (f: Fournisseur) => (f.energies ?? []).map((e) => ENERGIES[e]).join(', ')
</script>

<template>
  <section class="entete-page">
    <h1>Fournisseurs</h1>
  </section>
  <p class="discret">
    Un fournisseur qui a un extracteur voit ses factures PDF lues automatiquement à l'import ; une banque, ses relevés
    (écran Banque). Les factures d'un
    fournisseur confidentiel ne sont jamais jointes au justificatif d'une régularisation (données fiscales…) : elles y
    sont seulement listées, « consultable sur demande ».
  </p>

  <p v-if="erreur" class="message erreur">{{ erreur }}</p>

  <div class="actions-page">
    <RouterLink :to="{ name: 'nouvel-extracteur' }" class="bouton">+ Nouveau fournisseur (avec son extracteur)</RouterLink>
    <RouterLink :to="{ name: 'nouvel-extracteur-releve' }" class="bouton">+ Nouvelle banque (extracteur de relevés)</RouterLink>
  </div>

  <table v-if="suppliers.length" class="liste">
    <thead>
      <tr>
        <th>Fournisseur</th><th>Énergie</th><th class="nombre">Factures</th><th class="nombre">dont PDF</th>
        <th>Extracteur</th><th>Confidentiel</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="f in suppliers" :key="f.id" @click="router.push({ name: 'supplier', params: { id: f.id } })">
        <td><strong>{{ f.name }}</strong></td>
        <td>{{ f.extractor?.type === 'bank_statement' ? `banque, ${f.statement_count} relevé(s)` : energies(f) }}</td>
        <td class="nombre">{{ f.invoice_count }}</td>
        <td class="nombre">{{ f.pdf_count }}</td>
        <td>{{ f.extractor ? `v${f.extractor.version}` : '—' }}</td>
        <td>{{ f.confidential ? 'oui' : '' }}</td>
      </tr>
    </tbody>
  </table>
  <p v-else-if="!erreur" class="discret">Aucun fournisseur.</p>

  <h2>Termes masqués sur toutes les factures</h2>
  <p class="discret">
    Les factures jointes au justificatif d'une régularisation le sont dans leur version locataire, en images, où ces termes sont masqués
    (en plus de ce que masque l'extracteur de chaque fournisseur) : nom et adresse du gérant, compte bancaire… Un terme
    par ligne ; les espaces et les majuscules ne comptent pas.
  </p>
  <p v-if="messageTermes" class="message" :class="messageTermes.type">{{ messageTermes.text }}</p>
  <form class="termes" @submit.prevent="enregistrerTermes">
    <textarea v-model="terms" rows="8" spellcheck="false" />
    <button type="submit" class="principal" :disabled="terms === termesEnregistres">Enregistrer</button>
  </form>
</template>

<style scoped>
.liste tr {
  cursor: pointer;
}

.termes {
  display: flex;
  gap: 0.5rem;
  align-items: flex-end;
  max-width: 40rem;
}

.termes textarea {
  flex: 1;
  font-family: monospace;
}
</style>

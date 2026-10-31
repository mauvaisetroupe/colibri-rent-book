<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'

import { api, type AssembleeResumee, type TypeAssemblee } from '../api'
import { dateFr } from '../format'

// The register of the general meetings (ADR 0016): closed meetings numbered, drafts on top; a new meeting starts from
// the annual model (agenda and usual resolutions) or empty.

const router = useRouter()
const assemblees = ref<AssembleeResumee[]>([])
const nouvelle = reactive({ type: 'ordinary' as TypeAssemblee, date: '', place: '', modele: 'annuelle' as 'annuelle' | 'vide' })
const formulaire = ref(false)
const message = ref<string | null>(null)

onMounted(async () => {
  try {
    assemblees.value = await api.assemblees()
  } catch (e) {
    message.value = (e as Error).message
  }
})

async function creer() {
  try {
    const a = await api.creerAssemblee({ ...nouvelle, place: nouvelle.place || null })
    await router.push({ name: 'general_meeting', params: { id: a.id } })
  } catch (e) {
    message.value = (e as Error).message
  }
}
</script>

<template>
  <section class="entete-page">
    <h1>Assemblées générales</h1>
  </section>
  <p class="discret">
    Le registre des décisions : une assemblée se prépare en brouillon (présences, résolutions, votes), puis se
    <strong>clôt</strong> : elle reçoit le numéro suivant du registre et son procès-verbal est figé. Le procès-verbal
    signé se joint ensuite.
  </p>

  <p v-if="message" class="message erreur">{{ message }}</p>

  <div class="actions-page">
    <button type="button" @click="formulaire = !formulaire">+ Nouvelle assemblée</button>
  </div>
  <form v-if="formulaire" class="formulaire" @submit.prevent="creer">
    <label>Type
      <select v-model="nouvelle.type">
        <option value="ordinaire">Ordinaire</option>
        <option value="extraordinaire">Extraordinaire</option>
      </select>
    </label>
    <label>Date <input v-model="nouvelle.date" type="date" required></label>
    <label>Lieu <input v-model="nouvelle.place" size="24" placeholder="au siège social"></label>
    <label>Contenu
      <select v-model="nouvelle.modele">
        <option value="annuelle">Assemblée annuelle (comptes de l'année précédente)</option>
        <option value="vide">Vide</option>
      </select>
    </label>
    <button type="submit" class="principal">Créer le brouillon</button>
  </form>

  <table v-if="assemblees.length" class="liste">
    <thead><tr><th>N°</th><th>Date</th><th>Type</th><th class="nombre">Résolutions</th><th>État</th><th>PV signé</th></tr></thead>
    <tbody>
      <tr v-for="a in assemblees" :key="a.id" @click="router.push({ name: 'general_meeting', params: { id: a.id } })">
        <td>{{ a.number ?? '—' }}</td>
        <td>{{ dateFr(a.date) }}</td>
        <td>{{ a.type === 'ordinary' ? 'Ordinaire' : 'Extraordinaire' }}</td>
        <td class="nombre">{{ a.resolution_count }}</td>
        <td><span class="pastille" :class="a.status === 'closed' ? 'validated' : 'draft'">{{ a.status === 'closed' ? 'Close' : 'Brouillon' }}</span></td>
        <td>{{ a.status === 'closed' ? (a.signed_minutes ? 'joint' : 'à joindre') : '' }}</td>
      </tr>
    </tbody>
  </table>
  <p v-else class="discret">Aucune assemblée.</p>
</template>

<style scoped>
.liste tbody tr {
  cursor: pointer;
}
</style>

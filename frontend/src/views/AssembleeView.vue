<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'

import { api, PRESENCES, type Assemblee } from '../api'
import { dateFr } from '../format'

// A general meeting (ADR 0016): the draft is edited (presences, resolutions and votes) then closed, which numbers it in
// the register and freezes its minutes; a closed meeting is read only, its signed minutes are attached.

const props = defineProps<{ id: number }>()
const router = useRouter()
const general_meeting = ref<Assemblee | null>(null)
const message = ref<{ text: string, type: 'info' | 'erreur' } | null>(null)
const modifie = ref(false)

const brouillon = computed(() => general_meeting.value?.status === 'draft')
// Quorum and outcome recomputed as the draft is typed
const partsPresentes = computed(() => (general_meeting.value?.attendances ?? [])
  .filter((p) => p.attendance !== 'absent').reduce((n, p) => n + p.shares, 0))
const resultat = (r: Assemblee['resolutions'][number]) => {
  if (partsPresentes.value > 0 && r.votes_for === partsPresentes.value) {
    return { text: 'adoptée à l\'unanimité', ok: true }
  }
  return r.votes_for * 2 > partsPresentes.value ? { text: 'adoptée', ok: true } : { text: 'rejetée', ok: false }
}

onMounted(charger)
watch(() => props.id, charger)

async function charger() {
  try {
    general_meeting.value = await api.general_meeting(props.id)
    modifie.value = false
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
  }
}

watch(general_meeting, (_, avant) => {
  if (avant) {
    modifie.value = true
  }
}, { deep: true })

function ajouterResolution() {
  general_meeting.value?.resolutions.push({
    position: general_meeting.value.resolutions.length + 1, title: '', text: '', votes_for: partsPresentes.value, votes_against: 0,
    abstentions: 0, adoptee: true, unanimite: true,
  })
}

function retirerResolution(i: number) {
  general_meeting.value?.resolutions.splice(i, 1)
}

async function enregistrer() {
  if (!general_meeting.value) {
    return
  }
  try {
    general_meeting.value = await api.modifierAssemblee(general_meeting.value)
    message.value = { text: 'Brouillon enregistré', type: 'info' }
    setTimeout(() => { modifie.value = false })
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
  }
}

async function clore() {
  if (!general_meeting.value) {
    return
  }
  if (modifie.value) {
    await enregistrer()
  }
  if (!confirm('Clore l\'assemblée ? Elle reçoit le numéro suivant du registre et ne pourra plus être modifiée.')) {
    return
  }
  try {
    general_meeting.value = await api.clore(general_meeting.value.id)
    message.value = { text: `Assemblée close : procès-verbal n° ${general_meeting.value.number} du registre`, type: 'info' }
    setTimeout(() => { modifie.value = false })
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
  }
}

async function supprimer() {
  if (!general_meeting.value || !confirm('Supprimer ce brouillon ?')) {
    return
  }
  await api.supprimerAssemblee(general_meeting.value.id)
  await router.push({ name: 'assemblees' })
}

async function joindre(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !general_meeting.value) {
    return
  }
  try {
    general_meeting.value = await api.joindrePvSigne(general_meeting.value.id, file)
    message.value = { text: 'Procès-verbal signé joint', type: 'info' }
    setTimeout(() => { modifie.value = false })
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
  }
}
</script>

<template>
  <RouterLink :to="{ name: 'assemblees' }">← Assemblées</RouterLink>
  <template v-if="general_meeting">
    <section class="entete-page">
      <h1>
        Assemblée générale {{ general_meeting.type }} du {{ dateFr(general_meeting.date) }}
        <span class="pastille" :class="brouillon ? 'draft' : 'validated'">
          {{ brouillon ? 'Brouillon' : `Close, n° ${general_meeting.number} du registre` }}
        </span>
      </h1>
    </section>

    <p v-if="message" class="message" :class="message.type">{{ message.text }}</p>

    <div class="actions-page">
      <a :href="api.pvUrl(general_meeting.id)" target="_blank" class="bouton">
        {{ brouillon ? 'Projet de procès-verbal (PDF)' : 'Procès-verbal (PDF)' }}
      </a>
      <template v-if="brouillon">
        <button type="button" :disabled="!modifie" @click="enregistrer">Enregistrer le brouillon</button>
        <button type="button" class="principal" @click="clore">Clore l'assemblée</button>
        <button type="button" class="danger" @click="supprimer">Supprimer le brouillon</button>
      </template>
      <template v-else>
        <a v-if="general_meeting.signed_minutes" :href="api.pvSigneUrl(general_meeting.id)" target="_blank" class="bouton">PV signé</a>
        <label class="bouton">{{ general_meeting.signed_minutes ? 'Remplacer le PV signé…' : 'Joindre le PV signé…' }}
          <input type="file" accept="application/pdf" hidden @change="joindre">
        </label>
      </template>
    </div>

    <fieldset :disabled="!brouillon" class="sans-bord">
      <div class="formulaire">
        <label>Type
          <select v-model="general_meeting.type">
            <option value="ordinaire">Ordinaire</option>
            <option value="extraordinaire">Extraordinaire</option>
          </select>
        </label>
        <label>Date <input v-model="general_meeting.date" type="date" required></label>
        <label>Heure <input v-model="general_meeting.time" size="6" placeholder="10 h"></label>
        <label>Lieu <input v-model="general_meeting.place" size="24"></label>
        <label>Président de séance <input v-model="general_meeting.chair" size="20"></label>
      </div>

      <h2>Présences</h2>
      <table class="liste">
        <thead><tr><th>Associé</th><th class="nombre">Parts</th><th>Présence</th><th>Représenté par</th></tr></thead>
        <tbody>
          <tr v-for="p in general_meeting.attendances" :key="p.partner_id" class="sans-clic">
            <td>{{ p.name }}{{ p.manager ? ' (gérant)' : '' }}</td>
            <td class="nombre">{{ p.shares }}</td>
            <td>
              <select v-model="p.attendance">
                <option v-for="(name, code) in PRESENCES" :key="code" :value="code">{{ name }}</option>
              </select>
            </td>
            <td><input v-if="p.attendance === 'represented'" v-model="p.represented_by" size="20"></td>
          </tr>
        </tbody>
      </table>
      <p class="discret">Parts présentes ou représentées : {{ partsPresentes }} sur {{ general_meeting.total_shares }}.</p>

      <h2>Ordre du jour</h2>
      <textarea v-model="general_meeting.agenda" rows="5" class="large" />

      <h2>Résolutions</h2>
      <div v-for="(r, i) in general_meeting.resolutions" :key="i" class="resolution">
        <div class="formulaire">
          <strong>N° {{ i + 1 }}</strong>
          <label class="titre">Titre <input v-model="r.title" required></label>
          <label>Pour <input v-model.number="r.votes_for" type="number" min="0" class="nombre" style="width: 5rem"></label>
          <label>Contre <input v-model.number="r.votes_against" type="number" min="0" class="nombre" style="width: 5rem"></label>
          <label>Abstention <input v-model.number="r.abstentions" type="number" min="0" class="nombre" style="width: 5rem"></label>
          <span :class="resultat(r).ok ? 'ok' : 'ko'">{{ resultat(r).text }}</span>
          <button v-if="brouillon" type="button" @click="retirerResolution(i)">Retirer</button>
        </div>
        <textarea v-model="r.text" rows="4" class="large" />
      </div>
      <button v-if="brouillon" type="button" @click="ajouterResolution">+ Ajouter une résolution</button>

      <h2>Observations</h2>
      <textarea v-model="general_meeting.remarks" rows="3" class="large" />
    </fieldset>
  </template>
</template>

<style scoped>
.sans-bord {
  border: none;
  padding: 0;
  margin: 0;
}

.large {
  width: 100%;
  box-sizing: border-box;
  font: inherit;
}

.resolution {
  margin-bottom: 1rem;
}

.titre {
  flex: 1;
}

.titre input {
  width: 100%;
}
</style>

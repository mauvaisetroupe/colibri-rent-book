<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'

import { api, PRESENCES, type Assemblee } from '../api'
import { dateFr } from '../format'

// A general meeting (ADR 0016): the draft is edited (presences, resolutions and votes) then closed, which numbers it in
// the register and freezes its minutes; a closed meeting is read only, its signed minutes are attached.

const props = defineProps<{ id: number }>()
const router = useRouter()
const assemblee = ref<Assemblee | null>(null)
const message = ref<{ texte: string, type: 'info' | 'erreur' } | null>(null)
const modifie = ref(false)

const brouillon = computed(() => assemblee.value?.statut === 'brouillon')
// Quorum and outcome recomputed as the draft is typed
const partsPresentes = computed(() => (assemblee.value?.presences ?? [])
  .filter((p) => p.presence !== 'absent').reduce((n, p) => n + p.parts, 0))
const resultat = (r: Assemblee['resolutions'][number]) => {
  if (partsPresentes.value > 0 && r.pour === partsPresentes.value) {
    return { texte: 'adoptée à l\'unanimité', ok: true }
  }
  return r.pour * 2 > partsPresentes.value ? { texte: 'adoptée', ok: true } : { texte: 'rejetée', ok: false }
}

onMounted(charger)
watch(() => props.id, charger)

async function charger() {
  try {
    assemblee.value = await api.assemblee(props.id)
    modifie.value = false
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}

watch(assemblee, (_, avant) => {
  if (avant) {
    modifie.value = true
  }
}, { deep: true })

function ajouterResolution() {
  assemblee.value?.resolutions.push({
    ordre: assemblee.value.resolutions.length + 1, titre: '', texte: '', pour: partsPresentes.value, contre: 0,
    abstention: 0, adoptee: true, unanimite: true,
  })
}

function retirerResolution(i: number) {
  assemblee.value?.resolutions.splice(i, 1)
}

async function enregistrer() {
  if (!assemblee.value) {
    return
  }
  try {
    assemblee.value = await api.modifierAssemblee(assemblee.value)
    message.value = { texte: 'Brouillon enregistré', type: 'info' }
    setTimeout(() => { modifie.value = false })
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}

async function clore() {
  if (!assemblee.value) {
    return
  }
  if (modifie.value) {
    await enregistrer()
  }
  if (!confirm('Clore l\'assemblée ? Elle reçoit le numéro suivant du registre et ne pourra plus être modifiée.')) {
    return
  }
  try {
    assemblee.value = await api.clore(assemblee.value.id)
    message.value = { texte: `Assemblée close : procès-verbal n° ${assemblee.value.numero} du registre`, type: 'info' }
    setTimeout(() => { modifie.value = false })
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}

async function supprimer() {
  if (!assemblee.value || !confirm('Supprimer ce brouillon ?')) {
    return
  }
  await api.supprimerAssemblee(assemblee.value.id)
  await router.push({ name: 'assemblees' })
}

async function joindre(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !assemblee.value) {
    return
  }
  try {
    assemblee.value = await api.joindrePvSigne(assemblee.value.id, file)
    message.value = { texte: 'Procès-verbal signé joint', type: 'info' }
    setTimeout(() => { modifie.value = false })
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}
</script>

<template>
  <RouterLink :to="{ name: 'assemblees' }">← Assemblées</RouterLink>
  <template v-if="assemblee">
    <section class="entete-page">
      <h1>
        Assemblée générale {{ assemblee.type }} du {{ dateFr(assemblee.date) }}
        <span class="pastille" :class="brouillon ? 'a_verifier' : 'validee'">
          {{ brouillon ? 'Brouillon' : `Close, n° ${assemblee.numero} du registre` }}
        </span>
      </h1>
    </section>

    <p v-if="message" class="message" :class="message.type">{{ message.texte }}</p>

    <div class="actions-page">
      <a :href="api.pvUrl(assemblee.id)" target="_blank" class="bouton">
        {{ brouillon ? 'Projet de procès-verbal (PDF)' : 'Procès-verbal (PDF)' }}
      </a>
      <template v-if="brouillon">
        <button type="button" :disabled="!modifie" @click="enregistrer">Enregistrer le brouillon</button>
        <button type="button" class="principal" @click="clore">Clore l'assemblée</button>
        <button type="button" class="danger" @click="supprimer">Supprimer le brouillon</button>
      </template>
      <template v-else>
        <a v-if="assemblee.pv_signe" :href="api.pvSigneUrl(assemblee.id)" target="_blank" class="bouton">PV signé</a>
        <label class="bouton">{{ assemblee.pv_signe ? 'Remplacer le PV signé…' : 'Joindre le PV signé…' }}
          <input type="file" accept="application/pdf" hidden @change="joindre">
        </label>
      </template>
    </div>

    <fieldset :disabled="!brouillon" class="sans-bord">
      <div class="formulaire">
        <label>Type
          <select v-model="assemblee.type">
            <option value="ordinaire">Ordinaire</option>
            <option value="extraordinaire">Extraordinaire</option>
          </select>
        </label>
        <label>Date <input v-model="assemblee.date" type="date" required></label>
        <label>Heure <input v-model="assemblee.heure" size="6" placeholder="10 h"></label>
        <label>Lieu <input v-model="assemblee.lieu" size="24"></label>
        <label>Président de séance <input v-model="assemblee.president" size="20"></label>
      </div>

      <h2>Présences</h2>
      <table class="liste">
        <thead><tr><th>Associé</th><th class="nombre">Parts</th><th>Présence</th><th>Représenté par</th></tr></thead>
        <tbody>
          <tr v-for="p in assemblee.presences" :key="p.associe_id" class="sans-clic">
            <td>{{ p.nom }}{{ p.gerant ? ' (gérant)' : '' }}</td>
            <td class="nombre">{{ p.parts }}</td>
            <td>
              <select v-model="p.presence">
                <option v-for="(nom, code) in PRESENCES" :key="code" :value="code">{{ nom }}</option>
              </select>
            </td>
            <td><input v-if="p.presence === 'represente'" v-model="p.represente_par" size="20"></td>
          </tr>
        </tbody>
      </table>
      <p class="discret">Parts présentes ou représentées : {{ partsPresentes }} sur {{ assemblee.parts_total }}.</p>

      <h2>Ordre du jour</h2>
      <textarea v-model="assemblee.ordre_du_jour" rows="5" class="large" />

      <h2>Résolutions</h2>
      <div v-for="(r, i) in assemblee.resolutions" :key="i" class="resolution">
        <div class="formulaire">
          <strong>N° {{ i + 1 }}</strong>
          <label class="titre">Titre <input v-model="r.titre" required></label>
          <label>Pour <input v-model.number="r.pour" type="number" min="0" class="nombre" style="width: 5rem"></label>
          <label>Contre <input v-model.number="r.contre" type="number" min="0" class="nombre" style="width: 5rem"></label>
          <label>Abstention <input v-model.number="r.abstention" type="number" min="0" class="nombre" style="width: 5rem"></label>
          <span :class="resultat(r).ok ? 'ok' : 'ko'">{{ resultat(r).texte }}</span>
          <button v-if="brouillon" type="button" @click="retirerResolution(i)">Retirer</button>
        </div>
        <textarea v-model="r.texte" rows="4" class="large" />
      </div>
      <button v-if="brouillon" type="button" @click="ajouterResolution">+ Ajouter une résolution</button>

      <h2>Observations</h2>
      <textarea v-model="assemblee.observations" rows="3" class="large" />
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

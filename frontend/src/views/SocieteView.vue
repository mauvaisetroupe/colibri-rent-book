<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { api, type Associe } from '../api'
import { nombreApi, nombreFr } from '../format'

// The company and its partners (ADR 0016): printed at the head of the minutes of the general meetings; the parts of
// each partner give his share of the votes and of the result.

const societe = reactive({ denomination: '', forme: 'SCI', capital: '', siege: '', rcs: '' })
const associes = ref<Associe[]>([])
const saisie = ref<(Omit<Associe, 'id'> & { id: number | null }) | null>(null)
const message = ref<{ texte: string, type: 'info' | 'erreur' } | null>(null)

const totalParts = computed(() => associes.value.reduce((n, a) => n + a.parts, 0))
const pourcent = (parts: number) => (totalParts.value ? `${Math.round((parts / totalParts.value) * 10000) / 100} %` : '')

onMounted(charger)

async function charger() {
  try {
    const r = await api.societe()
    Object.assign(societe, {
      denomination: r.societe?.denomination ?? '', forme: r.societe?.forme ?? 'SCI',
      capital: nombreFr(r.societe?.capital ?? null), siege: r.societe?.siege ?? '', rcs: r.societe?.rcs ?? '',
    })
    associes.value = r.associes
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}

async function enregistrerSociete() {
  try {
    await api.modifierSociete({
      denomination: societe.denomination, forme: societe.forme || 'SCI',
      capital: nombreApi(societe.capital), siege: societe.siege || null, rcs: societe.rcs || null,
    })
    message.value = { texte: 'Société enregistrée', type: 'info' }
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}

function nouvelAssocie() {
  saisie.value = { id: null, nom: '', parts: 1, gerant: false, adresse: null, note: null }
}

async function enregistrerAssocie() {
  if (!saisie.value) {
    return
  }
  const { id, ...a } = saisie.value
  try {
    if (id === null) {
      await api.creerAssocie(a)
    } else {
      await api.modifierAssocie({ id, ...a })
    }
    saisie.value = null
    await charger()
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}

async function supprimerAssocie(a: Associe) {
  if (!confirm(`Retirer ${a.nom} des associés ?`)) {
    return
  }
  try {
    await api.supprimerAssocie(a.id)
    await charger()
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}
</script>

<template>
  <section class="entete-page">
    <h1>Société et associés</h1>
  </section>
  <p class="discret">
    Repris en tête des procès-verbaux des assemblées générales. Les parts de chaque associé donnent sa voix aux votes et
    sa part du résultat. Un procès-verbal clos garde la société et les associés de son jour.
  </p>

  <p v-if="message" class="message" :class="message.type">{{ message.texte }}</p>

  <h2>La société</h2>
  <form class="formulaire" @submit.prevent="enregistrerSociete">
    <label>Dénomination <input v-model="societe.denomination" required size="24"></label>
    <label>Forme <input v-model="societe.forme" size="6"></label>
    <label>Capital (€) <input v-model="societe.capital" class="nombre" size="9"></label>
    <label>Siège social <input v-model="societe.siege" size="34"></label>
    <label>RCS <input v-model="societe.rcs" size="24"></label>
    <button type="submit" class="principal">Enregistrer</button>
  </form>

  <h2>Les associés</h2>
  <div class="actions-page">
    <button type="button" @click="nouvelAssocie">+ Ajouter un associé</button>
  </div>
  <form v-if="saisie" class="formulaire" @submit.prevent="enregistrerAssocie">
    <label>Nom <input v-model="saisie.nom" required size="24"></label>
    <label>Parts <input v-model.number="saisie.parts" type="number" min="1" required class="nombre" style="width: 6rem"></label>
    <label class="case"><input v-model="saisie.gerant" type="checkbox"> Gérant</label>
    <label>Adresse <input v-model="saisie.adresse" size="30"></label>
    <button type="submit" class="principal">Enregistrer</button>
    <button type="button" @click="saisie = null">Annuler</button>
  </form>
  <table v-if="associes.length" class="liste">
    <thead><tr><th>Associé</th><th class="nombre">Parts</th><th class="nombre">Part</th><th>Gérant</th><th>Adresse</th><th /></tr></thead>
    <tbody>
      <tr v-for="a in associes" :key="a.id" @click="saisie = { ...a }">
        <td>{{ a.nom }}</td>
        <td class="nombre">{{ a.parts }}</td>
        <td class="nombre">{{ pourcent(a.parts) }}</td>
        <td>{{ a.gerant ? 'gérant' : '' }}</td>
        <td class="discret">{{ a.adresse }}</td>
        <td @click.stop><button type="button" class="danger" @click="supprimerAssocie(a)">Retirer</button></td>
      </tr>
    </tbody>
    <tfoot><tr><td><strong>Total</strong></td><td class="nombre"><strong>{{ totalParts }}</strong></td><td colspan="4" /></tr></tfoot>
  </table>
  <p v-else class="discret">Aucun associé.</p>
</template>

<style scoped>
.liste tbody tr {
  cursor: pointer;
}

.case {
  flex-direction: row;
  align-items: center;
  gap: 0.3rem;
}
</style>

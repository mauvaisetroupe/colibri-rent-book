<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'

import { api, type ImmeubleDetail, type Lot } from '../api'
import { nombreApi, nombreFr } from '../format'
import { rechargerImmeubles, useImmeuble } from '../immeuble'

// Building and lots with their tantièmes (SPEC § 7). Changing tantièmes changes every statement, past ones included.

type LotSaisi = { id: number | null, code: string, designation: string, surface_m2: string, tantiemes: string }

const { immeubleId, pret } = useImmeuble()
const nouveau = ref<null | { code: string, nom: string, adresse: string }>(null)
const immeuble = ref<ImmeubleDetail | null>(null)
const identite = reactive({ nom: '', adresse: '' })
const lots = ref<LotSaisi[]>([])
const message = ref<{ texte: string, type: 'info' | 'erreur' } | null>(null)

const vers = (l: Lot): LotSaisi => ({
  id: l.id,
  code: l.code,
  designation: l.designation ?? '',
  surface_m2: nombreFr(l.surface_m2),
  tantiemes: String(l.tantiemes),
})

async function charger() {
  if (immeubleId.value === null) {
    return
  }
  immeuble.value = await api.immeuble(immeubleId.value)
  identite.nom = immeuble.value.nom
  identite.adresse = immeuble.value.adresse ?? ''
  lots.value = immeuble.value.lots.map(vers)
}

onMounted(async () => {
  await pret
  await charger().catch((e) => { message.value = { texte: e.message, type: 'erreur' } })
})
watch(immeubleId, charger)

const total = computed(() => lots.value.reduce((sum, l) => sum + (Number.parseInt(l.tantiemes, 10) || 0), 0))

async function action(f: () => Promise<unknown>, succes: string) {
  try {
    await f()
    message.value = { texte: succes, type: 'info' }
    await charger()
    await rechargerImmeubles()
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}

const enregistrerIdentite = () => action(
  () => api.modifierImmeuble(immeubleId.value!, { nom: identite.nom, adresse: identite.adresse || null }),
  'Immeuble enregistré',
)

function enregistrerLot(lot: LotSaisi) {
  const avant = immeuble.value?.lots.find((l) => l.id === lot.id)
  if (avant && String(avant.tantiemes) !== lot.tantiemes.trim()
    && !confirm('Changer les tantièmes modifie tous les décomptes, y compris ceux des exercices passés. Continuer ?')) {
    return
  }
  const donnees = {
    code: lot.code,
    designation: lot.designation || null,
    surface_m2: nombreApi(lot.surface_m2),
    tantiemes: Number(lot.tantiemes),
  }
  return action(
    () => (lot.id === null
      ? api.creerLot(immeubleId.value!, donnees)
      : api.modifierLot({ ...donnees, id: lot.id, immeuble_id: immeubleId.value! })),
    `${lot.code} enregistré`,
  )
}

function supprimerLot(lot: LotSaisi) {
  if (lot.id === null) {
    lots.value = lots.value.filter((l) => l !== lot)
    return
  }
  if (confirm(`Supprimer ${lot.code} ?`)) {
    return action(() => api.supprimerLot(lot.id!), `${lot.code} supprimé`)
  }
}

async function creerImmeuble() {
  const n = nouveau.value!
  try {
    const cree = await api.creerImmeuble({ code: n.code, nom: n.nom, adresse: n.adresse || null })
    await rechargerImmeubles()
    immeubleId.value = cree.id
    nouveau.value = null
    message.value = { texte: `Immeuble ${cree.nom} créé : ajouter ses lots, puis ses locataires et séjours`, type: 'info' }
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}

const ajouterLot = () => lots.value.push({ id: null, code: '', designation: '', surface_m2: '', tantiemes: '' })
</script>

<template>
  <h1>Immeuble</h1>
  <p v-if="message" class="message" :class="message.type">{{ message.texte }}</p>

  <template v-if="immeuble">
    <section class="champs">
      <label>Code <input :value="immeuble.code" disabled></label>
      <label>Nom <input v-model="identite.nom" size="34"></label>
      <label>Adresse <input v-model="identite.adresse" size="40"></label>
      <button type="button" class="aligne" @click="enregistrerIdentite">Enregistrer</button>
    </section>

    <h2>Lots</h2>
    <table class="liste">
      <thead>
        <tr><th>Code</th><th>Désignation</th><th class="nombre">Surface (m²)</th><th class="nombre">Tantièmes</th><th /></tr>
      </thead>
      <tbody>
        <tr v-for="(lot, i) in lots" :key="lot.id ?? `nouveau-${i}`" class="sans-clic">
          <td><input v-model="lot.code" size="8"></td>
          <td><input v-model="lot.designation" size="30"></td>
          <td class="nombre"><input v-model="lot.surface_m2" class="nombre" size="7"></td>
          <td class="nombre"><input v-model="lot.tantiemes" class="nombre" size="7"></td>
          <td>
            <button type="button" @click="enregistrerLot(lot)">Enregistrer</button>
            <button type="button" class="danger" @click="supprimerLot(lot)">Supprimer</button>
          </td>
        </tr>
      </tbody>
      <tfoot>
        <tr><th colspan="3">Total des tantièmes</th><th class="nombre">{{ total }}</th><th /></tr>
      </tfoot>
    </table>
    <p><button type="button" @click="ajouterLot">+ Lot</button></p>
  </template>

  <h2>Autre immeuble</h2>
  <form v-if="nouveau" class="formulaire" @submit.prevent="creerImmeuble">
    <label>Code <input v-model="nouveau.code" required size="10" placeholder="MAISON"></label>
    <label>Nom <input v-model="nouveau.nom" required size="30"></label>
    <label>Adresse <input v-model="nouveau.adresse" size="40"></label>
    <button type="submit" class="principal">Créer</button>
    <button type="button" @click="nouveau = null">Annuler</button>
  </form>
  <p v-else>
    <button type="button" @click="nouveau = { code: '', nom: '', adresse: '' }">+ Nouvel immeuble</button>
    <span class="discret"> L'immeuble affiché se choisit en haut à droite dès qu'il y en a plusieurs.</span>
  </p>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'

import { api, type ImmeubleDetail, type Lot } from '../api'
import { nombreApi, nombreFr } from '../format'
import { rechargerImmeubles, useImmeuble } from '../immeuble'

// Building and lots with their tantièmes (SPEC § 7). Changing tantièmes changes every statement, past ones included.

type LotSaisi = { id: number | null, code: string, label: string, area_m2: string, charge_shares: string }

const { immeubleId, pret } = useImmeuble()
const nouveau = ref<null | { code: string, name: string, address: string }>(null)
const building = ref<ImmeubleDetail | null>(null)
const identite = reactive({ name: '', address: '', managed_from: '' })
const units = ref<LotSaisi[]>([])
const message = ref<{ text: string, type: 'info' | 'erreur' } | null>(null)

const vers = (l: Lot): LotSaisi => ({
  id: l.id,
  code: l.code,
  label: l.label ?? '',
  area_m2: nombreFr(l.area_m2),
  charge_shares: String(l.charge_shares),
})

async function charger() {
  if (immeubleId.value === null) {
    return
  }
  building.value = await api.building(immeubleId.value)
  identite.name = building.value.name
  identite.address = building.value.address ?? ''
  identite.managed_from = building.value.managed_from ?? ''
  units.value = building.value.units.map(vers)
}

onMounted(async () => {
  await pret
  await charger().catch((e) => { message.value = { text: e.message, type: 'erreur' } })
})
watch(immeubleId, charger)

const total = computed(() => units.value.reduce((sum, l) => sum + (Number.parseInt(l.charge_shares, 10) || 0), 0))

async function action(f: () => Promise<unknown>, succes: string) {
  try {
    await f()
    message.value = { text: succes, type: 'info' }
    await charger()
    await rechargerImmeubles()
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
  }
}

const enregistrerIdentite = () => action(
  () => api.modifierImmeuble(immeubleId.value!, {
    name: identite.name, address: identite.address || null, managed_from: identite.managed_from || null,
  }),
  'Immeuble enregistré',
)

function enregistrerLot(unit: LotSaisi) {
  const avant = building.value?.units.find((l) => l.id === unit.id)
  if (avant && String(avant.charge_shares) !== unit.charge_shares.trim()
    && !confirm('Changer les tantièmes modifie tous les décomptes, y compris ceux des exercices passés. Continuer ?')) {
    return
  }
  const donnees = {
    code: unit.code,
    label: unit.label || null,
    area_m2: nombreApi(unit.area_m2),
    charge_shares: Number(unit.charge_shares),
  }
  return action(
    () => (unit.id === null
      ? api.creerLot(immeubleId.value!, donnees)
      : api.modifierLot({ ...donnees, id: unit.id, building_id: immeubleId.value! })),
    `${unit.code} enregistré`,
  )
}

function supprimerLot(unit: LotSaisi) {
  if (unit.id === null) {
    units.value = units.value.filter((l) => l !== unit)
    return
  }
  if (confirm(`Supprimer ${unit.code} ?`)) {
    return action(() => api.supprimerLot(unit.id!), `${unit.code} supprimé`)
  }
}

async function creerImmeuble() {
  const n = nouveau.value!
  try {
    const created = await api.creerImmeuble({ code: n.code, name: n.name, address: n.address || null })
    await rechargerImmeubles()
    immeubleId.value = created.id
    nouveau.value = null
    message.value = { text: `Immeuble ${created.name} créé : ajouter ses lots, puis ses locataires et séjours`, type: 'info' }
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
  }
}

const ajouterLot = () => units.value.push({ id: null, code: '', label: '', area_m2: '', charge_shares: '' })
</script>

<template>
  <h1>Immeuble</h1>
  <p v-if="message" class="message" :class="message.type">{{ message.text }}</p>

  <template v-if="building">
    <section class="champs">
      <label>Code <input :value="building.code" disabled></label>
      <label>Nom <input v-model="identite.name" size="34"></label>
      <label>Adresse <input v-model="identite.address" size="40"></label>
      <label title="Avant cette date, les comptes n'étaient pas tenus ici (une agence de gestion, par exemple) : pas de factures manquantes, de régularisations manquantes ni de charges comptées au départ d'un locataire">
        Début de la gestion dans Colibri <input v-model="identite.managed_from" type="date">
      </label>
      <button type="button" class="aligne" @click="enregistrerIdentite">Enregistrer</button>
    </section>
    <p class="discret">
      Début de la gestion : avant cette date (une agence gérait, ou rien n'était suivi), Colibri ne signale ni factures ni
      régularisations manquantes, et la synthèse fiscale ne compte pas ces années dans les charges d'un locataire parti.
    </p>

    <h2>Lots</h2>
    <table class="liste">
      <thead>
        <tr><th>Code</th><th>Désignation</th><th class="nombre">Surface (m²)</th><th class="nombre">Tantièmes</th><th /></tr>
      </thead>
      <tbody>
        <tr v-for="(unit, i) in units" :key="unit.id ?? `nouveau-${i}`" class="sans-clic">
          <td><input v-model="unit.code" size="8"></td>
          <td><input v-model="unit.label" size="30"></td>
          <td class="nombre"><input v-model="unit.area_m2" class="nombre" size="7"></td>
          <td class="nombre"><input v-model="unit.charge_shares" class="nombre" size="7"></td>
          <td>
            <button type="button" @click="enregistrerLot(unit)">Enregistrer</button>
            <button type="button" class="danger" @click="supprimerLot(unit)">Supprimer</button>
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
    <label>Nom <input v-model="nouveau.name" required size="30"></label>
    <label>Adresse <input v-model="nouveau.address" size="40"></label>
    <button type="submit" class="principal">Créer</button>
    <button type="button" @click="nouveau = null">Annuler</button>
  </form>
  <p v-else>
    <button type="button" @click="nouveau = { code: '', name: '', address: '' }">+ Nouvel immeuble</button>
    <span class="discret"> L'immeuble affiché se choisit en haut à droite dès qu'il y en a plusieurs.</span>
  </p>
</template>

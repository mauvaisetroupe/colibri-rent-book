<script lang="ts">
// A tenant and one of its stays, in a modal form. New stay: a new tenant, or one already known (a tenant coming
// back). Saving goes through the existing routes, tenant first (see SejoursView). A stay already saved shows its
// deposit (BlocDepot, ADR 0021), whose operations are saved at once, apart from this form.

// Rent and provision called from a month on (ADR 0009); id null: new row
export type LigneEcheance = { id: number | null, month: string, rent: string, charge_advance: string, note: string }

export type FicheSaisie = {
  tenancy_id: number | null
  // null: new tenant
  tenant_id: number | null
  name: string
  email: string
  phone: string
  note_locataire: string
  unit_id: number | null
  move_in: string
  move_out: string
  security_deposit: string
  note_sejour: string
  // History of the amounts called, oldest first
  rent_schedules: LigneEcheance[]
}
</script>

<script setup lang="ts">
import Big from 'big.js'
import { computed, onMounted, ref } from 'vue'

import type { Echeance, Locataire, Lot, Sejour } from '../api'
import { euros, nombreApi } from '../format'
import BlocDepot, { type DepotPrerempli } from './BlocDepot.vue'
import ChoixMois from './ChoixMois.vue'

const props = defineProps<{
  units: Lot[], tenants: Locataire[], occupe: boolean, erreur: string | null,
  // The stay saved (null for a new one), for its deposit; a transfer from the bank to enter as a deposit
  tenancy: Sejour | null, building: number, rent_schedules: Echeance[], prerempli: DepotPrerempli | null
}>()
const f = defineModel<FicheSaisie>({ required: true })
const emit = defineEmits<{ enregistrer: [], fermer: [], supprimer: [], depotModifie: [] }>()

const fenetre = ref<HTMLDialogElement | null>(null)
onMounted(() => fenetre.value?.showModal())

const nouveau = computed(() => f.value.tenancy_id === null)

// A new change of the amounts called: from this month, the last amounts as a start
function ajouterEcheance() {
  const latest = f.value.rent_schedules.at(-1)
  f.value.rent_schedules.push({
    id: null, month: latest ? new Date().toISOString().slice(0, 7) : f.value.move_in.slice(0, 7),
    rent: latest?.rent ?? '', charge_advance: latest?.charge_advance ?? '', note: '',
  })
}

const totalEcheance = (e: LigneEcheance) => {
  const rent = nombreApi(e.rent)
  const charge_advance = nombreApi(e.charge_advance)
  try {
    return rent && charge_advance ? euros(new Big(rent).plus(charge_advance).toString()) : ''
  } catch {
    return ''
  }
}

// The first row follows the entry date while it is typed
function changerEntree() {
  const premiere = f.value.rent_schedules[0]
  if (nouveau.value && premiere && premiere.id === null) {
    premiere.month = f.value.move_in.slice(0, 7)
  }
}

// A tenant already known chosen for a new stay: its details fill the form
function choisirLocataire() {
  const l = props.tenants.find((x) => x.id === f.value.tenant_id)
  Object.assign(f.value, {
    name: l?.name ?? '', email: l?.email ?? '', phone: l?.phone ?? '', note_locataire: l?.note ?? '',
  })
}
</script>

<template>
  <dialog ref="fenetre" class="fenetre large" @cancel.prevent="emit('fermer')">
    <form @submit.prevent="emit('enregistrer')">
      <h2>{{ nouveau ? 'Nouveau locataire' : f.name }}</h2>

      <fieldset>
        <legend>Locataire</legend>
        <label v-if="nouveau && tenants.length">Fiche
          <select v-model="f.tenant_id" @change="choisirLocataire">
            <option :value="null">Nouveau locataire</option>
            <option v-for="l in tenants" :key="l.id" :value="l.id">{{ l.name }} (déjà venu)</option>
          </select>
        </label>
        <div class="rangee">
          <label class="large">Nom <input v-model="f.name" required></label>
        </div>
        <div class="rangee">
          <label class="large">E-mail <input v-model="f.email" type="email"></label>
          <label>Téléphone <input v-model="f.phone" size="16"></label>
        </div>
        <div class="rangee">
          <label class="large">Note (garant, coordonnées…) <input v-model="f.note_locataire"></label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Séjour</legend>
        <div class="rangee">
          <label>Lot
            <select v-model="f.unit_id" required>
              <option :value="null" disabled>Choisir…</option>
              <option v-for="unit in units" :key="unit.id" :value="unit.id">{{ unit.code }}</option>
            </select>
          </label>
          <label>Entrée <input v-model="f.move_in" type="date" required @change="changerEntree"></label>
          <label>Sortie (vide si en cours) <input v-model="f.move_out" type="date"></label>
        </div>
        <div class="rangee">
          <label class="large">Note du séjour <input v-model="f.note_sejour"></label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Loyer et provision appelés chaque mois</legend>
        <p class="discret">
          Une ligne par changement (révision du loyer, nouvelle provision) : elle vaut à partir de son mois, jusqu'à la
          ligne suivante. Un mois d'entrée ou de sortie est appelé au prorata des jours.
        </p>
        <table v-if="f.rent_schedules.length" class="liste echeances">
          <thead>
            <tr><th>À partir de</th><th class="nombre">Loyer</th><th class="nombre">Provision</th><th class="nombre">Total</th><th>Note</th><th /></tr>
          </thead>
          <tbody>
            <tr v-for="(e, i) in f.rent_schedules" :key="e.id ?? `n${i}`" class="sans-clic">
              <td><ChoixMois v-model="e.month" /></td>
              <td class="nombre"><input v-model="e.rent" class="nombre" size="7" aria-label="Loyer appelé" required></td>
              <td class="nombre"><input v-model="e.charge_advance" class="nombre" size="7" aria-label="Provision appelée" required></td>
              <td class="nombre">{{ totalEcheance(e) }}</td>
              <td class="note"><input v-model="e.note" aria-label="Note" :title="e.note"></td>
              <td><button type="button" class="danger" title="Retirer cette ligne" @click="f.rent_schedules.splice(i, 1)">✕</button></td>
            </tr>
          </tbody>
        </table>
        <p v-else class="discret">Aucun montant renseigné : les contrôles ne pourront pas repérer un mois payé en partie.</p>
        <p><button type="button" @click="ajouterEcheance">+ {{ f.rent_schedules.length ? 'Un changement' : 'Montant appelé' }}</button></p>
      </fieldset>

      <fieldset>
        <legend>Dépôt de garantie</legend>
        <div class="rangee">
          <label>Prévu au bail <input v-model="f.security_deposit" class="nombre" size="9"></label>
        </div>
        <template v-if="tenancy">
          <p class="discret">
            Dépôts reçus, restitutions et retenue : enregistrés aussitôt, indépendamment du bouton « Enregistrer » de la
            fiche.
          </p>
          <BlocDepot :tenancy="tenancy" :building="building" :rent_schedules="rent_schedules" :prerempli="prerempli" @modifie="emit('depotModifie')" />
        </template>
        <p v-else class="discret">Le dépôt reçu se saisit une fois le séjour enregistré.</p>
      </fieldset>

      <p v-if="erreur" class="message erreur">{{ erreur }}</p>

      <div class="actions">
        <button type="submit" class="principal" :disabled="occupe">Enregistrer</button>
        <button type="button" @click="emit('fermer')">Annuler</button>
        <button v-if="!nouveau" type="button" class="danger" :disabled="occupe" @click="emit('supprimer')">Supprimer</button>
      </div>
    </form>
  </dialog>
</template>

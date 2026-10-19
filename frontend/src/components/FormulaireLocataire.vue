<script lang="ts">
// A tenant and one of its stays, in a modal form. New stay: a new tenant, or one already known (a tenant coming
// back). Saving goes through the existing routes, tenant first (see SejoursView).

// Rent and provision called from a month on (ADR 0009); id null: new row
export type LigneEcheance = { id: number | null, mois: string, loyer: string, provision: string, note: string }

export type FicheSaisie = {
  sejour_id: number | null
  // null: new tenant
  locataire_id: number | null
  nom: string
  email: string
  telephone: string
  note_locataire: string
  lot_id: number | null
  entree: string
  sortie: string
  depot_garantie: string
  note_sejour: string
  // History of the amounts called, oldest first
  echeances: LigneEcheance[]
}
</script>

<script setup lang="ts">
import Big from 'big.js'
import { computed, onMounted, ref } from 'vue'

import type { Locataire, Lot } from '../api'
import { euros, nombreApi } from '../format'
import ChoixMois from './ChoixMois.vue'

const props = defineProps<{ lots: Lot[], locataires: Locataire[], occupe: boolean, erreur: string | null }>()
const f = defineModel<FicheSaisie>({ required: true })
const emit = defineEmits<{ enregistrer: [], fermer: [], supprimer: [] }>()

const fenetre = ref<HTMLDialogElement | null>(null)
onMounted(() => fenetre.value?.showModal())

const nouveau = computed(() => f.value.sejour_id === null)

// A new change of the amounts called: from this month, the last amounts as a start
function ajouterEcheance() {
  const derniere = f.value.echeances.at(-1)
  f.value.echeances.push({
    id: null, mois: derniere ? new Date().toISOString().slice(0, 7) : f.value.entree.slice(0, 7),
    loyer: derniere?.loyer ?? '', provision: derniere?.provision ?? '', note: '',
  })
}

const totalEcheance = (e: LigneEcheance) => {
  const loyer = nombreApi(e.loyer)
  const provision = nombreApi(e.provision)
  try {
    return loyer && provision ? euros(new Big(loyer).plus(provision).toString()) : ''
  } catch {
    return ''
  }
}

// The first row follows the entry date while it is typed
function changerEntree() {
  const premiere = f.value.echeances[0]
  if (nouveau.value && premiere && premiere.id === null) {
    premiere.mois = f.value.entree.slice(0, 7)
  }
}

// A tenant already known chosen for a new stay: its details fill the form
function choisirLocataire() {
  const l = props.locataires.find((x) => x.id === f.value.locataire_id)
  Object.assign(f.value, {
    nom: l?.nom ?? '', email: l?.email ?? '', telephone: l?.telephone ?? '', note_locataire: l?.note ?? '',
  })
}
</script>

<template>
  <dialog ref="fenetre" class="fenetre large" @cancel.prevent="emit('fermer')">
    <form @submit.prevent="emit('enregistrer')">
      <h2>{{ nouveau ? 'Nouveau locataire' : f.nom }}</h2>

      <fieldset>
        <legend>Locataire</legend>
        <label v-if="nouveau && locataires.length">Fiche
          <select v-model="f.locataire_id" @change="choisirLocataire">
            <option :value="null">Nouveau locataire</option>
            <option v-for="l in locataires" :key="l.id" :value="l.id">{{ l.nom }} (déjà venu)</option>
          </select>
        </label>
        <div class="rangee">
          <label class="large">Nom <input v-model="f.nom" required></label>
        </div>
        <div class="rangee">
          <label class="large">E-mail <input v-model="f.email" type="email"></label>
          <label>Téléphone <input v-model="f.telephone" size="16"></label>
        </div>
        <div class="rangee">
          <label class="large">Note (garant, coordonnées…) <input v-model="f.note_locataire"></label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Séjour</legend>
        <div class="rangee">
          <label>Lot
            <select v-model="f.lot_id" required>
              <option :value="null" disabled>Choisir…</option>
              <option v-for="lot in lots" :key="lot.id" :value="lot.id">{{ lot.code }}</option>
            </select>
          </label>
          <label>Entrée <input v-model="f.entree" type="date" required @change="changerEntree"></label>
          <label>Sortie (vide si en cours) <input v-model="f.sortie" type="date"></label>
        </div>
        <div class="rangee">
          <!-- Paid, refunded, kept: the « Dépôt » button of the list (ADR 0021) -->
          <label>Dépôt de garantie prévu au bail <input v-model="f.depot_garantie" class="nombre" size="9"></label>
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
        <table v-if="f.echeances.length" class="liste echeances">
          <thead>
            <tr><th>À partir de</th><th class="nombre">Loyer</th><th class="nombre">Provision</th><th class="nombre">Total</th><th>Note</th><th /></tr>
          </thead>
          <tbody>
            <tr v-for="(e, i) in f.echeances" :key="e.id ?? `n${i}`" class="sans-clic">
              <td><ChoixMois v-model="e.mois" /></td>
              <td class="nombre"><input v-model="e.loyer" class="nombre" size="7" aria-label="Loyer appelé" required></td>
              <td class="nombre"><input v-model="e.provision" class="nombre" size="7" aria-label="Provision appelée" required></td>
              <td class="nombre">{{ totalEcheance(e) }}</td>
              <td class="note"><input v-model="e.note" aria-label="Note" :title="e.note"></td>
              <td><button type="button" class="danger" title="Retirer cette ligne" @click="f.echeances.splice(i, 1)">✕</button></td>
            </tr>
          </tbody>
        </table>
        <p v-else class="discret">Aucun montant renseigné : les contrôles ne pourront pas repérer un mois payé en partie.</p>
        <p><button type="button" @click="ajouterEcheance">+ {{ f.echeances.length ? 'Un changement' : 'Montant appelé' }}</button></p>
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

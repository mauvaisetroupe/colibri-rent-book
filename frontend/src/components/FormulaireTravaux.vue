<script lang="ts">
import type { NatureTravaux } from '../api'

// Works paid by the owner (ADR 0015), new or edited, in a modal form; opened from a bank movement (ADR 0018), the
// payment date and the amount come from it.

export type BrouillonTravaux = {
  id: number | null
  immeuble_id: number | null
  lot_id: number | null
  fournisseur: string
  description: string
  nature: NatureTravaux
  date_facture: string
  date_paiement: string
  montant_ttc: string
  note: string
}
</script>

<script setup lang="ts">
import Big from 'big.js'
import { onMounted, ref } from 'vue'


import { NATURES_TRAVAUX, type Immeuble, type Lot } from '../api'
import { dateFr, euros } from '../format'

defineProps<{
  immeubles: Immeuble[]
  lots: Map<number, Lot[]>
  occupe: boolean
  erreur: string | null
  mouvement?: { libelle: string, date: string, montant: string, couvert: string } | null
}>()
const b = defineModel<BrouillonTravaux>({ required: true })
const emit = defineEmits<{ enregistrer: [suivant: boolean], fermer: [], supprimer: [] }>()

const fenetre = ref<HTMLDialogElement | null>(null)
onMounted(() => fenetre.value?.showModal())
</script>

<template>
  <dialog ref="fenetre" class="fenetre" @cancel.prevent="emit('fermer')">
    <form @submit.prevent="emit('enregistrer', false)">
      <h2>{{ b.id === null ? 'Nouveaux travaux' : 'Modifier les travaux' }}</h2>
      <p v-if="mouvement" class="mouvement">
        <strong>{{ mouvement.libelle }}</strong> du {{ dateFr(mouvement.date) }} : {{ euros(mouvement.montant) }}
        · déjà rapproché {{ euros(mouvement.couvert) }}
        · <strong>reste {{ euros(new Big(mouvement.montant).abs().minus(mouvement.couvert).toString()) }}</strong>
      </p>

      <div class="rangee">
        <label v-if="immeubles.length > 1">Immeuble
          <select v-model="b.immeuble_id" required @change="b.lot_id = null">
            <option v-for="i in immeubles" :key="i.id" :value="i.id">{{ i.nom }}</option>
          </select>
        </label>
        <label>Logement
          <select v-model="b.lot_id">
            <option :value="null">Immeuble, parties communes</option>
            <option v-for="l in lots.get(b.immeuble_id ?? 0) ?? []" :key="l.id" :value="l.id">{{ l.code }}</option>
          </select>
        </label>
        <label>Nature
          <select v-model="b.nature">
            <option v-for="(nom, code) in NATURES_TRAVAUX" :key="code" :value="code">{{ nom }}</option>
          </select>
        </label>
      </div>
      <div class="rangee">
        <label>Fournisseur <input v-model="b.fournisseur" required size="20"></label>
        <label class="large">Description <input v-model="b.description" required></label>
      </div>
      <div class="rangee">
        <label>Facture du <input v-model="b.date_facture" type="date" required></label>
        <label>Payée le <input v-model="b.date_paiement" type="date"></label>
        <label>Montant TTC <input v-model="b.montant_ttc" class="nombre montant" size="10" required></label>
      </div>
      <label class="large">Note <input v-model="b.note"></label>
      <p v-if="erreur" class="message erreur">{{ erreur }}</p>

      <div class="actions">
        <button type="submit" class="principal" :disabled="occupe">{{ b.id === null ? 'Ajouter' : 'Enregistrer' }}</button>
        <button v-if="b.id === null" type="button" :disabled="occupe" @click="emit('enregistrer', true)">Ajouter et en saisir d'autres</button>
        <button type="button" @click="emit('fermer')">Annuler</button>
        <button v-if="b.id !== null" type="button" class="danger" :disabled="occupe" @click="emit('supprimer')">Supprimer</button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.mouvement {
  margin: 0;
  padding: 0.5rem 0.8rem;
  border-radius: 6px;
  background: var(--fond-avertissement);
}

.montant {
  font-size: 1.1rem;
  font-weight: 600;
}
</style>

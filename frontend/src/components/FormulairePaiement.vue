<script lang="ts">
import type { ModePaiement } from '../api'

// One payment received (new or edited), in a modal form: the amount of the bank statement, split into rent,
// provision and regularisation; the split must add up to the amount (checked again by the API).

export type Brouillon = {
  id: number | null
  date: string
  sejour_id: number | null
  // 'AAAA-MM', empty for a regularisation payment alone
  mois: string
  montant: string
  loyer: string
  provision: string
  regularisation_id: number | null
  regularisation: string
  mode: ModePaiement | ''
  note: string
}
</script>

<script setup lang="ts">
import Big from 'big.js'
import { computed, onMounted, ref } from 'vue'

import { aEncaisser, api, MODES_PAIEMENT, type Echeance, type Paiement, type Regularisation, type Sejour } from '../api'
import { attendu } from '../echeances'
import { dateFr, euros, exerciceCourt, nombreApi, nombreFr } from '../format'
import ChoixMois from './ChoixMois.vue'

const props = defineProps<{
  immeuble: number
  sejours: Sejour[]
  regularisations: Regularisation[]
  // Rent and provision called (ADR 0009): the amounts proposed for the month
  echeances: Echeance[]
  // Payments already loaded: last payment toward a regularisation, as a suggestion
  paiements: Paiement[]
  occupe: boolean
  erreur: string | null
}>()
const b = defineModel<Brouillon>({ required: true })
// « suivant »: save, then start another payment (same date and mode), e.g. several lines of one bank statement
const emit = defineEmits<{ enregistrer: [suivant: boolean], fermer: [], supprimer: [] }>()

const fenetre = ref<HTMLDialogElement | null>(null)
onMounted(() => fenetre.value?.showModal())

const nouveau = computed(() => b.value.id === null)
const aujourdhui = new Date().toISOString().slice(0, 10)
const parti = (s: Sejour) => Boolean(s.sortie && s.sortie < aujourdhui)

// Present tenants first, then those who left (a regularisation may still be due)
const sejoursTries = computed(() =>
  [...props.sejours].sort((x, y) =>
    Number(parti(x)) - Number(parti(y)) || x.lot.localeCompare(y.lot) || y.entree.localeCompare(x.entree)),
)

const reste = (r: Regularisation) => new Big(r.solde).minus(r.montant_recu)

// Regularisations still to be paid (or refunded) by this tenant, and the one already chosen when editing
const regulsOuvertes = computed(() =>
  props.regularisations.filter((r) => r.sejour_id === b.value.sejour_id && !r.remplacee_par
    && (aEncaisser(r) || r.id === b.value.regularisation_id)),
)

const parse = (texte: string) => nombreApi(texte) ?? (texte.trim() === '' ? '0' : null)

const repartition = computed(() => {
  const parts = [b.value.loyer, b.value.provision, b.value.regularisation_id ? b.value.regularisation : ''].map(parse)
  const montant = nombreApi(b.value.montant)
  if (parts.some((p) => p === null) || (b.value.montant.trim() && montant === null)) {
    return { ok: false, texte: 'Un montant est illisible' }
  }
  const total = parts.reduce((t, p) => t.plus(p!), new Big(0))
  if (montant === null) {
    return { ok: false, texte: `Réparti : ${euros(total.toString())} · indiquer le montant reçu` }
  }
  const ecart = new Big(montant).minus(total)
  return ecart.eq(0)
    ? { ok: true, texte: `✓ ${euros(total.toString())} répartis sur ${euros(montant)} reçus` }
    : { ok: false, texte: `✗ Réparti ${euros(total.toString())} sur ${euros(montant)} reçus : écart de ${euros(ecart.toString())}` }
})

const pret = computed(() => repartition.value.ok && b.value.sejour_id !== null && Boolean(b.value.date))

async function choisirSejour() {
  b.value.regularisation_id = null
  b.value.regularisation = ''
  if (!nouveau.value || b.value.sejour_id === null) {
    return
  }
  // Amounts called for the month (pro rata of a month of entry or exit), else those of the last paid month
  const mois = b.value.mois || b.value.date.slice(0, 7)
  const sejour = props.sejours.find((s) => s.id === b.value.sejour_id)
  const appel = sejour ? attendu(props.echeances, sejour, mois) : null
  if (appel) {
    b.value.loyer = nombreFr(new Big(appel.loyer).toFixed(2))
    b.value.provision = nombreFr(new Big(appel.provision).toFixed(2))
    return
  }
  const lignes = await api.paiementsDuMois(props.immeuble, mois)
  const precedent = lignes.find((l) => l.sejour_id === b.value.sejour_id)?.precedent
  if (precedent) {
    b.value.loyer = nombreFr(precedent.loyer)
    b.value.provision = nombreFr(precedent.provision)
    b.value.mode = precedent.mode ?? b.value.mode
  }
}

function choisirRegul(r: Regularisation | null) {
  b.value.regularisation_id = r?.id ?? null
  if (!r) {
    b.value.regularisation = ''
    return
  }
  if (!b.value.regularisation.trim()) {
    // Last payment toward it (the instalment of a spread one), else what remains
    const dernier = props.paiements.filter((p) => p.regularisation_id === r.id).at(-1)
    b.value.regularisation = nombreFr(dernier?.regularisation ?? reste(r).toString())
  }
}

// A new payment follows its date for the month of rent, until the month is chosen by hand
function changerDate(event: Event) {
  const date = (event.target as HTMLInputElement).value
  if (nouveau.value && b.value.mois === b.value.date.slice(0, 7)) {
    b.value.mois = date.slice(0, 7)
  }
  b.value.date = date
}
</script>

<template>
  <dialog ref="fenetre" class="fenetre" @cancel.prevent="emit('fermer')">
    <form @submit.prevent="pret && emit('enregistrer', false)">
      <h2>{{ nouveau ? 'Nouveau paiement' : 'Modifier le paiement' }}</h2>

      <div class="rangee">
        <label>Reçu le <input :value="b.date" type="date" required @change="changerDate"></label>
        <label class="large">Locataire
          <select v-model="b.sejour_id" required @change="choisirSejour">
            <option :value="null" disabled>Choisir…</option>
            <option v-for="s in sejoursTries" :key="s.id" :value="s.id">
              {{ s.lot }} – {{ s.locataire }}{{ parti(s) ? ` (parti le ${dateFr(s.sortie)})` : '' }}
            </option>
          </select>
        </label>
        <label>Mode
          <select v-model="b.mode">
            <option value="">—</option>
            <option v-for="(nom, code) in MODES_PAIEMENT" :key="code" :value="code">{{ nom }}</option>
          </select>
        </label>
      </div>

      <div class="rangee">
        <label>Montant reçu (relevé) <input v-model="b.montant" class="nombre montant" size="10" required></label>
      </div>

      <fieldset>
        <legend>Loyer et provision</legend>
        <div class="rangee">
          <label>Loyer <input v-model="b.loyer" class="nombre" size="9"></label>
          <label>Provision sur charges <input v-model="b.provision" class="nombre" size="9"></label>
          <span class="champ">Mois couvert <ChoixMois v-model="b.mois" facultatif /></span>
        </div>
        <p class="discret">Laisser vides pour un versement de régularisation seul.</p>
      </fieldset>

      <fieldset>
        <legend>Régularisation</legend>
        <p v-if="b.sejour_id === null" class="discret">Choisir d'abord le locataire.</p>
        <p v-else-if="!regulsOuvertes.length" class="discret">Aucune régularisation en attente pour ce locataire.</p>
        <template v-else>
          <label class="choix">
            <input type="radio" :checked="b.regularisation_id === null" @change="choisirRegul(null)">
            Aucune
          </label>
          <label v-for="r in regulsOuvertes" :key="r.id" class="choix">
            <input type="radio" :checked="b.regularisation_id === r.id" @change="choisirRegul(r)">
            <span>
              <strong>Exercice {{ exerciceCourt(r.debut, r.fin) }}</strong>
              · envoyée le {{ dateFr(r.date_envoi) }}
              · solde {{ euros(r.solde) }} · déjà reçu {{ euros(r.montant_recu) }}
              · <strong>reste {{ euros(reste(r).toString()) }}</strong>
            </span>
          </label>
          <div v-if="b.regularisation_id" class="rangee">
            <label>Versement (négatif : remboursement au locataire)
              <input v-model="b.regularisation" class="nombre" size="9">
            </label>
          </div>
        </template>
      </fieldset>

      <label class="large">Note <input v-model="b.note"></label>

      <p class="controle" :class="repartition.ok ? 'ok' : 'ko'">{{ repartition.texte }}</p>
      <p v-if="erreur" class="message erreur">{{ erreur }}</p>

      <div class="actions">
        <button type="submit" class="principal" :disabled="occupe || !pret">
          {{ nouveau ? 'Ajouter' : 'Enregistrer' }}
        </button>
        <button v-if="nouveau" type="button" :disabled="occupe || !pret" @click="emit('enregistrer', true)">
          Ajouter et en saisir un autre
        </button>
        <button type="button" @click="emit('fermer')">Annuler</button>
        <button v-if="!nouveau" type="button" class="danger" :disabled="occupe" @click="emit('supprimer')">Supprimer</button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
/* Modal frame and fields: dialog.fenetre in style.css */
label.choix {
  flex-direction: row;
  align-items: baseline;
  gap: 0.5rem;
  font-size: 0.95rem;
  color: var(--texte);
  cursor: pointer;
}

.montant {
  font-size: 1.1rem;
  font-weight: 600;
}

.controle {
  margin: 0;
  padding: 0.5rem 0.8rem;
  border-radius: 6px;
  background: var(--surface);
  font-weight: 600;
}
</style>

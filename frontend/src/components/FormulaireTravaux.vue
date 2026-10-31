<script lang="ts">
import type { NatureTravaux, TravauxSaisie } from '../api'
import { nombreApi } from '../format'

// A works invoice paid by the owner (ADR 0015), new or edited, in a modal form, with its PDF. It is paid by bank
// movements only (ADR 0019: paid = seen at the bank): an invoice already recorded shows its payments, and links a
// transfer (a debit « travaux », or not categorised yet, with a rest) or detaches one; « Catégorisation » does the same
// from the movement.

export type BrouillonTravaux = {
  id: number | null
  building_id: number | null
  unit_id: number | null
  supplier: string
  description: string
  nature: NatureTravaux
  invoice_date: string
  total_incl_tax: string
  note: string
  // The PDF chosen, attached (or replacing the previous one) once the invoice is saved
  pdf?: File | null
}

/** What the API takes. */
export const travauxVersApi = (b: BrouillonTravaux): TravauxSaisie => ({
  building_id: b.building_id!, unit_id: b.unit_id, supplier: b.supplier.trim(), description: b.description.trim(),
  nature: b.nature, invoice_date: b.invoice_date, total_incl_tax: nombreApi(b.total_incl_tax) ?? b.total_incl_tax,
  note: b.note.trim() || null,
})
</script>

<script setup lang="ts">
import Big from 'big.js'
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'

import { api, NATURES_TRAVAUX, type Immeuble, type Lot, type Mouvement, type Travaux } from '../api'
import { dateFr, euros } from '../format'

const props = defineProps<{
  buildings: Immeuble[]
  units: Map<number, Lot[]>
  occupe: boolean
  erreur: string | null
  // The invoice as recorded (its payments, its PDF), null for a new one
  works_invoice?: Travaux | null
}>()
const b = defineModel<BrouillonTravaux>({ required: true })
// « change »: a payment linked or detached, the invoice to read again
const emit = defineEmits<{ enregistrer: [suivant: boolean], fermer: [], supprimer: [], change: [] }>()

const fenetre = ref<HTMLDialogElement | null>(null)
onMounted(() => fenetre.value?.showModal())

const choisirPdf = (event: Event) => { b.value.pdf = (event.target as HTMLInputElement).files?.[0] ?? null }

// ---------------------------------------------------------------- payments (bank movements)

const erreurLien = ref<string | null>(null)
const candidats = ref<Mouvement[] | null>(null)
const choisi = ref<number | null>(null)
const remaining = (m: Mouvement) => new Big(m.amount).abs().minus(m.covered)
const days = (m: Mouvement) => Math.abs(new Date(m.transaction_date).getTime() - new Date(b.value.invoice_date || m.transaction_date).getTime()) / 864e5
const correspond = (m: Mouvement) => Boolean(props.works_invoice && remaining(m).eq(props.works_invoice.remaining))

// The debits « travaux » (or not categorised yet) with a rest: those whose rest is the invoice's first, then by date
async function ouvrirRattachement() {
  erreurLien.value = null
  const tous = await api.transactions('tous')
  candidats.value = tous.filter((m) => new Big(m.amount).lt(0) && (m.category === 'works' || m.category === null) && remaining(m).gt(0))
    .sort((x, y) => Number(correspond(y)) - Number(correspond(x)) || Number(y.category === 'works') - Number(x.category === 'works')
      || days(x) - days(y))
  choisi.value = candidats.value[0]?.id ?? null
}

async function rattacher() {
  if (!props.works_invoice || choisi.value === null) {
    return
  }
  try {
    await api.lierMouvement(choisi.value, { works_invoice_id: props.works_invoice.id })
    candidats.value = null
    emit('change')
  } catch (e) {
    erreurLien.value = (e as Error).message
  }
}

async function detacher(r: Travaux['payments'][number]) {
  try {
    await api.delierMouvement(r.bank_transaction_id, { works_invoice_payment_id: r.id })
    emit('change')
  } catch (e) {
    erreurLien.value = (e as Error).message
  }
}

const state = computed(() => {
  const t = props.works_invoice
  return !t ? null : Number(t.remaining) <= 0 ? { classe: 'ok', text: '✓ payée en entier' }
    : { classe: t.payments.length ? 'alerte' : 'discret', text: `reste à payer ${euros(t.remaining)}` }
})
</script>

<template>
  <dialog ref="fenetre" class="fenetre" @cancel.prevent="emit('fermer')">
    <form @submit.prevent="emit('enregistrer', false)">
      <h2>{{ b.id === null ? 'Nouvelle facture de travaux' : 'Facture de travaux' }}</h2>

      <div class="rangee">
        <label v-if="buildings.length > 1">Immeuble
          <select v-model="b.building_id" required @change="b.unit_id = null">
            <option v-for="i in buildings" :key="i.id" :value="i.id">{{ i.name }}</option>
          </select>
        </label>
        <label>Logement
          <select v-model="b.unit_id">
            <option :value="null">Immeuble, parties communes</option>
            <option v-for="l in units.get(b.building_id ?? 0) ?? []" :key="l.id" :value="l.id">{{ l.code }}</option>
          </select>
        </label>
        <label>Nature
          <select v-model="b.nature">
            <option v-for="(name, code) in NATURES_TRAVAUX" :key="code" :value="code">{{ name }}</option>
          </select>
        </label>
      </div>
      <div class="rangee">
        <label>Fournisseur <input v-model="b.supplier" required size="20"></label>
        <label class="large">Description <input v-model="b.description" required></label>
      </div>
      <div class="rangee">
        <label>Facture du <input v-model="b.invoice_date" type="date" required></label>
        <label>Montant TTC <input v-model="b.total_incl_tax" class="nombre montant" size="10" required></label>
        <span class="champ">PDF de la facture
          <span class="pdf">
            <a v-if="works_invoice?.pdf && !b.pdf" :href="api.travauxPdfUrl(works_invoice.id)" target="_blank">ouvrir</a>
            <label class="lien">{{ b.pdf ? b.pdf.name : works_invoice?.pdf ? 'remplacer' : 'joindre' }}
              <input type="file" accept="application/pdf" hidden @change="choisirPdf">
            </label>
          </span>
        </span>
      </div>
      <label class="large">Note <input v-model="b.note"></label>

      <fieldset>
        <legend>Paiements (virements de la banque)</legend>
        <p v-if="!works_invoice" class="discret">
          Une facture est payée par les virements de la banque : enregistrer d'abord la facture, puis rattacher son ou ses
          virements (acompte, solde), ici ou depuis « Catégorisation des mouvements ».
        </p>
        <template v-else>
          <ul v-if="works_invoice.payments.length" class="reglements">
            <li v-for="r in works_invoice.payments" :key="r.id">
              {{ dateFr(r.payment_date) }} · {{ r.label }} : <strong>{{ euros(r.amount) }}</strong>
              <RouterLink :to="{ name: 'bank', query: { bank_transaction: r.bank_transaction_id } }" target="_blank">voir</RouterLink>
              <button type="button" class="lien-bouton" :disabled="occupe" @click="detacher(r)">Détacher</button>
            </li>
          </ul>
          <p v-else class="discret">Aucun virement rattaché : la facture n'est pas payée.</p>
          <p v-if="state" :class="state.classe">{{ state.text }}</p>
          <div v-if="Number(works_invoice.remaining) > 0" class="rangee">
            <button v-if="candidats === null" type="button" @click="ouvrirRattachement">Rattacher un virement…</button>
            <template v-else>
              <label v-if="candidats.length" class="large">Virement
                <select v-model="choisi">
                  <option v-for="m in candidats" :key="m.id" :value="m.id">
                    {{ correspond(m) ? '✓ ' : '' }}{{ dateFr(m.transaction_date) }} · {{ m.label }} : {{ euros(m.amount) }}{{ Number(m.covered) > 0 ? `, reste ${euros(remaining(m).toString())}` : '' }}
                  </option>
                </select>
              </label>
              <span v-else class="discret">Aucun débit « travaux » ou non catégorisé qui ait encore un reste.</span>
              <button type="button" class="principal" :disabled="choisi === null" @click="rattacher">Rattacher</button>
              <button type="button" @click="candidats = null">Annuler</button>
            </template>
          </div>
          <p v-if="erreurLien" class="message erreur">{{ erreurLien }}</p>
        </template>
      </fieldset>

      <p v-if="erreur" class="message erreur">{{ erreur }}</p>
      <div class="actions">
        <button type="submit" class="principal" :disabled="occupe">{{ b.id === null ? 'Enregistrer la facture' : 'Enregistrer' }}</button>
        <button v-if="b.id === null" type="button" :disabled="occupe" @click="emit('enregistrer', true)">Enregistrer et en saisir une autre</button>
        <button type="button" @click="emit('fermer')">Fermer</button>
        <button v-if="b.id !== null" type="button" class="danger" :disabled="occupe" @click="emit('supprimer')">Supprimer</button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.montant {
  font-size: 1.1rem;
  font-weight: 600;
}

.pdf {
  display: inline-flex;
  gap: 0.6rem;
  align-items: center;
  min-height: 2rem;
}

.lien,
.lien-bouton {
  color: var(--accent);
  cursor: pointer;
}

.lien-bouton {
  border: none;
  background: none;
  padding: 0 0.3rem;
}

.reglements {
  margin: 0;
  padding-left: 1.2rem;
}

.reglements li {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
}
</style>

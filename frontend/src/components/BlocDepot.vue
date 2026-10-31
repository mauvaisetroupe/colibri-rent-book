<script lang="ts">
// The deposit of a stay (ADR 0021), a block of its form (FormulaireLocataire): what was paid and refunded (linked to
// their bank transfer, or to none: paid to an agency, before the statements), and the retention, what is kept to cover
// unpaid months or regularisations (payments « depot », never seen at the bank, made again as a whole here). Each
// action is saved at once, apart from the form's own « Enregistrer »: no nested form, and Enter does not submit the
// form. Opened from the bank (« Dépôt de garantie… » on a transfer), a deposit received or a refund comes prefilled.

export type DepotPrerempli = { sens: 'recu' | 'restitution', date: string, amount: string, bank_transaction_id: number }
</script>

<script setup lang="ts">
import Big from 'big.js'
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'

import {
  api, estRetenue, type Echeance, type Mouvement, type Paiement, type Regularisation, type Sejour, type VersementDepot,
} from '../api'
import { dusDuSejour, partageMois, type Du } from '../depot'
import { dateFr, euros, nombreApi, nombreFr } from '../format'

const props = defineProps<{ tenancy: Sejour, building: number, rent_schedules: Echeance[], prerempli: DepotPrerempli | null }>()
const emit = defineEmits<{ modifie: [] }>()

const versements = ref<VersementDepot[]>([])
const payments = ref<Paiement[]>([])
const charge_adjustments = ref<Regularisation[]>([])
const transactions = ref<Mouvement[]>([])
const erreur = ref<string | null>(null)
const occupe = ref(false)

async function charger() {
  const [v, p, r, m] = await Promise.all([api.deposits(props.building), api.payments(props.building, null),
    api.charge_adjustments(props.building), api.transactions('tous')])
  versements.value = v.filter((x) => x.tenancy_id === props.tenancy.id)
  payments.value = p
  charge_adjustments.value = r
  transactions.value = m
}

onMounted(async () => {
  try {
    await charger()
    if (props.prerempli) {
      const p = props.prerempli
      versement.value = { id: null, sens: p.sens, date: p.date, amount: nombreFr(p.amount), bank_transaction_id: p.bank_transaction_id, note: '' }
    }
  } catch (e) {
    erreur.value = (e as Error).message
  }
})

const retenue = computed(() => payments.value.filter((p) => p.tenancy_id === props.tenancy.id && estRetenue(p)))
const somme = (valeurs: string[]) => valeurs.reduce((t, v) => t.plus(v), new Big(0))
const paid = computed(() => somme(versements.value.map((v) => v.amount)))
const retained = computed(() => somme(retenue.value.map((p) => new Big(p.rent).plus(p.charge_advance).plus(p.charge_adjustment).toString())))
const detenu = computed(() => paid.value.minus(retained.value))

const mouvementDe = (id: number | null) => transactions.value.find((m) => m.id === id)
const libelleRetenue = (p: Paiement) => {
  if (p.month) {
    return `Loyer ${p.month.slice(5, 7)}/${p.month.slice(0, 4)}`
  }
  const r = charge_adjustments.value.find((x) => x.id === p.charge_adjustment_id)
  return r ? `Régularisation ${r.start.slice(0, 4)}${r.end.slice(0, 4) !== r.start.slice(0, 4) ? `-${r.end.slice(0, 4)}` : ''}` : 'Régularisation'
}

async function agir(action: () => Promise<unknown>) {
  occupe.value = true
  erreur.value = null
  try {
    await action()
    await charger()
    emit('modifie')
    return true
  } catch (e) {
    erreur.value = (e as Error).message
    return false
  } finally {
    occupe.value = false
  }
}

// ---------------------------------------------------------------- deposit received, refund

type SaisieVersement = { id: number | null, sens: 'recu' | 'restitution', date: string, amount: string, bank_transaction_id: number | null, note: string }
const versement = ref<SaisieVersement | null>(null)

function nouveauVersement(sens: 'recu' | 'restitution') {
  const amount = sens === 'recu' ? props.tenancy.security_deposit : (detenu.value.gt(0) ? detenu.value.toString() : null)
  versement.value = {
    id: null, sens, date: sens === 'recu' ? props.tenancy.move_in : (props.tenancy.move_out ?? new Date().toISOString().slice(0, 10)),
    amount: nombreFr(amount), bank_transaction_id: null, note: '',
  }
}

function modifierVersement(v: VersementDepot) {
  versement.value = {
    id: v.id, sens: new Big(v.amount).gt(0) ? 'recu' : 'restitution', date: v.payment_date,
    amount: nombreFr(new Big(v.amount).abs().toString()), bank_transaction_id: v.bank_transaction_id, note: v.note ?? '',
  }
}

// Transfers it may be: of its sense, a tenant payment, a deposit or not categorised, with a rest (or the one linked);
// the same amount first, then the nearest in time
const candidats = computed(() => {
  const v = versement.value
  if (!v) {
    return []
  }
  const amount = new Big(nombreApi(v.amount) ?? '0')
  const ecart = (m: Mouvement) => Math.abs(new Date(m.transaction_date).getTime() - new Date(v.date || props.tenancy.move_in).getTime())
  return transactions.value
    .filter((m) => (new Big(m.amount).gt(0) === (v.sens === 'recu'))
      && (m.category === null || m.category === 'tenant' || m.category === 'security_deposit')
      && (m.id === v.bank_transaction_id || new Big(m.amount).abs().minus(m.covered).gt(0)))
    .map((m) => ({ m, egal: new Big(m.amount).abs().minus(m.covered).eq(amount) }))
    .sort((a, b) => Number(b.egal) - Number(a.egal) || ecart(a.m) - ecart(b.m))
    .slice(0, 30)
})

async function enregistrerVersement() {
  const v = versement.value!
  const amount = nombreApi(v.amount)
  if (!amount || !new Big(amount).gt(0)) {
    erreur.value = 'Montant : un nombre positif (le sens vient du bouton)'
    return
  }
  const donnees = {
    tenancy_id: props.tenancy.id, payment_date: v.date, amount: v.sens === 'recu' ? amount : `-${amount}`,
    bank_transaction_id: v.bank_transaction_id, note: v.note.trim() || null,
  }
  if (await agir(() => (v.id === null ? api.creerDepot(donnees) : api.modifierDepot(v.id, donnees)))) {
    versement.value = null
  }
}

function supprimerVersement(v: VersementDepot) {
  if (confirm(`Supprimer ce ${new Big(v.amount).gt(0) ? 'dépôt' : 'remboursement'} de ${euros(new Big(v.amount).abs().toString())} ?`)) {
    return agir(() => api.supprimerDepot(v.id))
  }
}

// ---------------------------------------------------------------- retention

type LigneSaisie = Du & { pris: boolean, amount: string }
const saisieRetenue = ref<{ date: string, lines: LigneSaisie[] } | null>(null)

function ouvrirRetenue() {
  const dus = dusDuSejour(props.tenancy, props.rent_schedules, payments.value, charge_adjustments.value, paid.value.toString())
  // A retention already made: its amounts; else the proposal, the oldest first up to the deposit
  const actuel = (d: Du) => retenue.value.filter((p) => (d.month ? p.month?.startsWith(d.month) : p.charge_adjustment_id === d.charge_adjustment_id))
    .reduce((t, p) => t.plus(p.rent).plus(p.charge_advance).plus(p.charge_adjustment), new Big(0))
  saisieRetenue.value = {
    date: retenue.value[0]?.payment_date ?? props.tenancy.move_out ?? new Date().toISOString().slice(0, 10),
    lines: dus.map((d) => {
      const amount = retenue.value.length ? actuel(d).toString() : d.propose
      return { ...d, pris: new Big(amount).gt(0), amount: nombreFr(amount) }
    }),
  }
}

const totalRetenue = computed(() => somme((saisieRetenue.value?.lines ?? []).filter((l) => l.pris).map((l) => nombreApi(l.amount) ?? '0')))
const aRendre = computed(() => paid.value.minus(totalRetenue.value))

async function enregistrerRetenue() {
  const s = saisieRetenue.value!
  const lines = s.lines.filter((l) => l.pris && Number(nombreApi(l.amount) ?? 0) > 0).map((l) => {
    const amount = nombreApi(l.amount)!
    return l.month ? { month: l.month, ...partageMois(l, amount) } : { charge_adjustment_id: l.charge_adjustment_id!, charge_adjustment: amount }
  })
  if (await agir(() => api.retenue(props.tenancy.id, { date: s.date, lines }))) {
    saisieRetenue.value = null
  }
}

function annulerRetenue() {
  if (confirm('Annuler la retenue ? Les mois et régularisations qu\'elle couvrait redeviennent dus.')) {
    return agir(() => api.retenue(props.tenancy.id, { date: props.tenancy.move_out ?? new Date().toISOString().slice(0, 10), lines: [] }))
  }
}
</script>

<template>
  <div class="bloc-depot" @keydown.enter.prevent>
    <p class="resume">
      Versé {{ euros(paid.toString()) }}
      <template v-if="retained.gt(0)"> · retenu {{ euros(retained.toString()) }}</template>
      · <strong>détenu {{ euros(detenu.toString()) }}</strong>
    </p>

    <table v-if="versements.length || retenue.length" class="liste">
      <thead><tr><th>Date</th><th>Mouvement</th><th class="nombre">Montant</th><th>Virement</th><th>Note</th><th /></tr></thead>
      <tbody>
        <tr v-for="v in versements" :key="`v${v.id}`" class="sans-clic">
          <td>{{ dateFr(v.payment_date) }}</td>
          <td>{{ new Big(v.amount).gt(0) ? 'Dépôt reçu' : 'Restitution' }}</td>
          <td class="nombre">{{ euros(v.amount) }}</td>
          <td>
            <template v-if="mouvementDe(v.bank_transaction_id)">{{ dateFr(mouvementDe(v.bank_transaction_id)!.transaction_date) }} {{ mouvementDe(v.bank_transaction_id)!.label }}</template>
            <span v-else class="discret">sans virement</span>
          </td>
          <td class="discret">{{ v.note }}</td>
          <td class="actions-ligne">
            <button type="button" title="Modifier" :disabled="occupe" @click="modifierVersement(v)">✎</button>
            <button type="button" class="danger" title="Supprimer" :disabled="occupe" @click="supprimerVersement(v)">✕</button>
          </td>
        </tr>
        <tr v-for="(p, i) in retenue" :key="`r${p.id}`" class="sans-clic">
          <td>{{ dateFr(p.payment_date) }}</td>
          <td>Retenue : {{ libelleRetenue(p) }}</td>
          <td class="nombre">{{ euros(new Big(p.rent).plus(p.charge_advance).plus(p.charge_adjustment).neg().toString()) }}</td>
          <td><span class="discret">sans virement</span></td>
          <td />
          <td class="actions-ligne">
            <template v-if="i === 0">
              <button type="button" title="Refaire la retenue" :disabled="occupe" @click="ouvrirRetenue">✎</button>
              <button type="button" class="danger" title="Annuler la retenue" :disabled="occupe" @click="annulerRetenue">✕</button>
            </template>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else class="discret">Aucun dépôt enregistré.</p>

    <div v-if="!versement && !saisieRetenue" class="actions">
      <button type="button" :disabled="occupe" @click="nouveauVersement('recu')">Dépôt reçu…</button>
      <button type="button" :disabled="occupe || !detenu.gt(0)" @click="nouveauVersement('restitution')">Restitution…</button>
      <button type="button" :disabled="occupe || !paid.gt(0)" @click="ouvrirRetenue">Retenue…</button>
    </div>

    <!-- Deposit received or refunded -->
    <div v-if="versement" class="formulaire">
      <h3>{{ versement.sens === 'recu' ? 'Dépôt reçu' : 'Restitution' }}</h3>
      <div class="rangee">
        <label>Date <input v-model="versement.date" type="date"></label>
        <label>Montant <input v-model="versement.amount" class="nombre" size="9"></label>
      </div>
      <label class="large">Virement
        <select v-model="versement.bank_transaction_id">
          <option :value="null">Aucun (agence, espèces, avant les relevés…)</option>
          <option v-for="c in candidats" :key="c.m.id" :value="c.m.id">
            {{ c.egal ? '✓ ' : '' }}{{ dateFr(c.m.transaction_date) }} · {{ c.m.label }} · {{ euros(c.m.amount) }}
            <template v-if="Number(c.m.covered) > 0"> (reste {{ euros(new Big(c.m.amount).abs().minus(c.m.covered).toString()) }})</template>
          </option>
        </select>
      </label>
      <label class="large">Note <input v-model="versement.note"></label>
      <div class="actions">
        <button type="button" class="principal" :disabled="occupe || !versement.date" @click="enregistrerVersement">Enregistrer</button>
        <button type="button" @click="versement = null">Annuler</button>
      </div>
    </div>

    <!-- Retention: what the deposit covers -->
    <div v-if="saisieRetenue" class="formulaire">
      <h3>Retenue sur le dépôt de {{ euros(paid.toString()) }}</h3>
      <p class="discret">
        Ce que le locataire doit encore, les plus anciens d'abord : les mois impayés et les régularisations envoyées non
        soldées. Les montants sont proposés jusqu'au dépôt versé ; ils se modifient.
      </p>
      <label>Date <input v-model="saisieRetenue.date" type="date"></label>
      <table v-if="saisieRetenue.lines.length" class="liste">
        <thead><tr><th /><th>Dû</th><th class="nombre">Reste dû</th><th class="nombre">Retenu</th></tr></thead>
        <tbody>
          <tr v-for="l in saisieRetenue.lines" :key="l.cle" class="sans-clic">
            <td><input v-model="l.pris" type="checkbox" :aria-label="l.label"></td>
            <td>{{ l.label }}</td>
            <td class="nombre">{{ euros(l.du) }}</td>
            <td class="nombre"><input v-model="l.amount" class="nombre" size="9" :disabled="!l.pris" :aria-label="`Retenu sur ${l.label}`"></td>
          </tr>
        </tbody>
      </table>
      <p v-else class="discret">Rien n'est dû : ni mois impayé, ni régularisation envoyée non soldée.</p>
      <p class="controle" :class="aRendre.lt(0) ? 'ko' : 'ok'">
        Retenu {{ euros(totalRetenue.toString()) }} ·
        <template v-if="aRendre.lt(0)">dépasse le dépôt de {{ euros(aRendre.neg().toString()) }}</template>
        <template v-else-if="aRendre.gt(0)">reste {{ euros(aRendre.toString()) }} à restituer (Restitution…)</template>
        <template v-else>rien à restituer</template>
      </p>
      <div class="actions">
        <button type="button" class="principal" :disabled="occupe || aRendre.lt(0) || !saisieRetenue.date" @click="enregistrerRetenue">
          Enregistrer la retenue
        </button>
        <button type="button" @click="saisieRetenue = null">Annuler</button>
      </div>
    </div>

    <p v-if="erreur" class="message erreur">{{ erreur }}</p>
    <p v-if="prerempli"><RouterLink to="/banque">Retour à la banque</RouterLink></p>
  </div>
</template>

<style scoped>
.formulaire {
  margin-top: 1rem;
  padding: 0.6rem 0.8rem;
  border-radius: 6px;
  background: var(--fond-avertissement);
}

.actions-ligne {
  white-space: nowrap;
}

.controle {
  margin: 0.5rem 0;
  padding: 0.5rem 0.8rem;
  border-radius: 6px;
  background: var(--surface);
  font-weight: 600;
}
</style>

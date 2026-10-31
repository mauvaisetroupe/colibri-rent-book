<script lang="ts">
import Big from 'big.js'

import { api, type ModePaiement, type PaiementSaisi } from '../api'
import { nombreApi } from '../format'

// One payment received (new or edited), in a modal form: the amount of the bank statement, split into rent,
// provision and regularisations; the split must add up to the amount (checked again by the API). Opened from a bank
// movement, a rest may be left (a deposit paid with the rent…): the movement stays « à rattacher » until it is linked;
// a deposit is entered from the stay (ADR 0021).

// Toward one regularisation; negative: refund paid by the owner
export type Versement = { charge_adjustment_id: number, amount: string }

export type Brouillon = {
  id: number | null
  date: string
  tenancy_id: number | null
  // 'AAAA-MM', empty for a regularisation payment alone
  month: string
  amount: string
  rent: string
  charge_advance: string
  // A payment carries one regularisation: the first goes with the rent, each other one is a payment of its own
  versements: Versement[]
  method: ModePaiement | ''
  note: string
}

const zero = (text: string) => (nombreApi(text) ?? '0') === '0'

/** The payments a draft makes: rent, provision and the first regularisation, then one per other regularisation. */
export function saisies(b: Brouillon, bank_transaction_id: number | null = null): PaiementSaisi[] {
  const commun = { tenancy_id: b.tenancy_id!, payment_date: b.date, method: b.method || null, note: b.note.trim() || null }
  const avecMouvement = bank_transaction_id === null ? {} : { bank_transaction_id }
  const loyerSeul = !zero(b.rent) || !zero(b.charge_advance)
  const [premier, ...autres] = loyerSeul || !b.versements.length ? [null, ...b.versements] : b.versements
  const ligne = (rent: string, charge_advance: string, v: Versement | null, month: string | null): PaiementSaisi => {
    const charge_adjustment = v ? nombreApi(v.amount) ?? '0' : '0'
    return {
      ...commun, ...avecMouvement, month, rent, charge_advance, charge_adjustment_id: v?.charge_adjustment_id ?? null, charge_adjustment,
      // Checked again by the API: this payment's own split
      amount: new Big(rent).plus(charge_advance).plus(charge_adjustment).toString(),
    }
  }
  return [
    // A regularisation payment alone covers no month of rent
    ligne(nombreApi(b.rent) ?? '0', nombreApi(b.charge_advance) ?? '0', premier ?? null, loyerSeul ? b.month || null : null),
    ...autres.map((v) => ligne('0', '0', v, null)),
  ]
}

/** Saves a draft: the payment itself (created or changed), then those of the other regularisations. */
export async function enregistrerBrouillon(b: Brouillon, bank_transaction_id: number | null = null) {
  const [premier, ...autres] = saisies(b, bank_transaction_id)
  if (b.id === null) {
    await api.creerPaiement(premier!)
  } else {
    await api.modifierPaiement(b.id, premier!)
  }
  for (const s of autres) {
    await api.creerPaiement(s)
  }
}
</script>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import { aEncaisser, MODES_PAIEMENT, type Echeance, type Paiement, type Regularisation, type Sejour } from '../api'
import { attendu } from '../echeances'
import { dateFr, euros, exerciceCourt, nombreFr } from '../format'
import { regularisationCourante } from '../rectification'
import ChoixMois from './ChoixMois.vue'

const props = defineProps<{
  building: number
  tenancies: Sejour[]
  charge_adjustments: Regularisation[]
  // Rent and provision called (ADR 0009): the amounts proposed for the month
  rent_schedules: Echeance[]
  // Payments already loaded: last payment toward a regularisation, as a suggestion
  payments: Paiement[]
  occupe: boolean
  erreur: string | null
  // Opened from a bank movement (ADR 0018): what it is, recalled above the form
  bank_transaction?: { label: string, date: string, amount: string, covered: string } | null
}>()
const b = defineModel<Brouillon>({ required: true })
// « suivant »: save, then start another payment (same date and mode), e.g. several lines of one bank statement
const emit = defineEmits<{ enregistrer: [suivant: boolean], fermer: [], supprimer: [] }>()

const fenetre = ref<HTMLDialogElement | null>(null)
onMounted(() => {
  // Edited, a payment made toward a regularisation since corrected goes to its corrective one: the one listed below
  b.value.versements = b.value.versements.map((v) =>
    ({ ...v, charge_adjustment_id: regularisationCourante(v.charge_adjustment_id, props.charge_adjustments) }))
  fenetre.value?.showModal()
})

const nouveau = computed(() => b.value.id === null)
const aujourdhui = new Date().toISOString().slice(0, 10)
const parti = (s: Sejour) => Boolean(s.move_out && s.move_out < aujourdhui)

// Present tenants first, then those who left (a regularisation may still be due)
const sejoursTries = computed(() =>
  [...props.tenancies].sort((x, y) =>
    Number(parti(x)) - Number(parti(y)) || x.unit.localeCompare(y.unit) || y.move_in.localeCompare(x.move_in)),
)

const remaining = (r: Regularisation) => new Big(r.balance).minus(r.amount_received)

// Regularisations still to be paid (or refunded) by this tenant, and the one already chosen when editing
const regulsOuvertes = computed(() =>
  props.charge_adjustments.filter((r) => r.tenancy_id === b.value.tenancy_id && !r.replaced_by
    && (aEncaisser(r) || b.value.versements.some((v) => v.charge_adjustment_id === r.id))),
)

const parse = (text: string) => nombreApi(text) ?? (text.trim() === '' ? '0' : null)

const apportionment = computed(() => {
  const shares = [b.value.rent, b.value.charge_advance, ...b.value.versements.map((v) => v.amount)].map(parse)
  const amount = nombreApi(b.value.amount)
  if (shares.some((p) => p === null) || (b.value.amount.trim() && amount === null)) {
    return { ok: false, text: 'Un montant est illisible' }
  }
  const total = shares.reduce((t, p) => t.plus(p!), new Big(0))
  if (amount === null) {
    return { ok: false, text: `Réparti : ${euros(total.toString())} · indiquer le montant reçu` }
  }
  // What is not split, positive: less received (or refunded, for a negative amount) than split is a rest
  const ecart = new Big(amount).minus(total).times(new Big(amount).lt(0) ? -1 : 1)
  if (ecart.eq(0)) {
    return { ok: true, text: `✓ ${euros(total.toString())} répartis sur ${euros(amount)} reçus` }
  }
  // From a bank movement, less than received: the rest is left to link (a deposit: from the stay), the movement stays
  // to complete
  if (props.bank_transaction && ecart.gt(0) && !total.eq(0)) {
    return { ok: true, text: `✓ ${euros(total.toString())} répartis, reste de ${euros(ecart.toString())} à rattacher (un dépôt de garantie : « Dépôt de garantie… » sous le virement)` }
  }
  return { ok: false, text: `✗ Réparti ${euros(total.toString())} sur ${euros(amount)} reçus : écart de ${euros(ecart.toString())}` }
})

const pret = computed(() => apportionment.value.ok && b.value.tenancy_id !== null && Boolean(b.value.date))

async function choisirSejour() {
  b.value.versements = []
  await montantsAppeles()
}

// The rent and provision of a new payment follow the stay and the month chosen
watch(() => b.value.month, montantsAppeles)

async function montantsAppeles() {
  if (!nouveau.value || b.value.tenancy_id === null) {
    return
  }
  // Amounts called for the month (pro rata of a month of entry or exit), else those of the last paid month
  const month = b.value.month || b.value.date.slice(0, 7)
  const tenancy = props.tenancies.find((s) => s.id === b.value.tenancy_id)
  const appel = tenancy ? attendu(props.rent_schedules, tenancy, month) : null
  if (appel) {
    b.value.rent = nombreFr(new Big(appel.rent).toFixed(2))
    b.value.charge_advance = nombreFr(new Big(appel.charge_advance).toFixed(2))
    return
  }
  const lines = await api.paiementsDuMois(props.building, month)
  const previous = lines.find((l) => l.tenancy_id === b.value.tenancy_id)?.previous
  if (previous) {
    b.value.rent = nombreFr(previous.rent)
    b.value.charge_advance = nombreFr(previous.charge_advance)
    b.value.method = previous.method ?? b.value.method
  }
}

const versement = (r: Regularisation) => b.value.versements.find((v) => v.charge_adjustment_id === r.id)

function basculerRegul(r: Regularisation, coche: boolean) {
  if (!coche) {
    b.value.versements = b.value.versements.filter((v) => v.charge_adjustment_id !== r.id)
    return
  }
  // What the transfer still leaves unsplit (no more than its rest), else the last payment toward it (the instalment of
  // a spread one), else its rest
  const recu = parse(b.value.amount)
  const reparti = [b.value.rent, b.value.charge_advance, ...b.value.versements.map((v) => v.amount)]
    .reduce((t, x) => t.plus(parse(x) ?? '0'), new Big(0))
  const libre = recu === null ? null : new Big(recu).minus(reparti)
  const last = props.payments.filter((p) => p.charge_adjustment_id === r.id).at(-1)
  const amount = libre?.gt(0) ? (libre.gt(remaining(r)) ? remaining(r) : libre).toString() : last?.charge_adjustment ?? remaining(r).toString()
  b.value.versements = [...b.value.versements, { charge_adjustment_id: r.id, amount: nombreFr(amount) }]
}

// A new payment follows its date for the month of rent, until the month is chosen by hand
function changerDate(event: Event) {
  const date = (event.target as HTMLInputElement).value
  if (nouveau.value && b.value.month === b.value.date.slice(0, 7)) {
    b.value.month = date.slice(0, 7)
  }
  b.value.date = date
}
</script>

<template>
  <dialog ref="fenetre" class="fenetre" @cancel.prevent="emit('fermer')">
    <form @submit.prevent="pret && emit('enregistrer', false)">
      <h2>{{ nouveau ? 'Nouveau paiement du locataire' : 'Modifier le paiement du locataire' }}</h2>
      <p v-if="bank_transaction" class="mouvement">
        <strong>{{ bank_transaction.label }}</strong> du {{ dateFr(bank_transaction.date) }} : {{ euros(bank_transaction.amount) }}
        · déjà rapproché {{ euros(bank_transaction.covered) }}
        · <strong>reste {{ euros(new Big(bank_transaction.amount).abs().minus(bank_transaction.covered).toString()) }}</strong>
      </p>

      <div class="rangee">
        <label>Reçu le <input :value="b.date" type="date" required @change="changerDate"></label>
        <label class="large">Locataire
          <select v-model="b.tenancy_id" required @change="choisirSejour">
            <option :value="null" disabled>Choisir…</option>
            <option v-for="s in sejoursTries" :key="s.id" :value="s.id">
              {{ s.unit }} – {{ s.tenant }}{{ parti(s) ? ` (parti le ${dateFr(s.move_out)})` : '' }}
            </option>
          </select>
        </label>
        <label>Mode
          <select v-model="b.method">
            <option value="">—</option>
            <option v-for="(name, code) in MODES_PAIEMENT" :key="code" :value="code">{{ name }}</option>
          </select>
        </label>
      </div>

      <div class="rangee">
        <label>Montant reçu (relevé) <input v-model="b.amount" class="nombre montant" size="10" required></label>
      </div>

      <fieldset>
        <legend>Loyer et provision</legend>
        <div class="rangee">
          <label>Loyer <input v-model="b.rent" class="nombre" size="9"></label>
          <label>Provision sur charges <input v-model="b.charge_advance" class="nombre" size="9"></label>
          <span class="champ">Mois couvert <ChoixMois v-model="b.month" facultatif /></span>
        </div>
        <p class="discret">Laisser vides pour un versement de régularisation seul.</p>
      </fieldset>

      <fieldset>
        <legend>Régularisation</legend>
        <p v-if="b.tenancy_id === null" class="discret">Choisir d'abord le locataire.</p>
        <p v-else-if="!regulsOuvertes.length" class="discret">Aucune régularisation en attente pour ce locataire.</p>
        <template v-else>
          <p class="discret">Cocher la ou les régularisations payées ; un paiement est enregistré pour chacune.</p>
          <div v-for="r in regulsOuvertes" :key="r.id" class="regul">
            <label class="choix">
              <input type="checkbox" :checked="Boolean(versement(r))" @change="basculerRegul(r, ($event.target as HTMLInputElement).checked)">
              <span>
                <strong>Exercice {{ exerciceCourt(r.start, r.end) }}</strong>
                · envoyée le {{ dateFr(r.sent_on) }}
                · solde {{ euros(r.balance) }} · déjà reçu {{ euros(r.amount_received) }}
                · <strong>reste {{ euros(remaining(r).toString()) }}</strong>
              </span>
            </label>
            <label v-if="versement(r)" class="versement">Versement (négatif : remboursement au locataire)
              <input v-model="versement(r)!.amount" class="nombre" size="9">
            </label>
          </div>
        </template>
      </fieldset>

      <label class="large">Note du paiement <input v-model="b.note"></label>


      <p class="controle" :class="apportionment.ok ? 'ok' : 'ko'">{{ apportionment.text }}</p>
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

.mouvement {
  margin: 0;
  padding: 0.5rem 0.8rem;
  border-radius: 6px;
  background: var(--fond-avertissement);
}

.regul {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.versement {
  margin-left: 1.6rem;
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

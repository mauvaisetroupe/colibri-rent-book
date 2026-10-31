<script setup lang="ts">
import Big from 'big.js'
import Column from 'openvue/column'
import DataTable from 'openvue/datatable'
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'

import {
  api, estRetenue, NOMS_MODES, type Echeance, type Paiement, type Regularisation, type Sejour,
} from '../api'
import ColumnFilter from '../components/ColumnFilter.vue'
import FormulairePaiement, { type Brouillon, enregistrerBrouillon } from '../components/FormulairePaiement.vue'
import { exerciceCourt, nombreFr } from '../format'
import { useImmeuble } from '../immeuble'
import { contains, distinctOptions, equals, optionsOf, stateKey, withDefaults, type Filters, type FilteredTable } from '../lists'

// Payments received (ADR 0008), one row per payment (a bank transfer, a cheque), entered in a modal form: amount
// received split into rent, provision and regularisation. The provisions of a year are the sum of its
// monthly payments; a regularisation is settled when its payments reach its balance (computed, ADR 0010). A retention on
// the deposit (ADR 0021) is shown, locked: it is changed from the deposit of the stay (Locataires). The list: every
// year, a filter under each column on the fields of the API, kept for the session.

const { immeubleId: building, pret: ready } = useImmeuble()
const message = ref<{ text: string, type: 'info' | 'erreur' } | null>(null)
const busy = ref(false)
const today = new Date().toISOString().slice(0, 10)

const payments = ref<Paiement[]>([])
const stays = ref<Sejour[]>([])
const charge_adjustments = ref<Regularisation[]>([])
const instalments = ref<Echeance[]>([])

async function load() {
  if (building.value === null) {
    return
  }
  try {
    ;[payments.value, stays.value, charge_adjustments.value, instalments.value] = await Promise.all([
      api.payments(building.value, null), api.tenancies(building.value), api.charge_adjustments(building.value),
      api.rent_schedules(building.value),
    ])
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
  }
}

onMounted(async () => {
  await ready
  await load()
})
watch(building, load)

// ---------------------------------------------------------------- list

const total = (p: Paiement) => new Big(p.rent).plus(p.charge_advance).plus(p.charge_adjustment).toFixed(2)
const exercise = (id: number | null) => {
  const r = charge_adjustments.value.find((x) => x.id === id)
  return r ? exerciceCourt(r.start, r.end) : ''
}

// Fields computed here, shown and filtered under their column. Whether the tenant still lives there: its stay has no
// move-out date, or one still to come
const STAY_STATUSES = { current: 'en cours', ended: 'terminé' }
type StayStatus = keyof typeof STAY_STATUSES
const stayStatus = (p: Paiement): StayStatus => {
  const out = stays.value.find((s) => s.id === p.tenancy_id)?.move_out
  return !out || out >= today ? 'current' : 'ended'
}

// Seen on a bank statement or not (ADR 0018); a retention on the deposit is never at the bank: neither
const BANK_STATUSES = { reconciled: 'rapproché', not_reconciled: 'non rapproché' }
type BankStatus = keyof typeof BANK_STATUSES
const bankStatus = (p: Paiement): BankStatus | null =>
  (estRetenue(p) ? null : p.bank_transaction_id ? 'reconciled' : 'not_reconciled')

// Latest first
const rows = computed(() => [...payments.value]
  .sort((x, y) => y.payment_date.localeCompare(x.payment_date) || y.id - x.id)
  .map((p) => ({ ...p, amount: total(p), stay_status: stayStatus(p), bank_status: bankStatus(p) })))
type Row = (typeof rows.value)[number]

// No filter by default, the list in pages; dates as the API gives them (2026-03-17)
const defaultFilters = (): Filters => ({
  payment_date: contains(), tenant: equals(), stay_status: equals(), month: contains(), amount: contains(),
  bank_status: equals(), rent: contains(), charge_advance: contains(), charge_adjustment: contains(), method: equals(),
  note: contains(),
})
const filters = ref<Filters>(defaultFilters())
const table = ref<FilteredTable<Row>>(null)
const shown = computed(() => table.value?.processedData ?? [])

// Totals of the payments shown, every page
const totals = computed(() => {
  const sum = (field: (p: Paiement) => string) => shown.value.reduce((t, p) => t.plus(field(p)), new Big(0)).toFixed(2)
  return { amount: sum(total), rent: sum((p) => p.rent), charge_advance: sum((p) => p.charge_advance),
    charge_adjustment: sum((p) => p.charge_adjustment) }
})

// ---------------------------------------------------------------- entry and editing

const blank = (date = today, method: Brouillon['method'] = 'transfer'): Brouillon => ({
  id: null, date, tenancy_id: null, month: date.slice(0, 7), amount: '', rent: '', charge_advance: '',
  versements: [], method, note: '',
})

// Payment open in the modal form (new or edited), and the error the API gave for it
const form = ref<Brouillon | null>(null)
const formError = ref<string | null>(null)
// Bank movement of the payment edited: the payments added by its split (another regularisation) are linked to it too
const paymentMovement = ref<number | null>(null)

function open(b: Brouillon, movement: number | null = null) {
  form.value = b
  paymentMovement.value = movement
  formError.value = null
}

const router = useRouter()

function edit(p: Paiement) {
  if (estRetenue(p)) {
    router.push({ path: '/sejours', query: { depot: 'voir', tenancy: p.tenancy_id } })
    return
  }
  open({
    id: p.id, date: p.payment_date, tenancy_id: p.tenancy_id, month: p.month?.slice(0, 7) ?? '',
    amount: nombreFr(total(p)), rent: nombreFr(p.rent), charge_advance: nombreFr(p.charge_advance),
    versements: p.charge_adjustment_id ? [{ charge_adjustment_id: p.charge_adjustment_id, amount: nombreFr(p.charge_adjustment) }] : [],
    method: p.method ?? '', note: p.note ?? '',
  }, p.bank_transaction_id)
}

async function save(next: boolean) {
  const b = form.value!
  busy.value = true
  try {
    await enregistrerBrouillon(b, paymentMovement.value)
    // « Ajouter et en saisir un autre » keeps the date and the mode: several payments of one bank statement
    form.value = next ? blank(b.date, b.method) : null
    formError.value = null
    message.value = { text: 'Paiement enregistré', type: 'info' }
    await load()
  } catch (e) {
    formError.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

async function remove(id: number) {
  if (!confirm('Supprimer ce paiement ?')) {
    return
  }
  try {
    await api.supprimerPaiement(id)
    form.value = null
    message.value = { text: 'Paiement supprimé', type: 'info' }
    await load()
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
  }
}
</script>

<template>
  <section class="entete-page">
    <h1>Paiements</h1>
    <button type="button" class="principal" @click="open(blank())">+ Ajouter un paiement</button>
  </section>
  <p class="discret">
    Une ligne par paiement reçu (virement, chèque…) : le montant du relevé, réparti entre loyer, provision et
    régularisation. Cliquer une ligne pour la modifier ; les mois sans paiement se contrôlent dans
    <RouterLink to="/controles">Contrôles</RouterLink>. Pour les années sans paiements saisis, voir les
    <RouterLink to="/provisions">totaux annuels (historique)</RouterLink>.
  </p>
  <p v-if="message" class="message" :class="message.type">{{ message.text }}</p>

  <section class="filtres">
    <span class="discret">{{ shown.length }} paiement(s) affiché(s) sur {{ rows.length }}</span>
    <button type="button" class="lien" @click="filters = defaultFilters()">Effacer les filtres</button>
  </section>

  <!-- Short columns at a fixed width; the tenant and the note take the rest -->
  <DataTable
    ref="table" v-model:filters="filters" :value="rows" data-key="id" filter-display="row" size="small"
    paginator :rows="25" :rows-per-page-options="[25, 50, 100, 500]"
    state-storage="session" :state-key="stateKey('payments')" class="clickable" @row-click="edit($event.data)"
    @state-restore="filters = withDefaults(defaultFilters(), $event.filters)"
  >
    <template #empty>Aucun paiement.</template>
    <Column field="payment_date" header="Date" sortable :show-filter-menu="false" footer="Total" style="width: 7.5rem">
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
    </Column>
    <Column field="tenant" header="Locataire" sortable :show-filter-menu="false">
      <template #body="{ data }">{{ data.unit }} – {{ data.tenant }}</template>
      <template #filter="{ filterModel, filterCallback }">
        <ColumnFilter :model="filterModel" :apply="filterCallback" :options="distinctOptions(rows.map((p) => p.tenant))" />
      </template>
    </Column>
    <Column field="stay_status" header="Séjour" :show-filter-menu="false" style="width: 7.5rem">
      <template #body="{ data }">
        <span :class="data.stay_status === 'current' ? 'ok' : 'discret'">{{ STAY_STATUSES[data.stay_status as StayStatus] }}</span>
      </template>
      <template #filter="{ filterModel, filterCallback }">
        <ColumnFilter :model="filterModel" :apply="filterCallback" :options="optionsOf(STAY_STATUSES)" />
      </template>
    </Column>
    <!-- The month of rent covered, its first day -->
    <Column field="month" header="Mois couvert" sortable :show-filter-menu="false" style="width: 7.5rem">
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
    </Column>
    <Column field="amount" header="Montant reçu" body-class="nombre" header-class="nombre" footer-class="nombre" :show-filter-menu="false" style="width: 7.5rem">
      <template #body="{ data }"><strong>{{ data.amount }}</strong></template>
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
      <template #footer><strong>{{ totals.amount }}</strong></template>
    </Column>
    <Column field="bank_status" header="Banque" :show-filter-menu="false" style="width: 8rem">
      <template #body="{ data }">
        <span @click.stop>
          <RouterLink v-if="data.bank_status === 'reconciled'" :to="{ name: 'bank', query: { bank_transaction: data.bank_transaction_id } }" class="ok"
            title="Vu sur un relevé de la banque : ouvrir le mouvement">✓</RouterLink>
          <span v-else-if="data.bank_status === 'not_reconciled'" class="ko" title="Pas encore vu sur un relevé de la banque">✗</span>
          <span v-else class="oi oi-lock discret" title="Retenue sur le dépôt de garantie : à modifier depuis le dépôt du séjour (Locataires)" />
        </span>
      </template>
      <template #filter="{ filterModel, filterCallback }">
        <ColumnFilter :model="filterModel" :apply="filterCallback" :options="optionsOf(BANK_STATUSES)" />
      </template>
    </Column>
    <Column field="rent" header="Loyer" body-class="nombre" header-class="nombre" footer-class="nombre" :show-filter-menu="false" style="width: 7rem">
      <template #body="{ data }">{{ data.month ? data.rent : '' }}</template>
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
      <template #footer>{{ totals.rent }}</template>
    </Column>
    <Column field="charge_advance" header="Provision" body-class="nombre" header-class="nombre" footer-class="nombre" :show-filter-menu="false" style="width: 7rem">
      <template #body="{ data }">{{ data.month ? data.charge_advance : '' }}</template>
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
      <template #footer>{{ totals.charge_advance }}</template>
    </Column>
    <Column field="charge_adjustment" header="Régularisation" :show-filter-menu="false" style="width: 9rem">
      <template #body="{ data }">
        <template v-if="data.charge_adjustment_id">
          {{ data.charge_adjustment }} <span class="discret">({{ exercise(data.charge_adjustment_id) }})</span>
        </template>
      </template>
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
      <template #footer>{{ totals.charge_adjustment }}</template>
    </Column>
    <Column field="method" header="Mode" :show-filter-menu="false" style="width: 9rem">
      <template #body="{ data }">{{ data.method ? NOMS_MODES[data.method as keyof typeof NOMS_MODES] : '' }}</template>
      <template #filter="{ filterModel, filterCallback }">
        <ColumnFilter :model="filterModel" :apply="filterCallback" :options="optionsOf(NOMS_MODES)" />
      </template>
    </Column>
    <Column field="note" header="Note" body-class="discret" :show-filter-menu="false">
      <template #body="{ data }"><span class="note" :title="data.note ?? ''">{{ data.note }}</span></template>
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
    </Column>
  </DataTable>

  <FormulairePaiement
    v-if="form && building !== null"
    :key="form.id ?? 'nouveau'"
    v-model="form"
    :building="building"
    :tenancies="stays"
    :charge_adjustments="charge_adjustments"
    :rent_schedules="instalments"
    :payments="payments"
    :occupe="busy"
    :erreur="formError"
    @enregistrer="save"
    @fermer="form = null"
    @supprimer="remove(form.id!)"
  />
</template>

<style scoped>
.note {
  display: inline-block;
  max-width: 14rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}
</style>

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
const message = ref<{ texte: string, type: 'info' | 'erreur' } | null>(null)
const busy = ref(false)
const today = new Date().toISOString().slice(0, 10)

const payments = ref<Paiement[]>([])
const stays = ref<Sejour[]>([])
const regularisations = ref<Regularisation[]>([])
const instalments = ref<Echeance[]>([])

async function load() {
  if (building.value === null) {
    return
  }
  try {
    ;[payments.value, stays.value, regularisations.value, instalments.value] = await Promise.all([
      api.paiements(building.value, null), api.sejours(building.value), api.regularisations(building.value),
      api.echeances(building.value),
    ])
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}

onMounted(async () => {
  await ready
  await load()
})
watch(building, load)

// ---------------------------------------------------------------- list

const total = (p: Paiement) => new Big(p.loyer).plus(p.provision).plus(p.regularisation).toFixed(2)
const exercise = (id: number | null) => {
  const r = regularisations.value.find((x) => x.id === id)
  return r ? exerciceCourt(r.debut, r.fin) : ''
}

// Fields computed here, shown and filtered under their column. Whether the tenant still lives there: its stay has no
// move-out date, or one still to come
const STAY_STATUSES = { current: 'en cours', ended: 'terminé' }
type StayStatus = keyof typeof STAY_STATUSES
const stayStatus = (p: Paiement): StayStatus => {
  const out = stays.value.find((s) => s.id === p.sejour_id)?.sortie
  return !out || out >= today ? 'current' : 'ended'
}

// Seen on a bank statement or not (ADR 0018); a retention on the deposit is never at the bank: neither
const BANK_STATUSES = { reconciled: 'rapproché', not_reconciled: 'non rapproché' }
type BankStatus = keyof typeof BANK_STATUSES
const bankStatus = (p: Paiement): BankStatus | null =>
  (estRetenue(p) ? null : p.mouvement_id ? 'reconciled' : 'not_reconciled')

// Latest first
const rows = computed(() => [...payments.value]
  .sort((x, y) => y.date_paiement.localeCompare(x.date_paiement) || y.id - x.id)
  .map((p) => ({ ...p, amount: total(p), stay_status: stayStatus(p), bank_status: bankStatus(p) })))
type Row = (typeof rows.value)[number]

// No filter by default, the list in pages; dates as the API gives them (2026-03-17)
const defaultFilters = (): Filters => ({
  date_paiement: contains(), locataire: equals(), stay_status: equals(), mois: contains(), amount: contains(),
  bank_status: equals(), loyer: contains(), provision: contains(), regularisation: contains(), mode: equals(),
  note: contains(),
})
const filters = ref<Filters>(defaultFilters())
const table = ref<FilteredTable<Row>>(null)
const shown = computed(() => table.value?.processedData ?? [])

// Totals of the payments shown, every page
const totals = computed(() => {
  const sum = (field: (p: Paiement) => string) => shown.value.reduce((t, p) => t.plus(field(p)), new Big(0)).toFixed(2)
  return { amount: sum(total), rent: sum((p) => p.loyer), provision: sum((p) => p.provision),
    regularisation: sum((p) => p.regularisation) }
})

// ---------------------------------------------------------------- entry and editing

const blank = (date = today, mode: Brouillon['mode'] = 'virement'): Brouillon => ({
  id: null, date, sejour_id: null, mois: date.slice(0, 7), montant: '', loyer: '', provision: '',
  versements: [], mode, note: '',
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
    router.push({ path: '/sejours', query: { depot: 'voir', sejour: p.sejour_id } })
    return
  }
  open({
    id: p.id, date: p.date_paiement, sejour_id: p.sejour_id, mois: p.mois?.slice(0, 7) ?? '',
    montant: nombreFr(total(p)), loyer: nombreFr(p.loyer), provision: nombreFr(p.provision),
    versements: p.regularisation_id ? [{ regularisation_id: p.regularisation_id, montant: nombreFr(p.regularisation) }] : [],
    mode: p.mode ?? '', note: p.note ?? '',
  }, p.mouvement_id)
}

async function save(next: boolean) {
  const b = form.value!
  busy.value = true
  try {
    await enregistrerBrouillon(b, paymentMovement.value)
    // « Ajouter et en saisir un autre » keeps the date and the mode: several payments of one bank statement
    form.value = next ? blank(b.date, b.mode) : null
    formError.value = null
    message.value = { texte: 'Paiement enregistré', type: 'info' }
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
    message.value = { texte: 'Paiement supprimé', type: 'info' }
    await load()
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
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
  <p v-if="message" class="message" :class="message.type">{{ message.texte }}</p>

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
    <Column field="date_paiement" header="Date" sortable :show-filter-menu="false" footer="Total" style="width: 7.5rem">
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
    </Column>
    <Column field="locataire" header="Locataire" sortable :show-filter-menu="false">
      <template #body="{ data }">{{ data.lot }} – {{ data.locataire }}</template>
      <template #filter="{ filterModel, filterCallback }">
        <ColumnFilter :model="filterModel" :apply="filterCallback" :options="distinctOptions(rows.map((p) => p.locataire))" />
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
    <Column field="mois" header="Mois couvert" sortable :show-filter-menu="false" style="width: 7.5rem">
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
          <RouterLink v-if="data.bank_status === 'reconciled'" :to="{ name: 'banque', query: { mouvement: data.mouvement_id } }" class="ok"
            title="Vu sur un relevé de la banque : ouvrir le mouvement">✓</RouterLink>
          <span v-else-if="data.bank_status === 'not_reconciled'" class="ko" title="Pas encore vu sur un relevé de la banque">✗</span>
          <span v-else class="oi oi-lock discret" title="Retenue sur le dépôt de garantie : à modifier depuis le dépôt du séjour (Locataires)" />
        </span>
      </template>
      <template #filter="{ filterModel, filterCallback }">
        <ColumnFilter :model="filterModel" :apply="filterCallback" :options="optionsOf(BANK_STATUSES)" />
      </template>
    </Column>
    <Column field="loyer" header="Loyer" body-class="nombre" header-class="nombre" footer-class="nombre" :show-filter-menu="false" style="width: 7rem">
      <template #body="{ data }">{{ data.mois ? data.loyer : '' }}</template>
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
      <template #footer>{{ totals.rent }}</template>
    </Column>
    <Column field="provision" header="Provision" body-class="nombre" header-class="nombre" footer-class="nombre" :show-filter-menu="false" style="width: 7rem">
      <template #body="{ data }">{{ data.mois ? data.provision : '' }}</template>
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
      <template #footer>{{ totals.provision }}</template>
    </Column>
    <Column field="regularisation" header="Régularisation" :show-filter-menu="false" style="width: 9rem">
      <template #body="{ data }">
        <template v-if="data.regularisation_id">
          {{ data.regularisation }} <span class="discret">({{ exercise(data.regularisation_id) }})</span>
        </template>
      </template>
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
      <template #footer>{{ totals.regularisation }}</template>
    </Column>
    <Column field="mode" header="Mode" :show-filter-menu="false" style="width: 9rem">
      <template #body="{ data }">{{ data.mode ? NOMS_MODES[data.mode as keyof typeof NOMS_MODES] : '' }}</template>
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
    :immeuble="building"
    :sejours="stays"
    :regularisations="regularisations"
    :echeances="instalments"
    :paiements="payments"
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

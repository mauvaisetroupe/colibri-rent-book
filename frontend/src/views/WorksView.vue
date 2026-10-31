<script setup lang="ts">
import Big from 'big.js'
import Column from 'openvue/column'
import DataTable from 'openvue/datatable'
import { computed, onMounted, ref, watch } from 'vue'

import { api, NATURES_TRAVAUX, type Immeuble, type Lot, type Travaux } from '../api'
import ColumnFilter from '../components/ColumnFilter.vue'
import FormulaireTravaux, { type BrouillonTravaux, travauxVersApi } from '../components/FormulaireTravaux.vue'
import { euros, nombreFr } from '../format'
import { useImmeuble } from '../immeuble'
import { contains, distinctOptions, equals, optionsOf, stateKey, withDefaults, type Filters, type FilteredTable } from '../lists'

// Works paid by the owner (ADR 0015): for the tax return only, never allocated to the tenants. Deductible (2044,
// line 224) according to their nature. The invoice is typed first, with its PDF; it is paid by bank movements only (ADR
// 0019), linked from the invoice or from « Catégorisation », each in the tax year of its movement. The list: a filter
// under each column, kept for the session.

const { immeubleId: building, pret: ready } = useImmeuble()
const works = ref<Travaux[]>([])
const currentBuilding = ref<Immeuble | null>(null)
const units = ref<Lot[]>([])
const form = ref<BrouillonTravaux | null>(null)
const formError = ref<string | null>(null)
const busy = ref(false)
const message = ref<{ text: string, type: 'info' | 'erreur' } | null>(null)

onMounted(async () => {
  await ready
  await load()
})
watch(building, load)

async function load() {
  if (building.value === null) {
    return
  }
  try {
    const [w, b] = await Promise.all([api.works_invoice(building.value), api.building(building.value)])
    works.value = w
    currentBuilding.value = { ...b, unit_count: b.units.length }
    units.value = b.units
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
  }
}

// ---------------------------------------------------------------- list

// The only field computed here: the dates of its payments (« 2025-12-05 », « 2027-02-15, 2028-01-10 » for an invoice
// paid in several times), shown and filtered under « Payée le »; empty while it is to pay
const rows = computed(() => works.value.map((w) => ({ ...w, paid_on: w.payments.map((r) => r.payment_date).join(', ') })))
type Row = (typeof rows.value)[number]

const defaultFilters = (): Filters => ({
  paid_on: contains(), invoice_date: contains(), supplier: equals(), description: contains(), unit: equals(),
  nature: equals(), total_incl_tax: contains(), remaining: contains(),
})
const filters = ref<Filters>(defaultFilters())
const table = ref<FilteredTable<Row>>(null)
const shown = computed(() => table.value?.processedData ?? [])

const total = (list: Travaux[]) => list.reduce((s, w) => s.plus(w.total_incl_tax), new Big(0)).toFixed(2)
// Text typed under « Payée le » (« 2025 »): the deductible payments counted are those whose date contains it
const paidOn = computed(() => ((filters.value.paid_on as { value: string | null } | undefined)?.value ?? '').trim())
const deductible = computed(() => shown.value.filter((w) => w.deductible).flatMap((w) => w.payments)
  .filter((r) => r.payment_date.includes(paidOn.value))
  .reduce((s, r) => s.plus(r.amount), new Big(0)).toFixed(2))

const lotsByBuilding = computed(() => new Map(building.value === null ? [] : [[building.value, units.value]]))

// ---------------------------------------------------------------- entry and editing

function add() {
  form.value = {
    id: null, building_id: building.value, unit_id: null, supplier: '', description: '', nature: 'maintenance',
    invoice_date: '', total_incl_tax: '', note: '', pdf: null,
  }
  formError.value = null
}

function edit(w: Travaux) {
  form.value = {
    id: w.id, building_id: w.building_id, unit_id: w.unit_id, supplier: w.supplier, description: w.description,
    nature: w.nature, invoice_date: w.invoice_date, total_incl_tax: nombreFr(w.total_incl_tax), note: w.note ?? '', pdf: null,
  }
  formError.value = null
}

// The invoice as recorded: its payments and its PDF, shown in the form
const recorded = computed(() => works.value.find((w) => w.id === form.value?.id) ?? null)

// Saved, then its PDF; a new invoice stays open to link its transfers (or a blank one follows: « en saisir une autre »)
async function save(next: boolean) {
  const b = form.value
  if (!b) {
    return
  }
  busy.value = true
  try {
    const data = travauxVersApi(b)
    let w = b.id === null ? await api.creerTravaux(data) : await api.modifierTravaux(b.id, data)
    if (b.pdf) {
      w = await api.joindrePdfTravaux(w.id, b.pdf)
    }
    message.value = { text: `${w.description} : enregistrée`, type: 'info' }
    await load()
    if (next) {
      add()
    } else if (b.id === null) {
      edit(w)
    } else {
      form.value = null
    }
  } catch (e) {
    formError.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

async function remove(w: Travaux | undefined) {
  if (!w || !confirm(`Supprimer « ${w.description} » (${euros(w.total_incl_tax)}) et ses règlements ?`)) {
    return
  }
  await api.supprimerTravaux(w.id)
  form.value = null
  await load()
}

async function attach(w: Travaux, event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) {
    return
  }
  try {
    await api.joindrePdfTravaux(w.id, file)
    message.value = { text: `PDF joint à « ${w.description} »`, type: 'info' }
    await load()
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
  }
}
</script>

<template>
  <section class="entete-page">
    <h1>Travaux</h1>
  </section>
  <p class="discret">
    Les factures de travaux payées par le propriétaire, pour la déclaration des revenus fonciers : jamais réparties entre
    les locataires. Entretien, réparation et amélioration sont déductibles (2044, ligne 224) ; construction et
    agrandissement non. Une facture est payée par les virements de la banque qu'on lui rattache (ouvrir la facture, ou
    « Catégorisation des mouvements ») ; chacun compte dans l'année du virement : une facture payée en deux fois
    (acompte, solde) peut se partager entre deux déclarations.
  </p>

  <p v-if="message" class="message" :class="message.type">{{ message.text }}</p>

  <div class="actions-page">
    <button type="button" @click="add">+ Ajouter une facture de travaux</button>
  </div>

  <FormulaireTravaux
    v-if="form && currentBuilding"
    v-model="form"
    :buildings="[currentBuilding]"
    :units="lotsByBuilding"
    :occupe="busy"
    :erreur="formError"
    :works_invoice="recorded"
    @change="load"
    @enregistrer="save"
    @fermer="form = null"
    @supprimer="remove(works.find((w) => w.id === form?.id))"
  />

  <section class="filtres">
    <span class="discret">
      {{ shown.length }} facture(s) affichée(s) sur {{ works.length }}, {{ total(shown) }} ;
      payé{{ paidOn ? ` (« ${paidOn} »)` : '' }} et déductible : <strong>{{ deductible }}</strong>
    </span>
    <button type="button" class="lien" @click="filters = defaultFilters()">Effacer les filtres</button>
  </section>

  <!-- Short columns at a fixed width; the supplier and the description take the rest -->
  <DataTable
    ref="table" v-model:filters="filters" :value="rows" data-key="id" filter-display="row" size="small"
    sort-field="invoice_date" :sort-order="-1" state-storage="session" :state-key="stateKey('works')" class="clickable"
    @row-click="edit($event.data)" @state-restore="filters = withDefaults(defaultFilters(), $event.filters)"
  >
    <template #empty>Aucune facture de travaux.</template>
    <Column field="paid_on" header="Payée le" :show-filter-menu="false" style="width: 9rem">
      <template #body="{ data }"><span :class="{ discret: !data.paid_on }">{{ data.paid_on || 'à payer' }}</span></template>
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
    </Column>
    <Column field="invoice_date" header="Facture du" sortable :show-filter-menu="false" style="width: 7.5rem">
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
    </Column>
    <Column field="supplier" header="Fournisseur" sortable :show-filter-menu="false">
      <template #filter="{ filterModel, filterCallback }">
        <ColumnFilter :model="filterModel" :apply="filterCallback" :options="distinctOptions(works.map((w) => w.supplier))" />
      </template>
    </Column>
    <Column field="description" header="Description" :show-filter-menu="false">
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
    </Column>
    <Column field="unit" header="Logement" :show-filter-menu="false" style="width: 8rem">
      <template #filter="{ filterModel, filterCallback }">
        <ColumnFilter :model="filterModel" :apply="filterCallback" :options="distinctOptions(works.map((w) => w.unit))" />
      </template>
    </Column>
    <Column field="nature" header="Nature" :show-filter-menu="false" style="width: 11rem">
      <template #body="{ data }">
        <span :class="data.deductible ? '' : 'discret'">
          {{ NATURES_TRAVAUX[data.nature as keyof typeof NATURES_TRAVAUX] }}{{ data.deductible ? '' : ' (non déductible)' }}
        </span>
      </template>
      <template #filter="{ filterModel, filterCallback }">
        <ColumnFilter :model="filterModel" :apply="filterCallback" :options="optionsOf(NATURES_TRAVAUX)" />
      </template>
    </Column>
    <Column field="total_incl_tax" header="Montant TTC" sortable body-class="nombre" header-class="nombre" :show-filter-menu="false" style="width: 8rem">
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
    </Column>
    <Column field="remaining" header="Reste à payer" body-class="nombre" header-class="nombre" :show-filter-menu="false" style="width: 8rem">
      <template #body="{ data }"><span :class="Number(data.remaining) > 0 ? 'ko' : 'discret'">{{ data.remaining }}</span></template>
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
    </Column>
    <Column header="PDF" style="width: 9rem">
      <template #body="{ data }">
        <span @click.stop>
          <a v-if="data.pdf" :href="api.travauxPdfUrl(data.id)" target="_blank">ouvrir</a>
          <label class="lien">{{ data.pdf ? 'remplacer' : 'joindre' }}
            <input type="file" accept="application/pdf" hidden @change="attach(data, $event)">
          </label>
        </span>
      </template>
    </Column>
    <Column style="width: 7rem">
      <template #body="{ data }"><button type="button" class="danger" @click.stop="remove(data)">Supprimer</button></template>
    </Column>
  </DataTable>
</template>

<style scoped>
.lien {
  color: var(--accent);
  cursor: pointer;
  margin-left: 0.4rem;
}
</style>

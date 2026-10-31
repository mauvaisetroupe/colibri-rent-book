<script setup lang="ts">
import Big from 'big.js'
import Column from 'openvue/column'
import DataTable from 'openvue/datatable'
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'

import { api, libelleRegularisation, type Decompte, type Regularisation } from '../api'
import ColumnFilter from '../components/ColumnFilter.vue'
import { euros } from '../format'
import { useImmeuble } from '../immeuble'
import { contains, distinctOptions, equals, optionsOf, stateKey, withDefaults, type Filters, type FilteredTable } from '../lists'
import { comparer, decomptesDesPeriodes, SEUIL_RECTIFICATION } from '../rectification'

// All the regularisations of the building, whatever their period (a year, 2024-2025, a stay that ended…): one row
// each, a corrective one in place of the one it replaces (the replaced one stays in the history of its record), and
// whether it still matches the statement of its period recomputed today (« à rectifier »). The list: a filter under
// each column, kept for the session.

const router = useRouter()
const { immeubleId: building, pret: ready } = useImmeuble()
const charge_adjustments = ref<Regularisation[]>([])
const error = ref<string | null>(null)
const statements = ref(new Map<string, Decompte>())

async function load() {
  if (building.value === null) {
    return
  }
  try {
    charge_adjustments.value = await api.charge_adjustments(building.value)
    error.value = null
    statements.value = await decomptesDesPeriodes(building.value, current.value)
  } catch (e) {
    error.value = (e as Error).message
  }
}

onMounted(async () => {
  await ready
  await load()
})
watch(building, load)

// Not replaced by a corrective one
const current = computed(() => charge_adjustments.value.filter((r) => !r.replaced_by))
const comparisons = computed(() => new Map(current.value.map((r) => [r.id, comparer(r, statements.value)])))

// Fields computed here, shown and filtered under their column: what is left to pay, the state shown, the gap with
// the statement recomputed today
const GAPS = { juste: '✓ juste', arrondi: 'écart faible', a_rectifier: 'à rectifier', a_recreer: 'à recréer' }
type Gap = keyof typeof GAPS
const remaining = (r: Regularisation) => new Big(r.balance).minus(r.amount_received).toFixed(2)

// Latest first
const rows = computed(() => [...current.value]
  .sort((a, b) => b.end.localeCompare(a.end) || b.start.localeCompare(a.start) || a.unit.localeCompare(b.unit))
  .map((r) => ({
    ...r, remaining: r.state === 'draft' ? null : remaining(r), state: libelleRegularisation(r),
    gap: comparisons.value.get(r.id)?.state ?? null,
  })))
type Row = (typeof rows.value)[number]

const defaultFilters = (): Filters => ({
  start: contains(), end: contains(), unit: equals(), tenant: equals(), balance: contains(), amount_received: contains(),
  remaining: contains(), state: equals(), gap: equals(),
})
const filters = ref<Filters>(defaultFilters())
const table = ref<FilteredTable<Row>>(null)
const shown = computed(() => table.value?.processedData ?? [])

const badge = (r: Regularisation) => (r.state === 'draft' ? 'draft' : r.decision ? 'decision' : r.state)
</script>

<template>
  <section class="entete-page">
    <h1>Régularisations</h1>
    <RouterLink class="bouton principal" :to="{ name: 'nouvelle-regularisation' }">+ Nouvelle régularisation</RouterLink>
  </section>
  <p class="discret">
    Une régularisation porte sur la période choisie à sa création (une année, deux années, un séjour…). Cliquer une ligne
    pour l'ouvrir : état, versements reçus, mail, justificatif, rectificatif. Les versements se saisissent dans
    <RouterLink to="/paiements">Paiements</RouterLink>.
  </p>
  <p v-if="error" class="message erreur">{{ error }}</p>

  <section class="filtres">
    <span class="discret">{{ shown.length }} régularisation(s) affichée(s) sur {{ rows.length }}</span>
    <button type="button" class="lien" @click="filters = defaultFilters()">Effacer les filtres</button>
  </section>

  <!-- Short columns at a fixed width; the tenant and the state take the rest -->
  <DataTable
    ref="table" v-model:filters="filters" :value="rows" data-key="id" filter-display="row" size="small"
    state-storage="session" :state-key="stateKey('charge_adjustments')" class="clickable"
    @row-click="router.push({ name: 'charge_adjustment', params: { id: $event.data.id } })"
    @state-restore="filters = withDefaults(defaultFilters(), $event.filters)"
  >
    <template #empty>Aucune régularisation.</template>
    <!-- The period regularised: its first day and its last one -->
    <Column field="start" header="Début" sortable :show-filter-menu="false" style="width: 7.5rem">
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
    </Column>
    <Column field="end" header="Fin" sortable :show-filter-menu="false" style="width: 7.5rem">
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
    </Column>
    <Column field="unit" header="Lot" sortable :show-filter-menu="false" style="width: 7rem">
      <template #filter="{ filterModel, filterCallback }">
        <ColumnFilter :model="filterModel" :apply="filterCallback" :options="distinctOptions(rows.map((r) => r.unit))" />
      </template>
    </Column>
    <Column field="tenant" header="Locataire" sortable :show-filter-menu="false">
      <template #body="{ data }">
        {{ data.tenant }}
        <span v-if="data.replaces_id" class="discret"> · rectificatif</span>
      </template>
      <template #filter="{ filterModel, filterCallback }">
        <ColumnFilter :model="filterModel" :apply="filterCallback" :options="distinctOptions(rows.map((r) => r.tenant))" />
      </template>
    </Column>
    <Column field="balance" header="Solde" body-class="nombre" header-class="nombre" :show-filter-menu="false" style="width: 7.5rem">
      <template #body="{ data }"><strong>{{ data.balance }}</strong></template>
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
    </Column>
    <Column field="amount_received" header="Reçu" body-class="nombre" header-class="nombre" :show-filter-menu="false" style="width: 7.5rem">
      <template #body="{ data }">{{ data.state === 'draft' ? '' : data.amount_received }}</template>
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
    </Column>
    <Column field="remaining" header="Reste" body-class="nombre" header-class="nombre" :show-filter-menu="false" style="width: 7.5rem">
      <template #body="{ data }"><strong :class="{ ok: data.state === 'settled' }">{{ data.remaining }}</strong></template>
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
    </Column>
    <Column field="state" header="Statut" :show-filter-menu="false">
      <template #body="{ data }">
        <span class="pastille" :class="badge(data)">{{ data.state }}</span>
        <span v-if="data.sent_on" class="discret"> envoyée le {{ data.sent_on }}</span>
      </template>
      <template #filter="{ filterModel, filterCallback }">
        <ColumnFilter :model="filterModel" :apply="filterCallback" :options="distinctOptions(rows.map((r) => r.state))" />
      </template>
    </Column>
    <Column field="gap" header="Écart avec le décompte" :show-filter-menu="false" style="width: 12rem">
      <template #body="{ data }">
        <template v-if="data.gap">
          <span v-if="data.gap === 'juste'" class="ok" title="Le décompte actuel donne le même solde">✓</span>
          <span v-else-if="data.gap === 'arrondi'" class="discret" title="Écart faible, sans rectificatif">
            {{ comparisons.get(data.id)!.ecart }}
          </span>
          <span v-else class="a-rectifier" :title="`Décompte actuel : ${comparisons.get(data.id)!.actuel.balance}`">
            {{ GAPS[data.gap as Gap] }} {{ comparisons.get(data.id)!.ecart }}
          </span>
        </template>
      </template>
      <template #filter="{ filterModel, filterCallback }">
        <ColumnFilter :model="filterModel" :apply="filterCallback" :options="optionsOf(GAPS)" />
      </template>
    </Column>
  </DataTable>
  <p v-if="rows.length" class="discret">
    Solde = charges − provisions de la période, figé à la création : <span class="ko">positif, à payer par le
    locataire</span> ; <span class="ok">négatif, à lui rembourser</span>. Reste = solde − versements reçus (saisis dans
    Paiements). Écart avec le décompte = solde du décompte refait aujourd'hui − solde figé :
    <strong>négatif, trop demandé</strong> ; <strong>positif, pas assez demandé</strong> ; « À rectifier » à partir de
    {{ euros(SEUIL_RECTIFICATION.toString()) }}. Cliquer une ligne pour ouvrir la régularisation.
  </p>
</template>

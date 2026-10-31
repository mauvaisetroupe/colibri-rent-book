<script setup lang="ts">
import Column from 'openvue/column'
import DataTable from 'openvue/datatable'
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'

import { api, ApiError, ENERGIES, STATUTS, type Energie, type EtatAnnexe, type ExtracteurEnregistre, type FactureResumee } from '../api'
import ColumnFilter from '../components/ColumnFilter.vue'
import type { Candidat } from '../extraction/navigateur'
import { nombreApi } from '../format'
import { useImmeuble } from '../immeuble'
import { anyOf, contains, distinctOptions, equals, optionsOf, stateKey, withDefaults, type Filters, type FilteredTable } from '../lists'

// The invoices of the building: PDFs dropped are read in the browser and imported as drafts (ADR 0013), an invoice
// without PDF is typed by hand; the list, a filter under each column on the fields of the API, kept for the session.

type ImportStatus = 'reading' | 'imported' | 'duplicate' | 'error'
// The classes of the shared stylesheet (« resultats »)
const IMPORT_CLASSES: Record<ImportStatus, string> = { reading: 'en_cours', imported: 'importee', duplicate: 'doublon', error: 'erreur' }

type ImportResult = {
  file: string
  status: ImportStatus
  message: string
  id?: number
  // PDF not read automatically: kept to be attached to the invoice typed by hand
  toType?: File
  // Several extractors recognise the PDF: the user chooses (ADR 0013)
  choice?: { file: File, candidates: Candidat[] }
}

type ManualInvoice = {
  supplier: string, energy: Energie, number: string, invoice_date: string, total_incl_tax: string, note: string
  file: File | null
}

const router = useRouter()
const { buildings: buildings, immeubleId: building, pret: ready } = useImmeuble()
// The building an invoice goes to: the one chosen in the menu, shown again where invoices are dropped or typed
const buildingName = (id: number | null) => buildings.value.find((b) => b.id === id)?.name ?? ''
const invoices = ref<FactureResumee[]>([])
const error = ref<string | null>(null)
const results = ref<ImportResult[]>([])
const dragOver = ref(false)
const manual = ref<ManualInvoice | null>(null)
const manualError = ref<string | null>(null)

onMounted(async () => {
  try {
    await ready
    await load()
  } catch (e) {
    error.value = (e as Error).message
  }
})

async function load() {
  if (building.value === null) {
    return
  }
  try {
    invoices.value = await api.invoices(building.value)
    error.value = null
  } catch (e) {
    error.value = (e as Error).message
  }
}

watch(building, load)

// ---------------------------------------------------------------- list

// Its tenant version (ADR 0024): to make or to check before it is joined to a supporting document
const MASKING: Record<EtatAnnexe, { label: string, cssClass: string, title: string }> = {
  checked: { label: '✓ validé', cssClass: 'ok', title: 'Version locataire contrôlée : jointe aux justificatifs' },
  to_check: { label: 'à contrôler', cssClass: 'ko', title: 'Version locataire à contrôler (onglet « Version locataire »)' },
  to_make: { label: 'à créer', cssClass: 'ko', title: 'Version locataire pas encore créée' },
  confidential: { label: 'confidentielle', cssClass: 'discret', title: 'Fournisseur confidentiel : jamais jointe' },
  no_pdf: { label: '—', cssClass: 'discret', title: 'Pas de PDF : rien à joindre' },
}

// Paid by bank movements (ADR 0022): the only field computed here, shown and filtered under « Payée »
const PAYMENT_STATUSES = { unpaid: 'à payer', partial: 'partielle', paid: 'payée' }
type PaymentStatus = keyof typeof PAYMENT_STATUSES
const PAYMENT_CLASSES: Record<PaymentStatus, string> = { unpaid: 'discret', partial: '', paid: 'ok' }

function paymentStatus(f: FactureResumee): PaymentStatus | null {
  // A replaced invoice, or a draft without a total: nothing to pay; a draft with one may already be paid
  if (f.status === 'replaced' || f.total_incl_tax === null || (f.status === 'draft' && Number(f.paid) === 0)) {
    return null
  }
  return Number(f.remaining) <= 0 ? 'paid' : Number(f.paid) > 0 ? 'partial' : 'unpaid'
}

/** The detail of its payment, as a tooltip: last payment, what is left, or paid too much. */
function paymentTitle(f: FactureResumee) {
  const last = f.payment_date ? `Dernier règlement le ${f.payment_date}` : 'Aucun mouvement bancaire rattaché'
  if (Number(f.remaining) < 0) {
    return `${last} ; payé ${f.paid}, écart ${f.remaining.replace('-', '')}`
  }
  return Number(f.remaining) > 0 && Number(f.paid) > 0 ? `${last} ; reste ${f.remaining}` : last
}

const rows = computed(() => invoices.value.map((f) => ({ ...f, payment_status: paymentStatus(f) })))
type Row = (typeof rows.value)[number]

// Filters on the fields of the API; replaced invoices (ADR 0017) stay in the database, hidden unless asked
const defaultFilters = (): Filters => ({
  invoice_date: contains(), supplier: equals(), number: contains(), energy: equals(), start: contains(), end: contains(),
  total_incl_tax: contains(), status: anyOf(['draft', 'validated']), payment_status: equals(), tenant_copy: equals(),
})
const filters = ref<Filters>(defaultFilters())
const table = ref<FilteredTable<Row>>(null)
const shown = computed(() => table.value?.processedData ?? [])

const drafts = computed(() => invoices.value.filter((f) => f.status === 'draft').length)

// ---------------------------------------------------------------- import of PDFs

async function importFiles(files: FileList | File[] | null) {
  if (!files || building.value === null) {
    return
  }
  let extractors: ExtracteurEnregistre[]
  let terms: string[]
  try {
    [extractors, terms] = await Promise.all([api.extractors(), api.termesMasques()])
  } catch (e) {
    error.value = (e as Error).message
    return
  }
  // One at a time, in the order given: results appear as they come; all into the building chosen when dropped
  const target = building.value
  for (const file of Array.from(files)) {
    const result: ImportResult = { file: file.name, status: 'reading', message: 'Lecture…' }
    results.value.unshift(result)
    await readAndImport(result, file, extractors, undefined, terms, target)
    results.value = [...results.value]
  }
  await load()
}

/**
 * The PDF is read in the browser by the last version of each supplier's extractor, then sent with its draft; its copy
 * joined to the supporting documents is made at once, to be verified on the invoice (ADR 0024).
 */
async function readAndImport(
  result: ImportResult, file: File, extractors: ExtracteurEnregistre[], chosen?: Candidat, terms?: string[],
  target: number = building.value!,
) {
  const fail = (message: string) => Object.assign(result, { status: 'error', message, toType: file, choice: undefined })
  // pdf.js is loaded with the first import only
  const { brouillonDe, candidats, lire, morceauxDuPdf, preparerAnnexe } = await import('../extraction/navigateur')
  let pages
  try {
    pages = await morceauxDuPdf(file)
  } catch {
    fail('PDF illisible (scan ou fichier abîmé) : saisir la facture à la main')
    return
  }
  const found = chosen ? [chosen] : candidats(pages, extractors)
  if (found.length === 0) {
    fail('Aucun extracteur ne reconnaît ce PDF : saisir la facture à la main, ou écrire un extracteur')
    return
  }
  if (found.length > 1) {
    Object.assign(result, {
      status: 'error', message: 'Plusieurs extracteurs reconnaissent ce PDF : choisir', choice: { file, candidates: found },
    })
    return
  }
  const candidate = found[0]!
  const { brouillon: draft, probleme: problem } = brouillonDe(lire(pages, candidate), candidate.enregistre.id)
  if (!draft) {
    fail(`${candidate.enregistre.supplier} v${candidate.enregistre.version} : ${problem}`)
    return
  }
  try {
    const { invoice: invoice, checks: checks } = await api.importer(target, file, draft)
    let copy = ''
    if (invoice.tenant_copy === 'to_make') {
      try {
        await preparerAnnexe(invoice, terms && extractors.length
          ? { terms: terms, extractors: extractors, modele: (await api.supplier(invoice.supplier_id)).masked_zones }
          : undefined)
        copy = ', version locataire à contrôler'
      } catch (e) {
        copy = `, version locataire non créée (${(e as Error).message})`
      }
    }
    Object.assign(result, {
      status: 'imported',
      id: invoice.id,
      choice: undefined,
      message: `${invoice.supplier} n° ${invoice.number} : brouillon créé dans ${buildingName(target)}`
        + (checks.can_validate ? '' : ' (contrôles en erreur)') + copy,
    })
  } catch (e) {
    const duplicate = e instanceof ApiError && e.status === 409
    Object.assign(result, {
      status: duplicate ? 'duplicate' : 'error',
      id: duplicate ? Number(e.body.invoice_id) : undefined,
      message: (e as Error).message,
      toType: e instanceof ApiError && e.body.code === 'manual_entry' ? file : undefined,
      choice: undefined,
    })
  }
}

async function chooseExtractor(result: ImportResult, candidate: Candidat) {
  if (!result.choice) {
    return
  }
  Object.assign(result, { status: 'reading', message: 'Lecture…' })
  await readAndImport(result, result.choice.file, [], candidate)
  results.value = [...results.value]
  await load()
}

function drop(event: DragEvent) {
  dragOver.value = false
  importFiles(event.dataTransfer?.files ?? null)
}

function pick(event: Event) {
  const input = event.target as HTMLInputElement
  importFiles(input.files).finally(() => { input.value = '' })
}

// ---------------------------------------------------------------- invoice typed by hand (no PDF, or not read)

const suppliers = computed(() => [...new Set(invoices.value.map((f) => f.supplier))].sort())

// A known supplier gives the energy of its other invoices
watch(() => manual.value?.supplier, (name) => {
  const known = invoices.value.find((f) => f.supplier === name)
  if (manual.value && known) {
    manual.value.energy = known.energy
  }
})

function newManual(file: File | null = null) {
  manual.value = { supplier: '', energy: 'water', number: '', invoice_date: '', total_incl_tax: '', note: '', file }
  manualError.value = null
}

async function create() {
  if (!manual.value || building.value === null) {
    return
  }
  const { file, total_incl_tax, note, ...header } = manual.value
  try {
    const { invoice: invoice } = await api.creerFacture(
      building.value,
      { ...header, total_incl_tax: nombreApi(total_incl_tax) ?? total_incl_tax, note: note.trim() || null },
      file,
    )
    await router.push({ name: 'invoice', params: { id: invoice.id } })
  } catch (e) {
    manualError.value = (e as Error).message
  }
}
</script>

<template>
  <section class="entete-page">
    <h1>Factures</h1>
  </section>

  <p v-if="error" class="message erreur">{{ error }}</p>

  <section
    class="depot"
    :class="{ survol: dragOver }"
    @dragover.prevent="dragOver = true"
    @dragleave="dragOver = false"
    @drop.prevent="drop"
  >
    <label class="immeuble-import">Importer dans
      <select v-model="building">
        <option v-for="b in buildings" :key="b.id" :value="b.id">{{ b.name }}</option>
      </select>
    </label>
    <p>Déposer des factures PDF ici, ou</p>
    <label class="bouton">
      Choisir des fichiers…
      <input type="file" accept="application/pdf" multiple hidden @change="pick">
    </label>
    <p class="discret">Les factures d'un fournisseur qui a un extracteur (EDF, ENGIE… voir <RouterLink :to="{ name: 'suppliers' }">Fournisseurs</RouterLink>) sont lues automatiquement, dans le navigateur. Chaque facture importée reste un brouillon jusqu'à sa validation.</p>
  </section>

  <ul v-if="results.length" class="resultats">
    <li v-for="(r, i) in results" :key="i" :class="IMPORT_CLASSES[r.status]">
      <strong>{{ r.file }}</strong> : {{ r.message }}
      <RouterLink v-if="r.id" :to="{ name: 'invoice', params: { id: r.id } }">ouvrir</RouterLink>
      <button v-if="r.toType" type="button" @click="newManual(r.toType)">Saisir à la main avec ce PDF</button>
      <template v-if="r.choice">
        <button v-for="c in r.choice.candidates" :key="c.enregistre.id" type="button" @click="chooseExtractor(r, c)">
          {{ c.enregistre.supplier }} (v{{ c.enregistre.version }})
        </button>
      </template>
    </li>
  </ul>

  <form v-if="manual" class="formulaire" @submit.prevent="create">
    <strong>Nouvelle facture {{ manual.file ? `(PDF joint : ${manual.file.name})` : 'sans PDF' }}</strong>
    <label>Immeuble
      <select v-model="building" required>
        <option v-for="b in buildings" :key="b.id" :value="b.id">{{ b.name }}</option>
      </select>
    </label>
    <label>Fournisseur <input v-model="manual.supplier" list="suppliers" size="16" required></label>
    <datalist id="suppliers">
      <option v-for="s in suppliers" :key="s" :value="s" />
    </datalist>
    <label>Énergie
      <select v-model="manual.energy">
        <option v-for="(name, code) in ENERGIES" :key="code" :value="code">{{ name }}</option>
      </select>
    </label>
    <label>N° <input v-model="manual.number" size="14" required></label>
    <label>Date <input v-model="manual.invoice_date" type="date" required></label>
    <label>Total imprimé TTC <input v-model="manual.total_incl_tax" class="nombre" size="9" required></label>
    <label>Note <input v-model="manual.note" size="26"></label>
    <button type="submit" class="principal">Créer le brouillon</button>
    <button type="button" @click="manual = null">Annuler</button>
    <p v-if="manualError" class="message erreur">{{ manualError }}</p>
    <p class="discret">Les lignes se saisissent ensuite dans la grille, comme pour une facture importée.</p>
  </form>
  <p v-else>
    <button type="button" @click="newManual()">+ Saisir une facture</button>
    <span class="discret"> sans PDF, ou dont le PDF n'est pas lu automatiquement (eau, taxe foncière…)</span>
  </p>

  <section class="filtres">
    <span class="discret">
      {{ shown.length }} facture(s) affichée(s) sur {{ invoices.length }}<template v-if="drafts"> · {{ drafts }} brouillon(s) à vérifier</template>
    </span>
    <button type="button" class="lien" @click="filters = defaultFilters()">Effacer les filtres</button>
  </section>

  <!-- Short columns at a fixed width; the supplier and the number take the rest -->
  <DataTable
    ref="table" v-model:filters="filters" :value="rows" data-key="id" filter-display="row" size="small"
    sort-field="invoice_date" :sort-order="-1" state-storage="session" :state-key="stateKey('invoices')"
    class="clickable" @row-click="router.push({ name: 'invoice', params: { id: $event.data.id } })"
    @state-restore="filters = withDefaults(defaultFilters(), $event.filters)"
  >
    <template #empty>Aucune facture.</template>
    <Column field="invoice_date" header="Date" sortable :show-filter-menu="false" style="width: 7.5rem">
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
    </Column>
    <Column field="supplier" header="Fournisseur" sortable :show-filter-menu="false">
      <template #filter="{ filterModel, filterCallback }">
        <ColumnFilter :model="filterModel" :apply="filterCallback" :options="distinctOptions(invoices.map((f) => f.supplier))" />
      </template>
    </Column>
    <Column field="number" header="N°" :show-filter-menu="false">
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
    </Column>
    <Column field="energy" header="Énergie" sortable :show-filter-menu="false" style="width: 9rem">
      <template #body="{ data }">{{ ENERGIES[data.energy as Energie] }}</template>
      <template #filter="{ filterModel, filterCallback }">
        <ColumnFilter :model="filterModel" :apply="filterCallback" :options="optionsOf(ENERGIES)" />
      </template>
    </Column>
    <!-- The period of its lines: the first day and the last one -->
    <Column field="start" header="Début" sortable :show-filter-menu="false" style="width: 7.5rem">
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
    </Column>
    <Column field="end" header="Fin" sortable :show-filter-menu="false" style="width: 7.5rem">
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
    </Column>
    <Column
      field="total_incl_tax" header="Total TTC" sortable body-class="nombre" header-class="nombre" :show-filter-menu="false"
      style="width: 8rem"
    >
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
      <!-- The sum of the lines against the printed total: a green tick, or a red cross -->
      <template #body="{ data }">
        {{ data.total_incl_tax }}
        <span
          :class="data.total_ok ? 'ok' : 'ko'"
          :title="data.total_ok ? 'Somme des lignes = total imprimé' : data.total_incl_tax === null ? 'Total imprimé à saisir' : 'Écart entre la somme des lignes et le total imprimé'"
        >{{ data.total_ok ? '✓' : '✗' }}</span>
      </template>
    </Column>
    <Column field="status" header="Statut" :show-filter-menu="false" style="width: 9rem">
      <template #body="{ data }"><span class="pastille" :class="data.status">{{ STATUTS[data.status as FactureResumee['status']] }}</span></template>
      <template #filter="{ filterModel, filterCallback }">
        <ColumnFilter :model="filterModel" :apply="filterCallback" :options="optionsOf(STATUTS)" multiple />
      </template>
    </Column>
    <Column field="payment_status" header="Payée" :show-filter-menu="false" style="width: 10rem">
      <template #body="{ data }">
        <span v-if="data.payment_status" :class="PAYMENT_CLASSES[data.payment_status as PaymentStatus]" :title="paymentTitle(data)">
          <template v-if="data.payment_status === 'paid'">✓ {{ data.payment_date }}</template>
          <template v-else>{{ PAYMENT_STATUSES[data.payment_status as PaymentStatus] }}</template>
        </span>
      </template>
      <template #filter="{ filterModel, filterCallback }">
        <ColumnFilter :model="filterModel" :apply="filterCallback" :options="optionsOf(PAYMENT_STATUSES)" />
      </template>
    </Column>
    <Column field="tenant_copy" header="Masquage" :show-filter-menu="false" style="width: 9rem">
      <template #body="{ data }">
        <span v-if="data.status !== 'replaced'" :class="MASKING[data.tenant_copy as EtatAnnexe].cssClass" :title="MASKING[data.tenant_copy as EtatAnnexe].title">
          {{ MASKING[data.tenant_copy as EtatAnnexe].label }}
        </span>
      </template>
      <template #filter="{ filterModel, filterCallback }">
        <ColumnFilter :model="filterModel" :apply="filterCallback" :options="Object.entries(MASKING).map(([value, m]) => ({ value, label: m.label }))" />
      </template>
    </Column>
    <Column header="PDF" style="width: 3.5rem">
      <template #body="{ data }">
        <a v-if="data.pdf" :href="api.pdfUrl(data.id)" target="_blank" title="Ouvrir le PDF" @click.stop>PDF</a>
        <span v-else class="discret" title="Pas de PDF : le joindre depuis la facture">—</span>
      </template>
    </Column>
  </DataTable>
</template>

<style scoped>
/* The building the invoices go to: hard to miss, at the top of the drop zone */
.immeuble-import {
  display: flex;
  width: fit-content;
  margin: 0 auto 0.8rem;
  padding: 0.5rem 0.9rem;
  gap: 0.6rem;
  align-items: center;
  font-size: 1.15rem;
  font-weight: 600;
  background: var(--fond-avertissement);
  border: 1px solid var(--bord);
  border-radius: 6px;
}

.immeuble-import select {
  font-size: 1.05rem;
  font-weight: 600;
}
</style>

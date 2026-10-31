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
  fournisseur: string, energie: Energie, numero: string, date_facture: string, montant_ttc: string, note: string
  file: File | null
}

const router = useRouter()
const { immeubles: buildings, immeubleId: building, pret: ready } = useImmeuble()
// The building an invoice goes to: the one chosen in the menu, shown again where invoices are dropped or typed
const buildingName = (id: number | null) => buildings.value.find((b) => b.id === id)?.nom ?? ''
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
    invoices.value = await api.factures(building.value)
    error.value = null
  } catch (e) {
    error.value = (e as Error).message
  }
}

watch(building, load)

// ---------------------------------------------------------------- list

// Its tenant version (ADR 0024): to make or to check before it is joined to a supporting document
const MASKING: Record<EtatAnnexe, { label: string, cssClass: string, title: string }> = {
  verifiee: { label: '✓ validé', cssClass: 'ok', title: 'Version locataire contrôlée : jointe aux justificatifs' },
  a_verifier: { label: 'à contrôler', cssClass: 'ko', title: 'Version locataire à contrôler (onglet « Version locataire »)' },
  a_faire: { label: 'à créer', cssClass: 'ko', title: 'Version locataire pas encore créée' },
  confidentiel: { label: 'confidentielle', cssClass: 'discret', title: 'Fournisseur confidentiel : jamais jointe' },
  sans_pdf: { label: '—', cssClass: 'discret', title: 'Pas de PDF : rien à joindre' },
}

// Paid by bank movements (ADR 0022): the only field computed here, shown and filtered under « Payée »
const PAYMENT_STATUSES = { unpaid: 'à payer', partial: 'partielle', paid: 'payée' }
type PaymentStatus = keyof typeof PAYMENT_STATUSES
const PAYMENT_CLASSES: Record<PaymentStatus, string> = { unpaid: 'discret', partial: '', paid: 'ok' }

function paymentStatus(f: FactureResumee): PaymentStatus | null {
  // A replaced invoice, or a draft without a total: nothing to pay; a draft with one may already be paid
  if (f.statut === 'remplacee' || f.montant_ttc === null || (f.statut === 'a_verifier' && Number(f.paye) === 0)) {
    return null
  }
  return Number(f.reste) <= 0 ? 'paid' : Number(f.paye) > 0 ? 'partial' : 'unpaid'
}

/** The detail of its payment, as a tooltip: last payment, what is left, or paid too much. */
function paymentTitle(f: FactureResumee) {
  const last = f.date_paiement ? `Dernier règlement le ${f.date_paiement}` : 'Aucun mouvement bancaire rattaché'
  if (Number(f.reste) < 0) {
    return `${last} ; payé ${f.paye}, écart ${f.reste.replace('-', '')}`
  }
  return Number(f.reste) > 0 && Number(f.paye) > 0 ? `${last} ; reste ${f.reste}` : last
}

const rows = computed(() => invoices.value.map((f) => ({ ...f, payment_status: paymentStatus(f) })))
type Row = (typeof rows.value)[number]

// Filters on the fields of the API; replaced invoices (ADR 0017) stay in the database, hidden unless asked
const defaultFilters = (): Filters => ({
  date_facture: contains(), fournisseur: equals(), numero: contains(), energie: equals(), debut: contains(), fin: contains(),
  montant_ttc: contains(), statut: anyOf(['a_verifier', 'validee']), payment_status: equals(), annexe: equals(),
})
const filters = ref<Filters>(defaultFilters())
const table = ref<FilteredTable<Row>>(null)
const shown = computed(() => table.value?.processedData ?? [])

const drafts = computed(() => invoices.value.filter((f) => f.statut === 'a_verifier').length)

// ---------------------------------------------------------------- import of PDFs

async function importFiles(files: FileList | File[] | null) {
  if (!files || building.value === null) {
    return
  }
  let extractors: ExtracteurEnregistre[]
  let terms: string[]
  try {
    [extractors, terms] = await Promise.all([api.extracteurs(), api.termesMasques()])
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
    fail(`${candidate.enregistre.fournisseur} v${candidate.enregistre.version} : ${problem}`)
    return
  }
  try {
    const { facture: invoice, controle: checks } = await api.importer(target, file, draft)
    let copy = ''
    if (invoice.annexe === 'a_faire') {
      try {
        await preparerAnnexe(invoice, terms && extractors.length
          ? { termes: terms, extracteurs: extractors, modele: (await api.fournisseur(invoice.fournisseur_id)).zones_masquees }
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
      message: `${invoice.fournisseur} n° ${invoice.numero} : brouillon créé dans ${buildingName(target)}`
        + (checks.validable ? '' : ' (contrôles en erreur)') + copy,
    })
  } catch (e) {
    const duplicate = e instanceof ApiError && e.status === 409
    Object.assign(result, {
      status: duplicate ? 'duplicate' : 'error',
      id: duplicate ? Number(e.body.facture_id) : undefined,
      message: (e as Error).message,
      toType: e instanceof ApiError && e.body.code === 'saisie_manuelle' ? file : undefined,
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

const suppliers = computed(() => [...new Set(invoices.value.map((f) => f.fournisseur))].sort())

// A known supplier gives the energy of its other invoices
watch(() => manual.value?.fournisseur, (name) => {
  const known = invoices.value.find((f) => f.fournisseur === name)
  if (manual.value && known) {
    manual.value.energie = known.energie
  }
})

function newManual(file: File | null = null) {
  manual.value = { fournisseur: '', energie: 'eau', numero: '', date_facture: '', montant_ttc: '', note: '', file }
  manualError.value = null
}

async function create() {
  if (!manual.value || building.value === null) {
    return
  }
  const { file, montant_ttc, note, ...header } = manual.value
  try {
    const { facture: invoice } = await api.creerFacture(
      building.value,
      { ...header, montant_ttc: nombreApi(montant_ttc) ?? montant_ttc, note: note.trim() || null },
      file,
    )
    await router.push({ name: 'facture', params: { id: invoice.id } })
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
        <option v-for="b in buildings" :key="b.id" :value="b.id">{{ b.nom }}</option>
      </select>
    </label>
    <p>Déposer des factures PDF ici, ou</p>
    <label class="bouton">
      Choisir des fichiers…
      <input type="file" accept="application/pdf" multiple hidden @change="pick">
    </label>
    <p class="discret">Les factures d'un fournisseur qui a un extracteur (EDF, ENGIE… voir <RouterLink :to="{ name: 'fournisseurs' }">Fournisseurs</RouterLink>) sont lues automatiquement, dans le navigateur. Chaque facture importée reste un brouillon jusqu'à sa validation.</p>
  </section>

  <ul v-if="results.length" class="resultats">
    <li v-for="(r, i) in results" :key="i" :class="IMPORT_CLASSES[r.status]">
      <strong>{{ r.file }}</strong> : {{ r.message }}
      <RouterLink v-if="r.id" :to="{ name: 'facture', params: { id: r.id } }">ouvrir</RouterLink>
      <button v-if="r.toType" type="button" @click="newManual(r.toType)">Saisir à la main avec ce PDF</button>
      <template v-if="r.choice">
        <button v-for="c in r.choice.candidates" :key="c.enregistre.id" type="button" @click="chooseExtractor(r, c)">
          {{ c.enregistre.fournisseur }} (v{{ c.enregistre.version }})
        </button>
      </template>
    </li>
  </ul>

  <form v-if="manual" class="formulaire" @submit.prevent="create">
    <strong>Nouvelle facture {{ manual.file ? `(PDF joint : ${manual.file.name})` : 'sans PDF' }}</strong>
    <label>Immeuble
      <select v-model="building" required>
        <option v-for="b in buildings" :key="b.id" :value="b.id">{{ b.nom }}</option>
      </select>
    </label>
    <label>Fournisseur <input v-model="manual.fournisseur" list="suppliers" size="16" required></label>
    <datalist id="suppliers">
      <option v-for="s in suppliers" :key="s" :value="s" />
    </datalist>
    <label>Énergie
      <select v-model="manual.energie">
        <option v-for="(name, code) in ENERGIES" :key="code" :value="code">{{ name }}</option>
      </select>
    </label>
    <label>N° <input v-model="manual.numero" size="14" required></label>
    <label>Date <input v-model="manual.date_facture" type="date" required></label>
    <label>Total imprimé TTC <input v-model="manual.montant_ttc" class="nombre" size="9" required></label>
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
    sort-field="date_facture" :sort-order="-1" state-storage="session" :state-key="stateKey('invoices')"
    class="clickable" @row-click="router.push({ name: 'facture', params: { id: $event.data.id } })"
    @state-restore="filters = withDefaults(defaultFilters(), $event.filters)"
  >
    <template #empty>Aucune facture.</template>
    <Column field="date_facture" header="Date" sortable :show-filter-menu="false" style="width: 7.5rem">
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
    </Column>
    <Column field="fournisseur" header="Fournisseur" sortable :show-filter-menu="false">
      <template #filter="{ filterModel, filterCallback }">
        <ColumnFilter :model="filterModel" :apply="filterCallback" :options="distinctOptions(invoices.map((f) => f.fournisseur))" />
      </template>
    </Column>
    <Column field="numero" header="N°" :show-filter-menu="false">
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
    </Column>
    <Column field="energie" header="Énergie" sortable :show-filter-menu="false" style="width: 9rem">
      <template #body="{ data }">{{ ENERGIES[data.energie as Energie] }}</template>
      <template #filter="{ filterModel, filterCallback }">
        <ColumnFilter :model="filterModel" :apply="filterCallback" :options="optionsOf(ENERGIES)" />
      </template>
    </Column>
    <!-- The period of its lines: the first day and the last one -->
    <Column field="debut" header="Début" sortable :show-filter-menu="false" style="width: 7.5rem">
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
    </Column>
    <Column field="fin" header="Fin" sortable :show-filter-menu="false" style="width: 7.5rem">
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
    </Column>
    <Column
      field="montant_ttc" header="Total TTC" sortable body-class="nombre" header-class="nombre" :show-filter-menu="false"
      style="width: 8rem"
    >
      <template #filter="{ filterModel, filterCallback }"><ColumnFilter :model="filterModel" :apply="filterCallback" /></template>
      <!-- The sum of the lines against the printed total: a green tick, or a red cross -->
      <template #body="{ data }">
        {{ data.montant_ttc }}
        <span
          :class="data.total_ok ? 'ok' : 'ko'"
          :title="data.total_ok ? 'Somme des lignes = total imprimé' : data.montant_ttc === null ? 'Total imprimé à saisir' : 'Écart entre la somme des lignes et le total imprimé'"
        >{{ data.total_ok ? '✓' : '✗' }}</span>
      </template>
    </Column>
    <Column field="statut" header="Statut" :show-filter-menu="false" style="width: 9rem">
      <template #body="{ data }"><span class="pastille" :class="data.statut">{{ STATUTS[data.statut as FactureResumee['statut']] }}</span></template>
      <template #filter="{ filterModel, filterCallback }">
        <ColumnFilter :model="filterModel" :apply="filterCallback" :options="optionsOf(STATUTS)" multiple />
      </template>
    </Column>
    <Column field="payment_status" header="Payée" :show-filter-menu="false" style="width: 10rem">
      <template #body="{ data }">
        <span v-if="data.payment_status" :class="PAYMENT_CLASSES[data.payment_status as PaymentStatus]" :title="paymentTitle(data)">
          <template v-if="data.payment_status === 'paid'">✓ {{ data.date_paiement }}</template>
          <template v-else>{{ PAYMENT_STATUSES[data.payment_status as PaymentStatus] }}</template>
        </span>
      </template>
      <template #filter="{ filterModel, filterCallback }">
        <ColumnFilter :model="filterModel" :apply="filterCallback" :options="optionsOf(PAYMENT_STATUSES)" />
      </template>
    </Column>
    <Column field="annexe" header="Masquage" :show-filter-menu="false" style="width: 9rem">
      <template #body="{ data }">
        <span v-if="data.statut !== 'remplacee'" :class="MASKING[data.annexe as EtatAnnexe].cssClass" :title="MASKING[data.annexe as EtatAnnexe].title">
          {{ MASKING[data.annexe as EtatAnnexe].label }}
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

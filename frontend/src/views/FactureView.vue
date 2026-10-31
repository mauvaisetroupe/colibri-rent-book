<script setup lang="ts">
import { VGrid, type ColumnRegular } from '@revolist/vue3-datagrid'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, RouterLink, useRouter } from 'vue-router'

import {
  api, ApiError, CATEGORIES, ENERGIES, STATUTS, type AnnexeFacture, type Checks, type Facture, type FactureDetail,
  type FactureResumee, type FactureSaisie, type LiensFacture, type MouvementPourFacture, type ReglementFacture,
  type RegularisationTouchee, type ZoneSaisie,
} from '../api'
import EditeurZones from '../components/EditeurZones.vue'
import type { Zone } from '../extraction/masquage'
import { preparerAnnexe, zonesAutomatiques } from '../extraction/navigateur'
import { dateFr, depuisGrille, euros, ligneVide, nombreApi, nombreFr, versGrille, type LigneGrille } from '../format'

const props = defineProps<{ id: number }>()
const router = useRouter()

const invoice = ref<Facture | null>(null)
const entete = reactive({ number: '', invoice_date: '', total_incl_tax: '', energy: 'gas' as Facture['energy'], note: '' })
const lines = ref<LigneGrille[]>([])
const checks = ref<Checks | null>(null)
const modifie = ref(false)
const occupe = ref(false)
const message = ref<{ text: string, type: 'info' | 'erreur' } | null>(null)
const ligneActive = ref<number | null>(null)

const liens = ref<LiensFacture | null>(null)
// Its payments by bank movements (ADR 0022), and the debits offered to link one
const payments = ref<ReglementFacture[]>([])
const reglement = ref<{ transactions: MouvementPourFacture[], choisi: number | null } | null>(null)
// Sent regularisations touched by a replacement just made: to check (ADR 0017)
const touchees = ref<RegularisationTouchee[]>([])
// Its copy joined to the supporting documents (ADR 0024), and whether the preview shows it instead of the original
const tenant_copy = ref<AnnexeFacture | null>(null)
const voirCopie = ref(false)

const validee = computed(() => invoice.value?.status === 'validated')
// Paid by bank movements (ADR 0022): a validated invoice, or a draft whose total is known (an invoice still to find)
const reglable = computed(() => invoice.value !== null && invoice.value.status !== 'replaced' && invoice.value.total_incl_tax !== null)
// Validated or replaced: never edited (ADR 0003, 0017)
const figee = computed(() => invoice.value !== null && invoice.value.status !== 'draft')

const colonnes: ColumnRegular[] = [
  { prop: 'category', name: 'Catégorie', size: 130 },
  { prop: 'label', name: 'Libellé', size: 280 },
  { prop: 'start', name: 'Début', size: 110 },
  { prop: 'end', name: 'Fin', size: 110 },
  { prop: 'kwh', name: 'kWh', size: 75 },
  { prop: 'amount_excl_tax', name: 'HT', size: 85 },
  { prop: 'vat_rate', name: 'TVA %', size: 65 },
  { prop: 'amount_incl_tax', name: 'TTC', size: 85 },
  { prop: 'allocation', name: 'Affectation', size: 110 },
  { prop: 'note', name: 'Note', size: 260 },
]

onMounted(charger)
// From an invoice to the one replacing it: same screen, another id
watch(() => props.id, () => {
  touchees.value = []
  remplacement.value = null
  message.value = null
  charger()
})

async function charger() {
  try {
    appliquer(await api.invoice(props.id))
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
  }
}

function appliquer(detail: FactureDetail) {
  invoice.value = detail.invoice
  liens.value = detail.liens
  payments.value = detail.payments
  tenant_copy.value = detail.tenant_copy
  probleme.value = null
  if (!detail.tenant_copy) {
    voirCopie.value = false
  }
  Object.assign(entete, {
    number: detail.invoice.number,
    invoice_date: detail.invoice.invoice_date,
    total_incl_tax: nombreFr(detail.invoice.total_incl_tax),
    energy: detail.invoice.energy,
    note: detail.invoice.note ?? '',
  })
  lines.value = detail.lines.map(versGrille)
  checks.value = detail.checks
  surligner()
  modifie.value = false
}

const saisie = (): FactureSaisie => ({
  number: entete.number,
  invoice_date: entete.invoice_date,
  total_incl_tax: nombreApi(entete.total_incl_tax) ?? '',
  energy: entete.energy,
  note: entete.note.trim() || null,
  lines: lines.value.map(depuisGrille),
})

// ---------------------------------------------------------------- live checks (ADR 0005)

let minuterie: ReturnType<typeof setTimeout> | undefined
let sequence = 0

function changer() {
  modifie.value = true
  message.value = null
  clearTimeout(minuterie)
  minuterie = setTimeout(controler, 250)
}

async function controler() {
  const number = ++sequence
  const { total_incl_tax, lines: aControler } = saisie()
  try {
    const resultat = await api.controler({ total_incl_tax, lines: aControler })
    // An older answer arriving late must not overwrite a newer one
    if (number === sequence) {
      checks.value = resultat
      surligner()
    }
  } catch (e) {
    message.value = { text: `Contrôle impossible : ${(e as Error).message}`, type: 'erreur' }
  }
}

/** Highlights the lines that have a finding: an error wins over a warning. */
function surligner() {
  const parLigne = new Map<number, 'error' | 'warning'>()
  for (const c of checks.value?.findings ?? []) {
    if (c.line !== null && parLigne.get(c.line) !== 'error') {
      parLigne.set(c.line, c.severity)
    }
  }
  lines.value = lines.value.map((l, i) => {
    const severite = parLigne.get(i)
    return { ...l, _classe: severite ? `ligne-${severite}` : '' }
  })
}

const constats = computed(() =>
  [...(checks.value?.findings ?? [])].sort((a, b) =>
    (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1) || (a.line ?? -1) - (b.line ?? -1)),
)

// ---------------------------------------------------------------- grid events

// A single cell edit carries `prop` (and also a `data` key); a range edit (paste, autofill) carries `data` only
type EditDetail =
  | { prop: keyof LigneGrille, rowIndex: number, val: unknown }
  | { data: Record<number, Partial<LigneGrille>> }

function apresEdition(event: CustomEvent<EditDetail>) {
  const detail = event.detail
  if ('prop' in detail) {
    const ligne = lines.value[detail.rowIndex]
    if (ligne) {
      ligne[detail.prop] = String(detail.val ?? '')
    }
  } else {
    for (const [index, valeurs] of Object.entries(detail.data)) {
      const ligne = lines.value[Number(index)]
      if (ligne) {
        Object.assign(ligne, valeurs)
      }
    }
  }
  changer()
}

function apresFocus(event: CustomEvent<{ rowIndex?: number }>) {
  ligneActive.value = event.detail.rowIndex ?? null
}

function ajouterLigne() {
  lines.value = [...lines.value, ligneVide()]
  changer()
}

function supprimerLigne() {
  if (ligneActive.value === null || !lines.value[ligneActive.value]) {
    return
  }
  lines.value = lines.value.filter((_, i) => i !== ligneActive.value)
  ligneActive.value = null
  changer()
}

// ---------------------------------------------------------------- actions

async function executer(action: () => Promise<FactureDetail & { charge_adjustments?: RegularisationTouchee[] }>, succes: string) {
  occupe.value = true
  try {
    const detail = await action()
    appliquer(detail)
    touchees.value = detail.charge_adjustments ?? []
    message.value = { text: succes, type: 'info' }
    return true
  } catch (e) {
    if (e instanceof ApiError && e.body.checks) {
      checks.value = e.body.checks as Checks
      surligner()
    }
    message.value = { text: (e as Error).message, type: 'erreur' }
    return false
  } finally {
    occupe.value = false
  }
}

const enregistrer = () => executer(() => api.enregistrer(props.id, saisie()), 'Brouillon enregistré')

// ---------------------------------------------------------------- payments (ADR 0022)

async function ouvrirReglement() {
  try {
    const transactions = await api.mouvementsPourFacture(props.id)
    reglement.value = { transactions, choisi: transactions.find((m) => m.correspond)?.id ?? null }
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
  }
}

async function regler() {
  const choisi = reglement.value?.choisi
  if (choisi && await executer(() => api.reglerFacture(props.id, choisi), 'Paiement rattaché')) {
    reglement.value = null
  }
}

const detacherReglement = (r: ReglementFacture) =>
  executer(() => api.supprimerReglementFacture(props.id, r.id), 'Paiement détaché (le mouvement reste dans la banque)')

async function valider() {
  if (modifie.value && !(await enregistrer())) {
    return
  }
  const corrige = liens.value?.corrige
  await executer(
    () => api.valider(props.id),
    corrige
      ? `Facture validée : elle remplace la facture corrigée (${corrige.supplier} n° ${corrige.number}) dans les décomptes`
      : 'Facture validée : elle entre dans les décomptes',
  )
}

// ---------------------------------------------------------------- replacing a validated invoice (ADR 0017)

const remplacement = ref<{ candidates: FactureResumee[], par: number | null, motif: string } | null>(null)

async function ouvrirRemplacement() {
  if (!invoice.value) {
    return
  }
  const candidates = (await api.invoices(invoice.value.building_id))
    .filter((f) => f.status === 'validated' && f.id !== invoice.value?.id)
  remplacement.value = { candidates, par: null, motif: '' }
}

async function remplacer() {
  const r = remplacement.value
  if (!r?.par || !r.motif.trim()) {
    return
  }
  if (await executer(() => api.remplacer(props.id, r.par!, r.motif.trim()), 'Facture remplacée : elle ne compte plus dans les décomptes')) {
    remplacement.value = null
  }
}

async function corriger() {
  if (!confirm('Créer un brouillon, copie de cette facture, à corriger puis valider ? À sa validation, il la remplace ; '
    + 'jusque-là, elle continue de compter.')) {
    return
  }
  occupe.value = true
  try {
    const copie = await api.corriger(props.id)
    await router.push({ name: 'invoice', params: { id: copie.invoice.id } })
  } catch (e) {
    const existante = e instanceof ApiError ? e.body.invoice_id as number | undefined : undefined
    message.value = { text: (e as Error).message, type: 'erreur' }
    if (existante) {
      await router.push({ name: 'invoice', params: { id: existante } })
    }
  } finally {
    occupe.value = false
  }
}

// ---------------------------------------------------------------- copy joined to the supporting documents (ADR 0024)

// State of the version for the tenant, on its button above the preview
const ETATS_ANNEXE: Record<Facture['tenant_copy'], string> = {
  confidential: 'jamais jointe',
  no_pdf: '',
  to_make: 'à créer',
  to_check: 'à contrôler',
  checked: '✓ contrôlée',
}
// The version for the tenant can be shown: made from the current PDF
const copieAJour = computed(() => !!tenant_copy.value && invoice.value?.tenant_copy !== 'to_make')

async function preparer(succes = 'Version locataire créée : la contrôler') {
  if (await executer(() => preparerAnnexe(invoice.value!), succes)) {
    voirCopie.value = true
  }
}

const verifier = () => executer(() => api.verifierAnnexe(props.id, tenant_copy.value!.id),
  'Version locataire contrôlée : elle sera jointe au justificatif')

// « Il reste une information personnelle » : a text to mask on every invoice, or the masking of the supplier
const probleme = ref<{ text: string, extractor: number | null } | null>(null)
// Shorter, a text would be masked where it is useful (« FONTOY » would hide the address of the building)
const LONGUEUR_MINIMALE = 5

async function signalerProbleme() {
  probleme.value = { text: '', extractor: null }
  try {
    const extractors = await api.extractors()
    const last = extractors.find((e) => e.latest && (e.type ?? 'invoice') === 'invoice' && e.supplier === invoice.value?.supplier)
    if (probleme.value) {
      probleme.value.extractor = last?.id ?? null
    }
  } catch {
    // Without the list, the link goes to a new extractor of the supplier
  }
}

// ---------------------------------------------------------------- zones drawn by hand (ADR 0025)

// Its version was made from a scan: masked by zones drawn by hand only; on a page of text, they are added to the terms
const scannee = computed(() => copieAJour.value && !!tenant_copy.value?.scanned_pages.length)
// The zones being adjusted, in a window over the pages of the PDF
const zonesFacture = ref<{ zones: ZoneSaisie[], contenu: Uint8Array, automatiques: Zone[] } | null>(null)
const fenetreZones = ref<HTMLDialogElement | null>(null)

async function ajusterZones() {
  probleme.value = null
  try {
    const [contenu, supplier] = await Promise.all([
      fetch(api.pdfUrl(props.id)).then(async (r) => new Uint8Array(await r.arrayBuffer())),
      api.supplier(invoice.value!.supplier_id),
    ])
    zonesFacture.value = { contenu, zones: (invoice.value!.masked_zones ?? supplier.masked_zones).map((z) => ({ ...z })), automatiques: [] }
    fenetreZones.value?.showModal()
    // What the terms and the extractor already mask, shown in the editor: not to be drawn again
    const automatiques = await zonesAutomatiques(contenu.slice(), invoice.value!.supplier)
    if (zonesFacture.value?.contenu === contenu) {
      zonesFacture.value.automatiques = automatiques
    }
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
  }
}

function fermerZones() {
  fenetreZones.value?.close()
  zonesFacture.value = null
}

/** Its own zones (null: those of its supplier), then its version made again with them. */
async function enregistrerZones(zones: ZoneSaisie[] | null) {
  fermerZones()
  if (await executer(() => api.modifierZonesFacture(props.id, zones), 'Zones enregistrées')) {
    await preparer('Version locataire recréée avec ces zones : la contrôler')
  }
}

const masquageDuFournisseur = computed(() => (probleme.value?.extractor
  ? { name: 'extractor', params: { id: probleme.value.extractor }, query: { onglet: 'masquage', invoice: props.id } }
  : { name: 'nouvel-extracteur', query: { supplier: invoice.value?.supplier, onglet: 'masquage', invoice: props.id } }))

async function masquerEtRecreer() {
  const text = probleme.value?.text.trim() ?? ''
  if (text.length < LONGUEUR_MINIMALE) {
    return
  }
  occupe.value = true
  try {
    await api.modifierTermesMasques([...await api.termesMasques(), text])
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
    occupe.value = false
    return
  }
  occupe.value = false
  probleme.value = null
  await preparer(`« ${text} » est masqué sur toutes les factures ; version locataire recréée : la contrôler de nouveau`)
}

// ---------------------------------------------------------------- invoice PDF

const survolPdf = ref(false)
const versionPdf = ref(0)

async function joindre(files: FileList | null | undefined) {
  const file = files?.[0]
  if (!file) {
    return
  }
  occupe.value = true
  try {
    const autre = await autreFacture(file)
    if (autre) {
      message.value = { text: `Ce PDF est la facture ${autre}, pas ${invoice.value?.supplier} n° ${invoice.value?.number}`, type: 'erreur' }
      return
    }
    const detail = await api.joindrePdf(props.id, file)
    invoice.value = detail.invoice
    tenant_copy.value = detail.tenant_copy
    voirCopie.value = false
    versionPdf.value++
    message.value = { text: 'PDF de la facture enregistré', type: 'info' }
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
  } finally {
    occupe.value = false
  }
}

/** The invoice an extractor reads in the PDF when it is not this one (ADR 0013), else null. */
async function autreFacture(file: File): Promise<string | null> {
  try {
    const { candidats, lire, morceauxDuPdf } = await import('../extraction/navigateur')
    const pages = await morceauxDuPdf(file)
    for (const candidat of candidats(pages, await api.extractors())) {
      const number = lire(pages, candidat).number.valeur
      const supplier = candidat.enregistre.supplier
      if (number && (supplier !== invoice.value?.supplier || number !== invoice.value?.number)) {
        return `${supplier} n° ${number}`
      }
    }
  } catch {
    // Not read: attached as it is (water, property tax…)
  }
  return null
}

function choisirPdf(event: Event) {
  const input = event.target as HTMLInputElement
  joindre(input.files).finally(() => { input.value = '' })
}

async function supprimer() {
  const text = liens.value?.corrige
    ? 'Supprimer ce brouillon ? La correction est abandonnée, la facture d\'origin reste validée.'
    : 'Supprimer ce brouillon ? Le PDF pourra être importé à nouveau.'
  if (!confirm(text)) {
    return
  }
  try {
    await api.supprimer(props.id)
    modifie.value = false
    await router.push({ name: 'invoices' })
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
  }
}

// ---------------------------------------------------------------- unsaved changes

onBeforeRouteLeave(() => !modifie.value || confirm('Des modifications ne sont pas enregistrées. Quitter quand même ?'))

const avantDechargement = (event: BeforeUnloadEvent) => {
  if (modifie.value) {
    event.preventDefault()
  }
}
window.addEventListener('beforeunload', avantDechargement)
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', avantDechargement)
  clearTimeout(minuterie)
})
</script>

<template>
  <p><RouterLink :to="{ name: 'invoices' }">← Factures</RouterLink></p>

  <template v-if="invoice">
    <section class="entete-facture">
      <h1>
        {{ invoice.supplier }}
        <span class="pastille" :class="invoice.status">{{ STATUTS[invoice.status] }}</span>
      </h1>
      <div class="champs">
        <label>N° <input v-model="entete.number" :disabled="figee" @input="changer"></label>
        <label>Date <input v-model="entete.invoice_date" type="date" :disabled="figee" @input="changer"></label>
        <label>Énergie
          <select v-model="entete.energy" :disabled="figee" @change="changer">
            <option v-for="(name, code) in ENERGIES" :key="code" :value="code">{{ name }}</option>
          </select>
        </label>
        <label>Total imprimé TTC
          <input v-model="entete.total_incl_tax" class="nombre" :disabled="figee" @input="changer">
        </label>
        <label class="note">Note <input v-model="entete.note" :disabled="figee" @input="changer"></label>
      </div>
    </section>

    <section v-if="checks" class="bandeau" :class="checks.can_validate ? 'ok' : 'ko'">
      <span>Somme des lignes <strong>{{ euros(checks.lines_total) }}</strong></span>
      <template v-if="entete.total_incl_tax.trim()">
        <span>Total imprimé <strong>{{ euros(nombreApi(entete.total_incl_tax)) }}</strong></span>
        <span>Écart <strong :class="checks.ok ? 'ok' : 'ko'">{{ euros(checks.gap) }}</strong></span>
      </template>
      <span v-else>Total imprimé <strong class="ko">à saisir</strong></span>
      <span>{{ checks.can_validate ? '✓ Contrôles bloquants passés' : '✗ Validation impossible' }}</span>
      <span v-if="modifie" class="discret">modifications non enregistrées</span>
    </section>

    <!-- Replacement links (ADR 0017) -->
    <p v-if="invoice.status === 'replaced'" class="message avertissement">
      Facture <strong>remplacée</strong> le {{ dateFr(invoice.replaced_at?.slice(0, 10) ?? null) }}
      <template v-if="liens?.remplacante">
        par <RouterLink :to="{ name: 'invoice', params: { id: liens.remplacante.id } }">{{ liens.remplacante.supplier }} n° {{ liens.remplacante.number }}</RouterLink>
      </template>
      ({{ invoice.replacement_reason }}) : elle n'entre plus dans les décomptes ni dans la synthèse fiscale.
    </p>
    <p v-if="liens?.corrige && invoice.status === 'draft'" class="message info">
      Correction de <RouterLink :to="{ name: 'invoice', params: { id: liens.corrige.id } }">{{ liens.corrige.supplier }} n° {{ liens.corrige.number }}</RouterLink>,
      validée : à la validation de ce brouillon, elle est remplacée ; jusque-là, c'est elle qui compte. La note est reprise
      dans le motif.
    </p>
    <p v-if="liens?.correction" class="message info">
      Correction en cours :
      <RouterLink :to="{ name: 'invoice', params: { id: liens.correction.id } }">brouillon {{ liens.correction.supplier }} n° {{ liens.correction.number }}</RouterLink>.
    </p>
    <p v-if="liens?.remplacees.length" class="discret">
      Remplace :
      <template v-for="(r, i) in liens.remplacees" :key="r.id">
        {{ i ? ', ' : '' }}<RouterLink :to="{ name: 'invoice', params: { id: r.id } }">{{ r.supplier }} n° {{ r.number }}</RouterLink>
      </template>
    </p>

    <p v-if="message" class="message" :class="message.type">{{ message.text }}</p>
    <div v-if="touchees.length" class="message avertissement">
      Régularisations envoyées dont la période touche cette facture : leur décompte refait peut différer du montant
      envoyé (« à rectifier » s'il diffère de plus de 5 €).
      <ul>
        <li v-for="r in touchees" :key="r.id">
          <RouterLink :to="{ name: 'charge_adjustment', params: { id: r.id } }">{{ r.tenant }} ({{ r.unit }}), {{ dateFr(r.start) }} → {{ dateFr(r.end) }}</RouterLink>
          : solde envoyé {{ euros(r.balance) }}
        </li>
      </ul>
    </div>

    <div class="edition">
      <div class="gauche">
        <div v-if="!figee" class="outils">
          <button type="button" @click="ajouterLigne">+ Ligne</button>
          <button type="button" :disabled="ligneActive === null" @click="supprimerLigne">
            Supprimer la ligne {{ ligneActive === null ? '' : ligneActive + 1 }}
          </button>
          <span class="discret">Catégories : {{ CATEGORIES.join(', ') }} · dates jj/mm/aaaa · coller depuis Excel accepté</span>
        </div>

        <div class="grille">
          <VGrid
            :source="lines"
            :columns="colonnes"
            :readonly="figee"
            :range="true"
            :apply-on-close="true"
            :resize="true"
            :row-headers="true"
            row-class="_classe"
            theme="compact"
            @afteredit="apresEdition"
            @afterfocus="apresFocus"
          />
        </div>

        <ul v-if="constats.length" class="constats">
          <li v-for="(c, i) in constats" :key="i" :class="c.severity">
            <strong>{{ c.line === null ? 'Facture' : `Ligne ${c.line + 1}` }}</strong> : {{ c.message }}
          </li>
        </ul>

        <div class="actions">
          <template v-if="!figee">
            <button type="button" :disabled="occupe || !modifie" @click="enregistrer">Enregistrer le brouillon</button>
            <button type="button" class="principal" :disabled="occupe || !checks?.can_validate" @click="valider">
              Valider la facture
            </button>
            <button type="button" class="danger" :disabled="occupe" @click="supprimer">Supprimer le brouillon</button>
          </template>
          <template v-else-if="validee">
            <p class="discret">
              Facture validée : elle entre dans les décomptes et n'est plus modifiée. Une erreur se corrige par une copie
              qui la remplace ; un doublon ou une facture rectificative la remplace.
            </p>
            <button type="button" :disabled="occupe || !!liens?.correction" @click="corriger">Corriger…</button>
            <button type="button" :disabled="occupe" @click="ouvrirRemplacement">Remplacer par…</button>
          </template>
        </div>

        <!-- Payments by bank movements (ADR 0022) -->
        <section v-if="reglable || payments.length" class="reglements">
          <h2>
            Paiement
            <span v-if="Number(invoice.remaining) < 0" class="ok">✓ payée, écart de {{ euros(invoice.remaining.replace('-', '')) }} (solde arrondi)</span>
            <span v-else-if="Number(invoice.remaining) <= 0" class="ok">✓ payée</span>
            <span v-else-if="payments.length">reste {{ euros(invoice.remaining) }} à payer</span>
            <span v-else class="discret">aucun mouvement bancaire rattaché</span>
          </h2>
          <ul v-if="payments.length">
            <li v-for="r in payments" :key="r.id">
              {{ dateFr(r.payment_date) }} · {{ r.label }} :
              <template v-if="Number(r.amount) < 0">remboursement de <strong>{{ euros(r.amount.replace('-', '')) }}</strong></template>
              <strong v-else>{{ euros(r.amount) }}</strong>
              <RouterLink :to="{ name: 'bank', query: { bank_transaction: r.bank_transaction_id } }">voir dans la banque</RouterLink>
              <button v-if="reglable" type="button" :disabled="occupe" @click="detacherReglement(r)">Détacher</button>
            </li>
          </ul>
          <template v-if="reglable">
            <button v-if="!reglement" type="button" :disabled="occupe" @click="ouvrirReglement">Rattacher un paiement…</button>
            <form v-else class="formulaire" @submit.prevent="regler">
              <label v-if="reglement.transactions.length">Mouvement bancaire
                <select v-model="reglement.choisi" required>
                  <option :value="null" disabled>Choisir un débit (ou un crédit qui la rembourse)</option>
                  <option v-for="m in reglement.transactions" :key="m.id" :value="m.id">
                    {{ m.correspond ? '✓ même montant · ' : '' }}{{ dateFr(m.transaction_date) }} · {{ m.label }} : {{ euros(m.amount) }}{{ Number(m.remaining) < Math.abs(Number(m.amount)) ? ` (reste ${euros(m.remaining)})` : '' }}
                  </option>
                </select>
              </label>
              <span v-else class="discret">Aucun mouvement « énergie », « eau », « impôts » ou sans catégorie qui ne soit déjà rattaché.</span>
              <button type="submit" class="principal" :disabled="occupe || !reglement.choisi">Rattacher</button>
              <button type="button" @click="reglement = null">Annuler</button>
            </form>
          </template>
        </section>

        <form v-if="remplacement" class="formulaire" @submit.prevent="remplacer">
          <label>Remplacée par
            <select v-model="remplacement.par" required>
              <option :value="null" disabled>Choisir une facture validée</option>
              <option v-for="f in remplacement.candidates" :key="f.id" :value="f.id">
                {{ f.supplier }} n° {{ f.number }} du {{ dateFr(f.invoice_date) }} ({{ euros(f.total_incl_tax) }})
              </option>
            </select>
          </label>
          <label class="note">Motif <input v-model="remplacement.motif" required placeholder="doublon, facture rectificative…"></label>
          <button type="submit" class="principal" :disabled="occupe || !remplacement.par || !remplacement.motif.trim()">Remplacer</button>
          <button type="button" @click="remplacement = null">Annuler</button>
        </form>
      </div>

      <div class="colonne-pdf">
        <template v-if="invoice.pdf">
          <div class="outils">
            <button type="button" :class="{ principal: !voirCopie }" @click="voirCopie = false">Facture reçue</button>
            <button v-if="invoice.tenant_copy !== 'confidential'" type="button" :class="{ principal: voirCopie }"
              @click="voirCopie = true">
              Version locataire <span :class="invoice.tenant_copy === 'checked' ? 'etat-ok' : 'etat-ko'">({{ ETATS_ANNEXE[invoice.tenant_copy] }})</span>
            </button>
            <span v-else class="discret" title="Ses factures ne sont jamais jointes aux justificatifs (page du fournisseur)">
              Fournisseur confidentiel : jamais jointe au justificatif
            </span>
            <a class="bouton" :href="voirCopie && copieAJour ? api.annexePdfUrl(invoice.id, tenant_copy!.id) : api.pdfUrl(invoice.id)"
              target="_blank">Ouvrir dans un onglet</a>
            <label class="bouton">
              Remplacer le PDF…
              <input type="file" accept="application/pdf" hidden @change="choisirPdf">
            </label>
          </div>
          <!-- The version for the tenant (ADR 0024): what to do with it, then the version itself -->
          <div v-if="voirCopie" class="bandeau-copie" :class="{ checked: invoice.tenant_copy === 'checked' }">
            <template v-if="invoice.tenant_copy === 'to_make'">
              <p>{{ tenant_copy ? 'La facture a changé : sa version locataire est à recréer.' : 'Pas encore de version locataire.' }}</p>
              <div class="actions">
                <button type="button" class="principal" :disabled="occupe" @click="preparer()">Créer la version locataire</button>
              </div>
            </template>
            <template v-else>
              <p v-if="invoice.tenant_copy === 'checked'">
                ✓ Contrôlée le {{ dateFr(tenant_copy!.checked_at!.slice(0, 10)) }} : c'est elle qui est jointe au justificatif
                envoyé au locataire.
              </p>
              <p v-else>
                Cette version est jointe au justificatif envoyé au locataire. Le nom, l'adresse, les références client et
                le compte bancaire y sont masqués en noir : contrôlez, page par page, qu'il n'en reste aucun.
              </p>
              <p v-if="scannee">
                Facture scannée : seules les zones tracées y sont masquées,
                {{ invoice.masked_zones ? 'ajustées pour cette facture' : 'celles du fournisseur' }}.
              </p>
              <p v-else-if="copieAJour && invoice.masked_zones">
                Des zones tracées pour cette facture s'ajoutent aux termes et à l'extracteur.
              </p>
              <div v-if="!probleme" class="actions">
                <button v-if="invoice.tenant_copy === 'to_check'" type="button" class="principal" :disabled="occupe" @click="verifier">
                  ✓ Rien de personnel : à joindre
                </button>
                <button v-if="scannee" type="button" :disabled="occupe" @click="ajusterZones">
                  ✗ Il reste une information personnelle : ajuster les zones…
                </button>
                <button v-else type="button" :disabled="occupe" @click="signalerProbleme">✗ Il reste une information personnelle…</button>
                <button type="button" class="lien discret" :disabled="occupe" @click="preparer()">Recréer la version locataire</button>
              </div>
              <form v-else class="probleme" @submit.prevent="masquerEtRecreer">
                <label>Texte à masquer, recopié de la facture (un texte précis : n° client, IBAN, nom…)
                  <span class="rangee">
                    <input v-model="probleme.text" size="30" autofocus>
                    <button type="submit" class="principal" :disabled="occupe || probleme.text.trim().length < LONGUEUR_MINIMALE">
                      Masquer et recréer
                    </button>
                  </span>
                </label>
                <p class="discret">
                  Il sera masqué sur toutes les factures, de tous les fournisseurs (au moins {{ LONGUEUR_MINIMALE }}
                  caractères : un mot courant masquerait aussi ce qui est utile).
                </p>
                <p class="discret">
                  Le texte change à chaque facture ?
                  <RouterLink :to="masquageDuFournisseur">Modifier le masquage du fournisseur</RouterLink>.
                </p>
                <p class="discret">
                  Une image, un QR code, un texte que la recherche ne trouve pas ?
                  <button type="button" class="lien" :disabled="occupe" @click="ajusterZones">Tracer une zone à la main…</button>
                  (pour cette facture ; pour toutes celles du fournisseur, sur sa page).
                </p>
                <p class="discret">
                  Sinon, ne rien faire : la facture ne sera pas jointe au justificatif (elle y est mentionnée, « consultable
                  sur demande »).
                </p>
                <div class="actions">
                  <button type="button" @click="probleme = null">Annuler</button>
                </div>
              </form>
            </template>
          </div>
          <iframe v-if="voirCopie && copieAJour" :key="`copie-${tenant_copy!.id}`" class="apercu" :src="api.annexePdfUrl(invoice.id, tenant_copy!.id)"
            title="Version locataire" />
          <div v-else-if="voirCopie" class="apercu apercu-vide"><p class="discret">La version locataire s'affichera ici.</p></div>
          <iframe v-else :key="versionPdf" class="apercu" :src="`${api.pdfUrl(invoice.id)}?v=${versionPdf}`" title="Facture PDF" />
        </template>
        <div
          v-else
          class="depot apercu-vide"
          :class="{ survol: survolPdf }"
          @dragover.prevent="survolPdf = true"
          @dragleave="survolPdf = false"
          @drop.prevent="survolPdf = false; joindre($event.dataTransfer?.files)"
        >
          <p>Pas de PDF pour cette facture.</p>
          <label class="bouton">
            Joindre le PDF…
            <input type="file" accept="application/pdf" hidden @change="choisirPdf">
          </label>
          <p class="discret">ou le déposer ici. Il est archivé avec la facture, sans changer ses lignes.</p>
        </div>
      </div>
    </div>
  </template>

  <p v-else-if="message" class="message erreur">{{ message.text }}</p>

  <dialog ref="fenetreZones" class="fenetre large" @close="zonesFacture = null">
    <template v-if="zonesFacture && invoice">
      <h2 tabindex="-1" autofocus>Zones masquées à la main</h2>
      <p class="discret">
        Tracer à la souris ce qui est à masquer, déplacer ou redimensionner une zone, la retirer avec × ou la touche
        Suppr. Sur une page de texte, elles s'ajoutent aux termes et à l'extracteur. Ces zones ne valent que pour cette
        facture ; celles de toutes les factures du fournisseur se tracent sur sa page.
      </p>
      <div class="actions">
        <button type="button" class="principal" @click="enregistrerZones(zonesFacture.zones)">Enregistrer et recréer la version locataire</button>
        <button v-if="invoice.masked_zones" type="button" @click="enregistrerZones(null)">Revenir aux zones du fournisseur</button>
        <button type="button" @click="fermerZones">Annuler</button>
      </div>
      <EditeurZones v-model="zonesFacture.zones" :contenu="zonesFacture.contenu" :automatiques="zonesFacture.automatiques" />
    </template>
  </dialog>
</template>

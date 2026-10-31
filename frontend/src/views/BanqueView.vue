<script setup lang="ts">
import Big from 'big.js'
import Button from 'openvue/button'
import Column from 'openvue/column'
import ConfirmDialog from 'openvue/confirmdialog'
import DataTable from 'openvue/datatable'
import Dialog from 'openvue/dialog'
import IconField from 'openvue/iconfield'
import InputIcon from 'openvue/inputicon'
import InputText from 'openvue/inputtext'
import Menu from 'openvue/menu'
import type { MenuItem } from 'openvue/menuitem'
import Tag from 'openvue/tag'
import Toast from 'openvue/toast'
import { useConfirm } from 'openvue/useconfirm'
import { useToast } from 'openvue/usetoast'
import { computed, nextTick, onMounted, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'

import {
  api, AVEC_DETAIL, AVEC_FACTURE, estRetenue, CATEGORIES_MOUVEMENT, ENERGIES, type CategorieMouvement, type Echeance,
  type Energie, type FactureResumee, type Immeuble, type Lot, type Mouvement, type Paiement, type Regularisation, type ReleveResume,
  type Sejour, type Travaux, type VersementDepot,
} from '../api'
import FormulairePaiement, { type Brouillon, enregistrerBrouillon } from '../components/FormulairePaiement.vue'
import FormulaireTravaux, { type BrouillonTravaux, travauxVersApi } from '../components/FormulaireTravaux.vue'
import { dateFr, euros, nombreFr } from '../format'
import { stateKey } from '../lists'
import { categoriePropose, proposer } from '../rapprochement'

// Categorisation of the bank movements (ADR 0018; the statements are imported in RelevesView): each movement gets a
// category (proposed from its label or the tenant named in it); a tenant payment, works and a deposit have a detail
// (ADR 0019), unfolded under the movement: the payments, works payments or deposits linked to it, added in the same
// forms as the Paiements and Travaux screens, linked when typed before, changed or deleted there; a debit « énergie »,
// « eau » or « impôts » pays invoices of charges (ADR 0022). Three tabs: to categorise; « Rapprochement », the
// categories with a detail (those whose detail does not cover the amount first, « à rattacher »; a note does not
// complete them); the other categories.

type Onglet = 'to_categorise' | 'rapprochement' | 'categorises'

const route = useRoute()
const router = useRouter()
const confirm = useConfirm()
const toast = useToast()

const onglet = ref<Onglet>('to_categorise')
const transactions = ref<Mouvement[]>([])
const statements = ref<ReleveResume[]>([])
const year = ref('')
const releveId = ref<number | null>(null)
const sens = ref<'' | 'credit' | 'debit'>('')
const filtreCategorie = ref<CategorieMouvement | ''>('')
// Rapprochement: only those whose detail does not cover the amount yet
const seulementARattacher = ref(true)
const recherche = ref('')
const occupe = ref(false)
// Rows unfolded (detail of a tenant payment or works), by movement id
const deplies = ref<Record<number, boolean>>({})
// Opened from a payment (?bank_transaction=): highlighted
const surligne = ref<number | null>(null)

// What the proposals and the forms need, every building
const buildings = ref<Immeuble[]>([])
const tenancies = ref<Sejour[]>([])
const rent_schedules = ref<Echeance[]>([])
const charge_adjustments = ref<Regularisation[]>([])
const payments = ref<Paiement[]>([])
const works_invoice = ref<Travaux[]>([])
const invoices = ref<FactureResumee[]>([])
const deposits = ref<VersementDepot[]>([])
const units = ref<Map<number, Lot[]>>(new Map())

const ok = (text: string) => toast.add({ severity: 'success', summary: text, life: 3000 })
const ko = (e: unknown) => toast.add({ severity: 'error', summary: (e as Error).message, life: 6000 })

onMounted(async () => {
  try {
    buildings.value = await api.buildings()
    units.value = new Map(await Promise.all(buildings.value.map(async (i) => [i.id, (await api.building(i.id)).units] as const)))
    await Promise.all([chargerReferentiel(), charger()])
  } catch (e) {
    ko(e)
  }
  await ouvrirMouvement(Number(route.query.bank_transaction))
  // From the page of a statement: its movements
  const releve = Number(route.query.releve)
  if (statements.value.some((r) => r.id === releve)) {
    releveId.value = releve
    year.value = ''
  }
})

async function chargerReferentiel() {
  const parImmeuble = await Promise.all(buildings.value.map(async (i) => ({
    tenancies: await api.tenancies(i.id), rent_schedules: await api.rent_schedules(i.id), charge_adjustments: await api.charge_adjustments(i.id),
    payments: await api.payments(i.id, null), works_invoice: await api.works_invoice(i.id), deposits: await api.deposits(i.id),
    invoices: await api.invoices(i.id),
  })))
  tenancies.value = parImmeuble.flatMap((x) => x.tenancies)
  rent_schedules.value = parImmeuble.flatMap((x) => x.rent_schedules)
  charge_adjustments.value = parImmeuble.flatMap((x) => x.charge_adjustments)
  payments.value = parImmeuble.flatMap((x) => x.payments)
  works_invoice.value = parImmeuble.flatMap((x) => x.works_invoice)
  invoices.value = parImmeuble.flatMap((x) => x.invoices)
  deposits.value = parImmeuble.flatMap((x) => x.deposits)
}

async function charger() {
  ;[transactions.value, statements.value] = await Promise.all([api.transactions('tous'), api.statements()])
  // The statement of the filter deleted (imported again, it has another id): every statement
  if (releveId.value !== null && !statements.value.some((r) => r.id === releveId.value)) {
    releveId.value = null
  }
}

const recharger = () => Promise.all([chargerReferentiel(), charger()])

async function ouvrirMouvement(id: number) {
  const m = transactions.value.find((x) => x.id === id)
  if (!m) {
    return
  }
  year.value = m.transaction_date.slice(0, 4)
  releveId.value = m.bank_statement_id
  onglet.value = ongletDe(m)
  seulementARattacher.value = m.status === 'incomplet'
  surligne.value = m.id
  if (aDetail(m)) {
    deplies.value = { [m.id]: true }
  }
  await nextTick()
  document.querySelector('tr.surligne')?.scrollIntoView({ block: 'center' })
}

// ---------------------------------------------------------------- lists and filters

const estCredit = (m: Mouvement) => new Big(m.amount).gt(0)
const remaining = (m: Mouvement) => new Big(m.amount).abs().minus(m.covered).toString()
const ongletDe = (m: Mouvement): Onglet => (m.status === 'to_categorise' ? 'to_categorise' : aDetail(m) ? 'rapprochement' : 'categorises')
// The filters above the tabs apply to both: year, statement, sense, search
function filtre(m: Mouvement) {
  const text = recherche.value.trim().toUpperCase()
  return (releveId.value === null || m.bank_statement_id === releveId.value)
    && (releveId.value !== null || !year.value || m.transaction_date.startsWith(year.value))
    && (!sens.value || (sens.value === 'credit') === estCredit(m))
    && (!text || `${m.label} ${m.detail ?? ''} ${m.note ?? ''}`.toUpperCase().includes(text))
}
const filtres = computed(() => transactions.value.filter(filtre))
const nombre = (o: Onglet) => filtres.value.filter((m) => ongletDe(m) === o).length
const aRattacher = computed(() => filtres.value.filter((m) => m.status === 'incomplet').length)
const nomCategorie = (c: CategorieMouvement | null) => (c ? CATEGORIES_MOUVEMENT[c].name : '')
const iconeCategorie = (c: CategorieMouvement | null) => (c ? CATEGORIES_MOUVEMENT[c].icone : '')
// A detail to unfold: required (tenant, works, deposit), or the invoices of charges paid (ADR 0022)
const aDetail = (m: Mouvement) => m.category !== null && (AVEC_DETAIL.includes(m.category) || AVEC_FACTURE.includes(m.category))
const payeFactures = (m: Mouvement) => m.category !== null && AVEC_FACTURE.includes(m.category)
/** The category of a debit paying an invoice of this energy. */
const categorieDeFacture = (e: Energie): CategorieMouvement => (e === 'water' ? 'water' : e === 'household_waste' ? 'taxes' : 'energy')

const annees = computed(() => [...new Set(transactions.value.map((m) => m.transaction_date.slice(0, 4)))].sort().reverse())
const relevesDuFiltre = computed(() => statements.value.filter((r) => !year.value || r.statement_date.startsWith(year.value)))
const plusieursComptes = computed(() => new Set(statements.value.map((r) => r.account)).size > 1)

const affiches = computed(() => filtres.value
  .filter((m) => ongletDe(m) === onglet.value
    && (!seulementARattacher.value || onglet.value !== 'rapprochement' || m.status === 'incomplet')
    && (onglet.value === 'to_categorise' || !filtreCategorie.value || m.category === filtreCategorie.value))
  // Those to complete first, then by date (the table keeps this order until a column is sorted)
  .sort((a, b) => Number(b.status === 'incomplet') - Number(a.status === 'incomplet')
    || a.transaction_date.localeCompare(b.transaction_date) || a.bank_statement_id - b.bank_statement_id || a.position - b.position))

// ---------------------------------------------------------------- categories

const proposition = (m: Mouvement) => categoriePropose(m, tenancies.value)

async function agir(action: () => Promise<unknown>, succes: string) {
  occupe.value = true
  try {
    await action()
    ok(succes)
    await recharger()
  } catch (e) {
    ko(e)
  } finally {
    occupe.value = false
  }
}

// A category with a note to type (« autre »), or the note of a categorised movement
const saisieNote = ref<{ bank_transaction: Mouvement, category: CategorieMouvement, note: string, title: string } | null>(null)

function categoriser(m: Mouvement, category: CategorieMouvement) {
  if (category === 'other') {
    saisieNote.value = { bank_transaction: m, category, note: '', title: 'Autre : qu\'est-ce que ce mouvement ?' }
    return
  }
  // A category with a detail (tenant payment, works, invoice…): given later, in « Rapprochement » (to link)
  return agir(() => api.categoriserMouvement(m.id, category),
    AVEC_DETAIL.includes(category) ? `${nomCategorie(category)} : à rattacher dans « Rapprochement »` : nomCategorie(category))
}

function enregistrerNote() {
  const s = saisieNote.value
  if (!s) {
    return
  }
  saisieNote.value = null
  return agir(() => api.categoriserMouvement(s.bank_transaction.id, s.category, s.note.trim() || null), 'Enregistré')
}

// The note of a categorised movement, edited at any time (empty: removed, except for « autre »)
function editerNote(m: Mouvement) {
  saisieNote.value = { bank_transaction: m, category: m.category!, note: m.note ?? '', title: 'Note du mouvement' }
}

const retirerCategorie = (m: Mouvement) => agir(() => api.retirerCategorie(m.id), 'Catégorie retirée')

// The menu of the categories (those that apply to the sense of the movement)
const menuCategories = ref<InstanceType<typeof Menu> | null>(null)
const mouvementDuMenu = ref<Mouvement | null>(null)
const elementsMenu = computed<MenuItem[]>(() => {
  const m = mouvementDuMenu.value
  if (!m) {
    return []
  }
  const credit = estCredit(m)
  return (Object.keys(CATEGORIES_MOUVEMENT) as CategorieMouvement[])
    .filter((code) => CATEGORIES_MOUVEMENT[code].sens === 'tous' || (CATEGORIES_MOUVEMENT[code].sens === 'credit') === credit)
    .map((code) => ({ label: nomCategorie(code), icon: iconeCategorie(code), command: () => categoriser(m, code) }))
})
function ouvrirMenu(event: Event, m: Mouvement) {
  mouvementDuMenu.value = m
  menuCategories.value?.toggle(event)
}

// ---------------------------------------------------------------- detail: payments of a tenant, works, deposits

const paiementsDe = (m: Mouvement) => payments.value.filter((p) => p.bank_transaction_id === m.id)
const totalPaiement = (p: Paiement) => new Big(p.rent).plus(p.charge_advance).plus(p.charge_adjustment).toString()
const moisFr = (month: string | null) => (month ? `${month.slice(5, 7)}/${month.slice(0, 4)}` : 'régularisation')
const contexte = (m: Mouvement) => ({ label: m.label, date: m.transaction_date, amount: m.amount, covered: m.covered })

/**
 * Payments or works typed by hand that may be this movement: the server's « possibles » (same amount, ten days), of
 * the tenant named; and the payment of that tenant for the month of the transfer, of the same amount, typed later.
 */
function candidates(m: Mouvement) {
  const p = proposer(m, tenancies.value, rent_schedules.value, charge_adjustments.value)
  const tenancy = p.tenancy
  const siens = tenancy ? m.candidates.filter((x) => (x.type === 'payment' || x.type === 'group') && x.tenant === tenancy.tenant) : []
  const liste: Possible[] = siens.length ? siens : [...m.candidates]
  if (tenancy && m.status !== 'categorise') {
    for (const x of payments.value.filter((y) => !y.bank_transaction_id && y.tenancy_id === tenancy.id && y.month?.slice(0, 7) === p.month
      && new Big(totalPaiement(y)).eq(remaining(m)))) {
      if (!liste.some((l) => l.type === 'payment' && l.id === x.id)) {
        liste.push({ type: 'payment', id: x.id, tenant: x.tenant, unit: x.unit, month: x.month, date: x.payment_date })
      }
    }
  }
  return liste
}
// What the « Rattacher » button links, and how many typed by hand match
const NOMS_SAISIS: Record<string, string> = {
  tenant: 'Paiement saisi', works: 'Facture de travaux', security_deposit: 'Dépôt saisi', energy: 'Facture', water: 'Facture', taxes: 'Facture',
}
function libelleRattacher(m: Mouvement) {
  const name = payeFactures(m) ? 'Rattacher à une facture…'
    : { tenant: 'Rattacher à un paiement existant…', works: 'Rattacher à une facture de travaux…' }[m.category as string]
      ?? 'Rattacher à un dépôt saisi…'
  const n = correspondances(m)
  return n ? `${name} ✓ ${n} correspond${n > 1 ? 'ent' : ''}` : name
}

// A deposit typed by hand, to link (« depot_garantie »)
type Possible = Mouvement['candidates'][number] | { type: 'deposit', id: number }
const lien = (p: Possible) =>
  p.type === 'group' ? { payment_ids: p.ids } : p.type === 'payment' ? { payment_id: p.id }
    : p.type === 'deposit' ? { deposit_payment_id: p.id } : p.type === 'invoice' ? { invoice_id: p.id } : { works_invoice_id: p.id }
const clePossible = (p: Possible) => (p.type === 'group' ? `g${p.ids.join('-')}` : `${p.type}${p.id}`)
function libellePossible(p: Possible) {
  if (p.type === 'deposit') {
    return 'dépôt de garantie'
  }
  if (p.type === 'works') {
    return `${p.supplier} : ${p.description}`
  }
  if (p.type === 'invoice') {
    return `${p.supplier} n° ${p.number}${p.status === 'draft' ? ' (brouillon)' : ''}`
  }
  if (p.type === 'group') {
    return `${p.tenant}, ${p.ids.length} paiements : ${p.month}`
  }
  return `${p.tenant}, ${moisFr(p.month)}`
}

// The category proposed for a movement to categorise: that of the payment or works typed by hand that match it (its
// detail, linked once categorised), else the category read in its label or the tenant named in it
function proposee(m: Mouvement): CategorieMouvement | null {
  const candidats = candidates(m)
  if (candidats.some((c) => c.type === 'payment' || c.type === 'group')) {
    return 'tenant'
  }
  if (candidats.some((c) => c.type === 'works')) {
    return 'works'
  }
  const invoice = candidats.find((c) => c.type === 'invoice')
  return invoice?.type === 'invoice' ? categorieDeFacture(invoice.energy) : proposition(m)
}

/** The one invoice of charges whose rest is the amount of the debit: accepting the proposal links it too (ADR 0022). */
function factureProposee(m: Mouvement) {
  const memeMontant = m.candidates.filter((c): c is Extract<typeof c, { type: 'invoice' }> => c.type === 'invoice'
    && new Big(invoices.value.find((f) => f.id === c.id)?.remaining ?? 0).eq(new Big(m.amount).abs()))
  return memeMontant.length === 1 && proposee(m) !== 'tenant' && proposee(m) !== 'works' ? memeMontant[0]!.id : null
}

/** The proposal of a movement to categorise: its category, and its invoice when one has its amount. */
function accepter(m: Mouvement) {
  const invoice = factureProposee(m)
  return invoice ? agir(() => api.lierMouvement(m.id, { invoice_id: invoice }), 'Facture rattachée') : categoriser(m, proposee(m)!)
}
const libelleProposition = (m: Mouvement) => `${nomCategorie(proposee(m))}${factureProposee(m) ? ' + facture' : ''}`

// Every category proposed on the rows shown, in one go (the history): the same as clicking each button of the column
const avecProposition = computed(() => (onglet.value === 'to_categorise' ? affiches.value.filter((m) => proposee(m)) : []))
function accepterTout() {
  const liste = avecProposition.value.map((m) => ({ m, c: proposee(m)! }))
  confirm.require({
    message: `Catégoriser ${liste.length} mouvement(s) selon la catégorie proposée ? Les paiements de locataire et les travaux
      seront à rattacher dans l'onglet « Rapprochement ».`,
    header: 'Accepter les propositions', acceptLabel: 'Catégoriser', rejectLabel: 'Annuler',
    accept: () => agir(async () => {
      for (const { m, c } of liste) {
        const invoice = factureProposee(m)
        await (invoice ? api.lierMouvement(m.id, { invoice_id: invoice }) : api.categoriserMouvement(m.id, c))
      }
    }, `${liste.length} mouvement(s) catégorisé(s)`),
  })
}

/** « Rapprochement », those to link only. */
function voirARattacher() {
  onglet.value = 'rapprochement'
  seulementARattacher.value = true
}

// Unfold the detail of a movement (tenant payment, works)
const basculer = (m: Mouvement) => {
  const d = { ...deplies.value }
  if (d[m.id]) {
    delete d[m.id]
  } else {
    d[m.id] = true
  }
  deplies.value = d
}

// « Rattacher à un existant »: the payments (or works) not linked, of a smaller amount, close in time; those of the
// tenant named first
/** How many payments or works typed by hand match the movement (shown on the button that links them). */
const correspondances = (m: Mouvement) => (m.category === 'security_deposit'
  ? depotsLibres(m).filter((d) => new Big(d.amount).abs().eq(remaining(m))).length
  : candidates(m).filter((p) => (payeFactures(m) ? p.type === 'invoice'
    : m.category === 'works' ? p.type === 'works' : p.type === 'payment' || p.type === 'group')).length)

/** Deposits typed by hand, not linked, of the sign of the movement. */
const depotsLibres = (m: Mouvement) => deposits.value.filter((d) => !d.bank_transaction_id && new Big(d.amount).gt(0) === estCredit(m))

// The list offers everything typed by hand and not linked (works; payments of the tenant named, else all): no filter
// on amount or date (a deposit, a transfer before the invoice). What matches the movement (same amount, close date, or
// several payments adding up to it) is marked, first, and chosen; the others by closeness of date. The choice gets
// warnings, not a refusal: amount different from the rest, date far from the movement.
type Choix = { cle: string, text: string, correspond: boolean, lien: Possible, amount: string | null, date: string | null }
const rattachement = ref<{ bank_transaction: Mouvement, choix: Choix[], cle: string | null } | null>(null)
const ecartJours = (m: Mouvement, date: string | null) =>
  (date ? Math.round(Math.abs(new Date(date).getTime() - new Date(m.transaction_date).getTime()) / 864e5) : null)
function ouvrirRattachement(m: Mouvement) {
  const correspondants = candidates(m)
  const correspond = (l: Possible) => correspondants.some((c) => clePossible(c) === clePossible(l))
  let choix: Choix[]
  if (payeFactures(m)) {
    // Validated invoices of the energies of the category: a debit pays their rest, or a part of it (those not paid in
    // full); a credit refunds one (any, the latest first)
    // (a draft with a total too: an invoice still to find, typed from the transfer)
    choix = invoices.value.filter((f) => (f.status === 'validated' || (f.status === 'draft' && f.total_incl_tax !== null))
      && (estCredit(m) || Number(f.remaining) > 0) && categorieDeFacture(f.energy) === m.category)
      .map((f) => {
        const l: Possible = { type: 'invoice', id: f.id, supplier: f.supplier, number: f.number, energy: f.energy, date: f.invoice_date, status: f.status }
        return {
          cle: clePossible(l),
          text: `${f.supplier} n° ${f.number}${f.status === 'draft' ? ' (brouillon)' : ''} (${ENERGIES[f.energy]}), du ${dateFr(f.invoice_date)} de ${euros(f.total_incl_tax)}`
            + (Number(f.paid) > 0 ? `, reste ${euros(f.remaining)}` : ''),
          correspond: correspond(l), lien: l, amount: f.remaining, date: f.invoice_date,
        }
      })
  } else if (m.category === 'works') {
    // Invoices not paid in full: this movement pays their rest, or a part of it
    choix = works_invoice.value.filter((t) => Number(t.remaining) > 0).map((t) => {
      const l: Possible = { type: 'works', id: t.id, description: t.description, supplier: t.supplier, date: t.invoice_date }
      return {
        cle: clePossible(l),
        text: `${t.supplier} : ${t.description}, facture du ${dateFr(t.invoice_date)} de ${euros(t.total_incl_tax)}`
          + (Number(t.paid) > 0 ? `, reste ${euros(t.remaining)}` : ''),
        correspond: correspond(l), lien: l, amount: t.remaining, date: t.invoice_date,
      }
    })
  } else if (m.category === 'security_deposit') {
    choix = depotsLibres(m).map((d) => {
      const l: Possible = { type: 'deposit', id: d.id }
      return {
        cle: clePossible(l), text: `${d.tenant} (${d.unit}), ${dateFr(d.payment_date)} : ${euros(d.amount)}`,
        correspond: new Big(d.amount).abs().eq(remaining(m)), lien: l, amount: new Big(d.amount).abs().toString(), date: d.payment_date,
      }
    })
  } else {
    const tenancy = proposer(m, tenancies.value, rent_schedules.value, charge_adjustments.value).tenancy
    const libres = payments.value.filter((p) => !p.bank_transaction_id && !estRetenue(p) && new Big(totalPaiement(p)).gt(0) === estCredit(m))
    const siens = tenancy ? libres.filter((p) => p.tenancy_id === tenancy.id) : []
    choix = [
      // Several payments adding up to the transfer (several months)
      ...correspondants.filter((c) => c.type === 'group').map((c) => ({
        cle: clePossible(c), text: libellePossible(c), correspond: true, lien: c, amount: null, date: null,
      })),
      ...(siens.length ? siens : libres).map((p) => {
        const l: Possible = { type: 'payment', id: p.id, tenant: p.tenant, unit: p.unit, month: p.month, date: p.payment_date }
        return {
          cle: clePossible(l), text: `${p.tenant}, ${moisFr(p.month)}, saisi le ${dateFr(p.payment_date)} : ${euros(totalPaiement(p))}`,
          correspond: correspond(l), lien: l, amount: new Big(totalPaiement(p)).abs().toString(), date: p.payment_date,
        }
      }),
    ]
  }
  choix.sort((a, b) => Number(b.correspond) - Number(a.correspond)
    || (ecartJours(m, a.date) ?? 9999) - (ecartJours(m, b.date) ?? 9999))
  rattachement.value = { bank_transaction: m, choix, cle: choix[0]?.cle ?? null }
}

/** Warnings on the choice: an amount different from the rest of the movement, a date far from it. */
const alertes = computed(() => {
  const r = rattachement.value
  const c = r?.choix.find((x) => x.cle === r.cle)
  if (!r || !c || c.correspond) {
    return []
  }
  const liste: string[] = []
  const resteMouvement = new Big(remaining(r.bank_transaction))
  if (c.amount !== null && !new Big(c.amount).eq(resteMouvement)) {
    liste.push(new Big(c.amount).gt(resteMouvement)
      ? `${euros(c.amount)} pour un reste de ${euros(resteMouvement.toString())} : ce virement n'en paie qu'une partie (acompte) ?`
      : `${euros(c.amount)} sur un reste de ${euros(resteMouvement.toString())} : le reste sera à rattacher`)
  }
  const days = ecartJours(r.bank_transaction, c.date)
  if (days !== null && days > 31) {
    liste.push(`${days} jours d'écart avec le mouvement : paiement en avance, ou facture reçue après ?`)
  }
  return liste
})
function rattacher() {
  const r = rattachement.value
  const choisi = r?.choix.find((c) => c.cle === r.cle)
  if (!r || !choisi) {
    return
  }
  rattachement.value = null
  return agir(() => api.lierMouvement(r.bank_transaction.id, lien(choisi.lien)), 'Rattaché')
}

const detacher = (m: Mouvement, l: { payment_id: number } | { works_invoice_payment_id: number } | { invoice_payment_id: number } | { deposit_payment_id: number }) =>
  agir(() => api.delierMouvement(m.id, l), 'Détaché (gardé dans son écran)')

// ---------------------------------------------------------------- forms (the same as the Paiements and Travaux screens)

const formulairePaiement = ref<{ brouillon: Brouillon, bank_transaction: Mouvement } | null>(null)
const formulaireTravaux = ref<{ brouillon: BrouillonTravaux, bank_transaction: Mouvement } | null>(null)
const erreurFormulaire = ref<string | null>(null)

/** The building of a stay (the forms read the amounts called of its building). */
function immeubleDuSejour(id: number | null) {
  const s = tenancies.value.find((x) => x.id === id)
  for (const [building, l] of units.value) {
    if (s && l.some((x) => x.id === s.unit_id)) {
      return building
    }
  }
  return buildings.value[0]?.id ?? 0
}

function nouveauPaiement(m: Mouvement) {
  const p = proposer(m, tenancies.value, rent_schedules.value, charge_adjustments.value, payments.value)
  const credit = estCredit(m)
  // The month is already paid: nothing proposed, and said (link the payment typed, or change the month)
  const dejaPaye = Boolean(p.ecart?.includes('déjà payé'))
  formulairePaiement.value = {
    bank_transaction: m,
    brouillon: {
      id: null, date: m.transaction_date, tenancy_id: p.tenancy?.id ?? null, month: p.month,
      amount: nombreFr(`${credit ? '' : '-'}${new Big(remaining(m)).toFixed(2)}`),
      rent: credit && !dejaPaye ? nombreFr(new Big(p.rent).toFixed(2)) : '',
      charge_advance: credit && !dejaPaye ? nombreFr(new Big(p.charge_advance).toFixed(2)) : '',
      versements: p.charge_adjustment_id ? [{ charge_adjustment_id: p.charge_adjustment_id, amount: nombreFr(p.charge_adjustment) }] : [],
      method: 'transfer', note: '',
    },
  }
  erreurFormulaire.value = dejaPaye
    ? `${p.ecart} : rattacher plutôt le paiement déjà saisi (bouton vert sous le mouvement), ou choisir un autre mois`
    : null
}

function modifierPaiement(m: Mouvement, p: Paiement) {
  formulairePaiement.value = {
    bank_transaction: m,
    brouillon: {
      id: p.id, date: p.payment_date, tenancy_id: p.tenancy_id, month: p.month?.slice(0, 7) ?? '',
      amount: nombreFr(new Big(totalPaiement(p)).toFixed(2)), rent: nombreFr(p.rent), charge_advance: nombreFr(p.charge_advance),
      versements: p.charge_adjustment_id ? [{ charge_adjustment_id: p.charge_adjustment_id, amount: nombreFr(p.charge_adjustment) }] : [],
      method: p.method ?? '', note: p.note ?? '',
    },
  }
  erreurFormulaire.value = null
}

async function enregistrerPaiement(suivant: boolean) {
  const f = formulairePaiement.value!
  const b = f.brouillon
  occupe.value = true
  try {
    // A rest left (a deposit paid with the first rent…) stays to complete: « Dépôt de garantie… » then
    await enregistrerBrouillon(b, f.bank_transaction.id)
    await recharger()
    const m = transactions.value.find((x) => x.id === f.bank_transaction.id)!
    formulairePaiement.value = null
    // « Ajouter et en saisir un autre »: the next one on what remains of the transfer
    if (suivant && new Big(remaining(m)).gt(0) && m.status === 'incomplet') {
      nouveauPaiement(m)
    }
    ok('Paiement enregistré')
  } catch (e) {
    erreurFormulaire.value = (e as Error).message
  } finally {
    occupe.value = false
  }
}

function supprimerPaiement(p: Paiement | undefined) {
  if (!p) {
    return
  }
  confirm.require({
    message: `Supprimer le paiement ${moisFr(p.month)} de ${p.tenant} (${euros(totalPaiement(p))}) ?`,
    header: 'Supprimer', acceptLabel: 'Supprimer', rejectLabel: 'Annuler', acceptClass: 'p-button-danger',
    accept: () => {
      formulairePaiement.value = null
      return agir(() => api.supprimerPaiement(p.id), 'Paiement supprimé')
    },
  })
}

function modifierTravaux(m: Mouvement, t: Travaux) {
  formulaireTravaux.value = {
    bank_transaction: m,
    brouillon: {
      id: t.id, building_id: t.building_id, unit_id: t.unit_id, supplier: t.supplier, description: t.description,
      nature: t.nature, invoice_date: t.invoice_date, total_incl_tax: nombreFr(t.total_incl_tax), note: t.note ?? '', pdf: null,
    },
  }
  erreurFormulaire.value = null
}

// The invoice changed (its payments are the movements linked); its PDF attached or replaced
async function enregistrerTravaux() {
  const b = formulaireTravaux.value!.brouillon
  occupe.value = true
  try {
    await api.modifierTravaux(b.id!, travauxVersApi(b))
    if (b.pdf) {
      await api.joindrePdfTravaux(b.id!, b.pdf)
    }
    formulaireTravaux.value = null
    await recharger()
    ok('Facture de travaux enregistrée')
  } catch (e) {
    erreurFormulaire.value = (e as Error).message
  } finally {
    occupe.value = false
  }
}

function supprimerTravaux(t: Travaux | undefined) {
  if (!t) {
    return
  }
  confirm.require({
    message: `Supprimer les travaux « ${t.description} » (${euros(t.total_incl_tax)}) ?`,
    header: 'Supprimer', acceptLabel: 'Supprimer', rejectLabel: 'Annuler', acceptClass: 'p-button-danger',
    accept: () => {
      formulaireTravaux.value = null
      return agir(() => api.supprimerTravaux(t.id), 'Travaux supprimés')
    },
  })
}

// ---------------------------------------------------------------- deposits (ADR 0019, 0021)

// A deposit is managed from the stay (Locataires): the transfer opens its window there, prefilled; the stay is the
// tenant named in the label, else chosen there
function versDepot(m: Mouvement) {
  const tenancy = proposer(m, tenancies.value, rent_schedules.value, charge_adjustments.value).tenancy
  router.push({ path: '/sejours', query: {
    depot: estCredit(m) ? 'recu' : 'restitution', bank_transaction: m.id, date: m.transaction_date,
    amount: new Big(remaining(m)).toFixed(2), ...(tenancy ? { tenancy: tenancy.id } : {}),
  } })
}

/** The form of the stay of a deposit linked to the movement, with its deposit. */
const voirDepot = (sejourId: number) => router.push({ path: '/sejours', query: { depot: 'voir', tenancy: sejourId } })

const ONGLETS: { code: Onglet, name: string, title: string }[] = [
  { code: 'to_categorise', name: 'À catégoriser', title: 'Les mouvements sans catégorie' },
  { code: 'rapprochement', name: 'Rapprochement', title: 'Paiements de locataire, travaux, dépôts, factures d\'énergie, d\'eau, de taxes : rattachés à ce qu\'ils paient' },
  { code: 'categorises', name: 'Autres catégories', title: 'Emprunt, assurance, frais bancaires… : une catégorie suffit' },
]
// The categories of the filter: those of the tab shown
const categoriesDuFiltre = computed(() => (Object.keys(CATEGORIES_MOUVEMENT) as CategorieMouvement[])
  .filter((c) => (onglet.value === 'rapprochement') === (AVEC_DETAIL.includes(c) || AVEC_FACTURE.includes(c))))
const ligneSurlignee = (m: Mouvement) => (m.id === surligne.value ? 'surligne' : '')
</script>

<template>
  <Toast />
  <ConfirmDialog />
  <Menu ref="menuCategories" :model="elementsMenu" :popup="true" />

  <section class="entete-page">
    <h1>Catégorisation des mouvements</h1>
  </section>
  <p class="discret">
    Les mouvements des <RouterLink :to="{ name: 'statements' }">relevés bancaires</RouterLink> : chacun reçoit une catégorie.
    Un paiement de locataire, des travaux, un dépôt, un prélèvement d'énergie, d'eau ou de taxe se rattachent à ce
    qu'ils paient (onglet « Rapprochement ») : dépliez la ligne pour ajouter, rattacher, modifier.
  </p>


  <!-- ---------------------------------------------------------------- movements -->
  <template v-if="transactions">
    <section class="filtres">
      <IconField>
        <InputIcon class="oi oi-search" />
        <InputText v-model="recherche" placeholder="Rechercher (libellé, détail)" size="small" />
      </IconField>
      <select v-model="year" aria-label="Année">
        <option value="">Toutes les années</option>
        <option v-for="a in annees" :key="a" :value="a">{{ a }}</option>
      </select>
      <select v-model="releveId" aria-label="Relevé">
        <option :value="null">Tous les relevés</option>
        <option v-for="r in relevesDuFiltre" :key="r.id" :value="r.id">Relevé du {{ dateFr(r.statement_date) }}{{ plusieursComptes ? ` (${r.account})` : '' }}</option>
      </select>
      <select v-model="sens" aria-label="Sens">
        <option value="">Crédits et débits</option>
        <option value="credit">Crédits</option>
        <option value="debit">Débits</option>
      </select>
    </section>

    <nav class="onglets">
      <button v-for="o in ONGLETS" :key="o.code" type="button" :class="{ actif: onglet === o.code }" :title="o.title" @click="onglet = o.code; filtreCategorie = ''">
        {{ o.name }} ({{ nombre(o.code) }})
        <span v-if="o.code === 'rapprochement' && aRattacher" class="a-completer">{{ aRattacher }} à rattacher</span>
      </button>
    </nav>
    <p v-if="onglet === 'to_categorise' && aRattacher" class="message avertissement a-completer-message">
      Attention : {{ aRattacher }} mouvement(s) catégorisé(s) attendent d'être rattachés (paiement de locataire, facture,
      travaux, dépôt). <a href="#" @click.prevent="voirARattacher">Les rattacher</a>
    </p>
    <section class="filtres outils-onglet">
      <select v-if="onglet !== 'to_categorise'" v-model="filtreCategorie" aria-label="Catégorie">
        <option value="">Toutes les catégories</option>
        <option v-for="code in categoriesDuFiltre" :key="code" :value="code">{{ nomCategorie(code) }}</option>
      </select>
      <label v-if="onglet === 'rapprochement'" class="case">
        <input v-model="seulementARattacher" type="checkbox"> Seulement ceux à rattacher ({{ aRattacher }})
      </label>
      <span class="discret">{{ affiches.length }} mouvement(s)</span>
      <Button
        v-if="avecProposition.length > 1" :label="`Accepter les ${avecProposition.length} propositions`" icon="oi oi-check"
        size="small" outlined :disabled="occupe" @click="accepterTout"
      />
    </section>

    <DataTable
      v-model:expanded-rows="deplies" :value="affiches" data-key="id" size="small" paginator :rows="50"
      :rows-per-page-options="[25, 50, 100, 500]" :row-class="ligneSurlignee"
      state-storage="session" :state-key="stateKey('bank')" class="mouvements"
    >
      <template #empty>Aucun mouvement.</template>
      <!-- The arrow, on the categorised movements that have a detail only -->
      <Column v-if="onglet === 'rapprochement'" style="width: 2.5rem">
        <template #body="{ data }">
          <Button
            v-if="aDetail(data)" :icon="deplies[data.id] ? 'oi oi-chevron-down' : 'oi oi-chevron-right'" size="small" text
            rounded severity="secondary" :aria-label="deplies[data.id] ? 'Replier' : 'Déplier'" @click="basculer(data)"
          />
        </template>
      </Column>
      <Column field="transaction_date" header="Date" sortable style="width: 7rem">
        <template #body="{ data }">{{ dateFr(data.transaction_date) }}</template>
      </Column>
      <Column header="Opération">
        <template #body="{ data }">
          <strong>{{ data.label }}</strong>
          <div v-if="data.detail" class="detail-mouvement" :title="data.detail">{{ data.detail.split('\n').slice(0, 3).join(' · ') }}</div>
        </template>
      </Column>
      <Column field="amount" header="Montant" sortable body-class="nombre" header-class="nombre" style="width: 9rem">
        <template #body="{ data }">
          <span :class="estCredit(data) ? 'ok' : ''">{{ estCredit(data) ? '+' : '' }}{{ euros(data.amount) }}</span>
          <div v-if="data.status === 'incomplet'" class="discret">reste {{ euros(remaining(data)) }}</div>
        </template>
      </Column>
      <Column header="Relevé" style="width: 7.5rem">
        <template #body="{ data }">
          <RouterLink
            :to="{ name: 'bank_statement', params: { id: data.bank_statement_id }, query: { bank_transaction: data.id } }" class="lien-releve"
            title="Ouvrir le relevé, ce mouvement surligné" @click.stop
          ><i class="oi oi-file-pdf" /> {{ dateFr(data.statement_date) }}</RouterLink>
        </template>
      </Column>
      <!-- To categorise: the proposal (one button), then any other category -->
      <Column v-if="onglet === 'to_categorise'" header="Proposition" style="width: 22rem">
        <template #body="{ data }">
          <Button
            v-if="proposee(data)" :label="libelleProposition(data)" :icon="iconeCategorie(proposee(data))" size="small"
            :disabled="occupe" @click="accepter(data)"
          />
          <span v-else class="discret">—</span>
        </template>
      </Column>
      <Column v-if="onglet === 'to_categorise'" style="width: 11rem">
        <template #body="{ data }">
          <Button
            label="Autre catégorie" icon="oi oi-angle-down" icon-pos="right" size="small" severity="secondary" outlined
            :disabled="occupe" @click="ouvrirMenu($event, data)"
          />
        </template>
      </Column>
      <!-- Categorised: the category, ✕ to take it back; then its note, ✎ to edit it -->
      <Column v-if="onglet !== 'to_categorise'" header="Catégorie" style="width: 23rem">
        <template #body="{ data }">
          <div class="categorie">
            <Tag :value="nomCategorie(data.category)" :icon="iconeCategorie(data.category)" severity="info" />
            <Tag v-if="data.status === 'incomplet'" value="à rattacher" severity="warn" />
            <Tag v-if="data.invoices.length" value="facture" icon="oi oi-link" severity="success" :title="data.invoices.map((f: Mouvement['invoices'][number]) => `${f.supplier} n° ${f.number}`).join(', ')" />
            <Button
              icon="oi oi-times" size="small" text rounded severity="secondary"
              :disabled="occupe || data.payments.length > 0 || data.works_invoices.length > 0 || data.invoices.length > 0"
              :title="data.payments.length || data.works_invoices.length || data.invoices.length ? 'Détacher d\'abord le détail (paiements, travaux, factures)' : 'Retirer la catégorie'"
              @click="retirerCategorie(data)"
            />
          </div>
        </template>
      </Column>
      <Column v-if="onglet !== 'to_categorise'" header="Note" style="width: 18rem">
        <template #body="{ data }">
          <div class="note-cellule">
            <span class="discret note">{{ data.note }}</span>
            <Button
              icon="oi oi-pencil" size="small" text rounded severity="secondary" :disabled="occupe"
              :title="data.note ? 'Modifier la note' : 'Ajouter une note'" @click.stop="editerNote(data)"
            />
          </div>
        </template>
      </Column>

      <!-- The detail of a movement: its payments or works, the actions to complete it -->
      <template #expansion="{ data }">
        <div class="deplie">
          <template v-if="aDetail(data)">
            <p class="resume">
              {{ estCredit(data) ? 'Virement reçu' : 'Débit' }} de {{ euros(data.amount) }} · rapproché {{ euros(data.covered) }}
              · <strong :class="Number(remaining(data)) > 0 ? 'ko' : 'ok'">reste {{ euros(remaining(data)) }}</strong>
            </p>
            <ul class="liens">
              <li v-for="p in paiementsDe(data)" :key="`p${p.id}`">
                <span class="oi oi-user" />
                <span>
                  {{ p.tenant }}, {{ moisFr(p.month) }} :
                  <template v-if="p.month">loyer {{ euros(p.rent) }} + provision {{ euros(p.charge_advance) }}</template>
                  <template v-if="p.charge_adjustment_id">{{ p.month ? ' + ' : '' }}régularisation {{ euros(p.charge_adjustment) }}</template>
                  = <strong>{{ euros(totalPaiement(p)) }}</strong>
                </span>
                <Button label="Modifier" size="small" text :disabled="occupe" @click="modifierPaiement(data, p)" />
                <Button label="Détacher" size="small" text severity="secondary" :disabled="occupe" @click="detacher(data, { payment_id: p.id })" />
                <Button label="Supprimer" size="small" text severity="danger" :disabled="occupe" @click="supprimerPaiement(p)" />
              </li>
              <li v-for="t in data.works_invoices" :key="`t${t.works_invoice_payment_id}`">
                <span class="oi oi-hammer" />
                <span>
                  {{ t.supplier }} : {{ t.description }} : règlement de <strong>{{ euros(t.total) }}</strong>
                  <span class="discret">
                    (facture de {{ euros(t.total_incl_tax) }}{{ Number(t.remaining) > 0 ? `, reste ${euros(t.remaining)} à payer` : ', payée en entier' }})
                  </span>
                </span>
                <Button label="Modifier" size="small" text :disabled="occupe" @click="modifierTravaux(data, works_invoice.find((x) => x.id === t.id)!)" />
                <Button label="Détacher" size="small" text severity="secondary" :disabled="occupe" @click="detacher(data, { works_invoice_payment_id: t.works_invoice_payment_id })" />
                <Button label="Supprimer" size="small" text severity="danger" :disabled="occupe" @click="supprimerTravaux(works_invoice.find((x) => x.id === t.id))" />
              </li>
              <li v-for="f in data.invoices" :key="`f${f.invoice_payment_id}`">
                <span class="oi oi-file" />
                <span>
                  {{ f.supplier }} n° {{ f.number }} ({{ ENERGIES[f.energy as Energie] }}) :
                  {{ Number(f.total) < 0 ? 'remboursement de' : 'règlement de' }} <strong>{{ euros(new Big(f.total).abs().toString()) }}</strong>
                  <span class="discret">
                    (facture du {{ dateFr(f.invoice_date) }} de {{ euros(f.total_incl_tax) }}{{ Number(f.remaining) > 0 ? `, reste ${euros(f.remaining)} à payer` : ', payée en entier' }})
                  </span>
                </span>
                <RouterLink :to="{ name: 'invoice', params: { id: f.id } }" class="petit">Voir la facture</RouterLink>
                <Button label="Détacher" size="small" text severity="secondary" :disabled="occupe" @click="detacher(data, { invoice_payment_id: f.invoice_payment_id })" />
              </li>
              <li v-for="d in data.deposits" :key="`d${d.id}`">
                <span class="oi oi-key" />
                <span>
                  Dépôt de garantie de {{ d.tenant }} ({{ d.unit }}) :
                  {{ Number(d.amount) > 0 ? 'versé' : 'remboursé' }} <strong>{{ euros(new Big(d.amount).abs().toString()) }}</strong>
                </span>
                <Button label="Voir le dépôt" size="small" text :disabled="occupe" @click="voirDepot(d.tenancy_id)" />
                <Button label="Détacher" size="small" text severity="secondary" :disabled="occupe" @click="detacher(data, { deposit_payment_id: d.id })" />
              </li>
              <li v-if="!data.payments.length && !data.works_invoices.length && !data.invoices.length && !data.deposits.length" class="discret">Rien de rattaché pour l'instant.</li>
            </ul>
            <div class="actions-detail">
              <Button
                v-if="data.category === 'tenant'" label="Ajouter un paiement du locataire…" icon="oi oi-plus" size="small"
                :disabled="occupe || Number(remaining(data)) <= 0" @click="nouveauPaiement(data)"
              />
              <Button
                v-if="data.category === 'tenant' || data.category === 'security_deposit'" label="Dépôt de garantie…"
                title="Le dépôt se saisit dans l'écran Locataires : ouvert sur le séjour, ce virement prérempli"
                icon="oi oi-key" size="small" :outlined="data.category === 'tenant'"
                :disabled="occupe || Number(remaining(data)) <= 0" @click="versDepot(data)"
              />
              <Button
                :label="libelleRattacher(data)"
                :icon="correspondances(data) ? 'oi oi-link' : 'oi oi-search'" size="small" outlined
                :severity="correspondances(data) ? 'success' : undefined" :disabled="occupe || Number(remaining(data)) <= 0"
                @click="ouvrirRattachement(data)"
              />
            </div>
            <form v-if="rattachement && rattachement.bank_transaction.id === data.id" class="formulaire" @submit.prevent="rattacher">
              <label v-if="rattachement.choix.length">{{ NOMS_SAISIS[data.category] }}
                <select v-model="rattachement.cle" required>
                  <option v-for="c in rattachement.choix" :key="c.cle" :value="c.cle">{{ c.correspond ? '✓ correspond · ' : '' }}{{ c.text }}</option>
                </select>
              </label>
              <span v-else class="discret">Rien de saisi qui ne soit déjà rattaché.</span>
              <span v-if="rattachement.choix.some((c) => c.correspond)" class="ok petit">✓ : même montant, à la date du mouvement</span>
              <span v-for="(a, i) in alertes" :key="i" class="alerte petit">⚠ {{ a }}</span>
              <Button type="submit" label="Rattacher" size="small" :disabled="occupe || !rattachement.cle" />
              <Button label="Annuler" size="small" text @click="rattachement = null" />
            </form>
          </template>
          <p v-else class="discret">
            {{ data.category ? `${nomCategorie(data.category)} : pas de détail à saisir.` : 'Pas encore de catégorie.' }}
            <span v-if="data.detail" class="pre">{{ data.detail }}</span>
          </p>
        </div>
      </template>
    </DataTable>
  </template>

  <!-- A note: « autre », or the note of a movement (modal, in the middle of the screen) -->
  <Dialog
    :visible="saisieNote !== null" modal :header="saisieNote?.title" :style="{ width: '34rem' }"
    @update:visible="(v: boolean) => { if (!v) saisieNote = null }"
  >
    <form v-if="saisieNote" class="note-form" @submit.prevent="enregistrerNote">
      <p class="discret">{{ saisieNote.bank_transaction.label }} du {{ dateFr(saisieNote.bank_transaction.transaction_date) }} : {{ euros(saisieNote.bank_transaction.amount) }}</p>
      <InputText v-model="saisieNote.note" :required="saisieNote.category === 'other'" autofocus placeholder="dépôt de garantie, apport des associés…" fluid />
      <p v-if="saisieNote.category !== 'other'" class="discret">Vide : la note est retirée.</p>
      <div class="actions-detail fin">
        <Button label="Annuler" text @click="saisieNote = null" />
        <Button type="submit" label="Enregistrer" :disabled="occupe || (saisieNote.category === 'other' && !saisieNote.note.trim())" />
      </div>
    </form>
  </Dialog>

  <FormulairePaiement
    v-if="formulairePaiement"
    :key="formulairePaiement.brouillon.id ?? `nouveau-${formulairePaiement.bank_transaction.id}-${formulairePaiement.bank_transaction.covered}`"
    v-model="formulairePaiement.brouillon"
    :building="immeubleDuSejour(formulairePaiement.brouillon.tenancy_id)"
    :tenancies="tenancies"
    :charge_adjustments="charge_adjustments"
    :rent_schedules="rent_schedules"
    :payments="payments"
    :occupe="occupe"
    :erreur="erreurFormulaire"
    :bank_transaction="contexte(formulairePaiement.bank_transaction)"
    @enregistrer="enregistrerPaiement"
    @fermer="formulairePaiement = null"
    @supprimer="supprimerPaiement(payments.find((p) => p.id === formulairePaiement?.brouillon.id))"
  />
  <FormulaireTravaux
    v-if="formulaireTravaux"
    :key="formulaireTravaux.brouillon.id ?? 0"
    v-model="formulaireTravaux.brouillon"
    :buildings="buildings"
    :units="units"
    :occupe="occupe"
    :erreur="erreurFormulaire"
    :works_invoice="works_invoice.find((t) => t.id === formulaireTravaux?.brouillon.id) ?? null"
    @change="recharger"
    @enregistrer="enregistrerTravaux"
    @fermer="formulaireTravaux = null"
    @supprimer="supprimerTravaux(works_invoice.find((t) => t.id === formulaireTravaux?.brouillon.id))"
  />
</template>

<style scoped>
.lien-releve {
  font-size: 0.85rem;
  white-space: nowrap;
}

.note-cellule {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.3rem;
}

.a-completer {
  margin-left: 0.3rem;
  padding: 0 0.4rem;
  border-radius: 999px;
  background: var(--fond-avertissement);
  font-size: 0.75rem;
  font-weight: 600;
}

.case {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.9rem;
}

.onglets {
  display: flex;
  gap: 0.3rem;
  margin: 1rem 0 0.5rem;
  border-bottom: 1px solid var(--bord);
}

.onglets button {
  border: none;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  background: none;
}

.onglets button.actif {
  border-bottom-color: var(--accent);
  font-weight: 600;
}

.filtres {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.detail-mouvement {
  font-size: 0.8rem;
  color: var(--discret);
  max-width: 34rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.categorie {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}

.note-cellule .note {
  font-size: 0.85rem;
}

.deplie {
  padding: 0.2rem 0.6rem 0.4rem 2.5rem;
}

.resume {
  margin: 0 0 0.3rem;
}

.liens {
  list-style: none;
  padding: 0;
  margin: 0 0 0.5rem;
}

.liens li {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.actions-detail {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.pre {
  display: block;
  white-space: pre-line;
  font-size: 0.85rem;
}

:deep(tr.surligne) > td {
  background: #fff1a8 !important;
}

.petit {
  font-size: 0.8rem;
}

.alerte {
  color: #9a6700;
}

.note-form {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.note-form p {
  margin: 0;
}

.fin {
  justify-content: flex-end;
}
</style>

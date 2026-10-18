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
import { RouterLink, useRoute } from 'vue-router'

import {
  api, AVEC_DETAIL, CATEGORIES_MOUVEMENT, type CategorieMouvement, type Echeance,
  type Immeuble, type Lot, type Mouvement, type Paiement, type Regularisation, type ReleveResume,
  type Sejour, type StatutMouvement, type Travaux,
} from '../api'
import FormulairePaiement, { type Brouillon, enregistrerBrouillon, saisies } from '../components/FormulairePaiement.vue'
import FormulaireTravaux, { type BrouillonTravaux } from '../components/FormulaireTravaux.vue'
import { dateFr, euros, nombreApi, nombreFr } from '../format'
import { categoriePropose, proposer } from '../rapprochement'

// Categorisation of the bank movements (ADR 0018; the statements are imported in RelevesView): each movement gets a
// category (proposed from its label or the tenant named in it); a tenant payment and works have a detail, unfolded
// under the movement: the payments or works linked to it, added in the same forms as the Paiements and Travaux
// screens, linked when typed before, changed or deleted there; a note justifies a rest. Two tabs: to categorise, and
// categorised (those whose detail does not cover the amount first, « à compléter »).

type Onglet = 'a_categoriser' | 'categorises'

const route = useRoute()
const confirm = useConfirm()
const toast = useToast()

const onglet = ref<Onglet>('a_categoriser')
const mouvements = ref<Mouvement[]>([])
const releves = ref<ReleveResume[]>([])
const annee = ref('')
const releveId = ref<number | null>(null)
const sens = ref<'' | 'credit' | 'debit'>('')
const filtreCategorie = ref<CategorieMouvement | ''>('')
// Categorised: only those whose detail is to complete
const seulementACompleter = ref(false)
const recherche = ref('')
const occupe = ref(false)
// Rows unfolded (detail of a tenant payment or works), by movement id
const deplies = ref<Record<number, boolean>>({})
// Opened from a payment (?mouvement=): highlighted
const surligne = ref<number | null>(null)

// What the proposals and the forms need, every building
const immeubles = ref<Immeuble[]>([])
const sejours = ref<Sejour[]>([])
const echeances = ref<Echeance[]>([])
const regularisations = ref<Regularisation[]>([])
const paiements = ref<Paiement[]>([])
const travaux = ref<Travaux[]>([])
const lots = ref<Map<number, Lot[]>>(new Map())

const ok = (texte: string) => toast.add({ severity: 'success', summary: texte, life: 3000 })
const ko = (e: unknown) => toast.add({ severity: 'error', summary: (e as Error).message, life: 6000 })

onMounted(async () => {
  try {
    immeubles.value = await api.immeubles()
    lots.value = new Map(await Promise.all(immeubles.value.map(async (i) => [i.id, (await api.immeuble(i.id)).lots] as const)))
    await Promise.all([chargerReferentiel(), charger()])
  } catch (e) {
    ko(e)
  }
  await ouvrirMouvement(Number(route.query.mouvement))
  // From the page of a statement: its movements
  const releve = Number(route.query.releve)
  if (releves.value.some((r) => r.id === releve)) {
    releveId.value = releve
    annee.value = ''
  }
})

async function chargerReferentiel() {
  const parImmeuble = await Promise.all(immeubles.value.map(async (i) => ({
    sejours: await api.sejours(i.id), echeances: await api.echeances(i.id), regularisations: await api.regularisations(i.id),
    paiements: await api.paiements(i.id, null), travaux: await api.travaux(i.id),
  })))
  sejours.value = parImmeuble.flatMap((x) => x.sejours)
  echeances.value = parImmeuble.flatMap((x) => x.echeances)
  regularisations.value = parImmeuble.flatMap((x) => x.regularisations)
  paiements.value = parImmeuble.flatMap((x) => x.paiements)
  travaux.value = parImmeuble.flatMap((x) => x.travaux)
}

async function charger() {
  ;[mouvements.value, releves.value] = await Promise.all([api.mouvements('tous'), api.releves()])
  // The statement of the filter deleted (imported again, it has another id): every statement
  if (releveId.value !== null && !releves.value.some((r) => r.id === releveId.value)) {
    releveId.value = null
  }
}

const recharger = () => Promise.all([chargerReferentiel(), charger()])

async function ouvrirMouvement(id: number) {
  const m = mouvements.value.find((x) => x.id === id)
  if (!m) {
    return
  }
  annee.value = m.date_operation.slice(0, 4)
  releveId.value = m.releve_id
  onglet.value = ongletDe(m.statut)
  surligne.value = m.id
  if (m.categorie && AVEC_DETAIL.includes(m.categorie)) {
    deplies.value = { [m.id]: true }
  }
  await nextTick()
  document.querySelector('tr.surligne')?.scrollIntoView({ block: 'center' })
}

// ---------------------------------------------------------------- lists and filters

const estCredit = (m: Mouvement) => new Big(m.montant).gt(0)
const reste = (m: Mouvement) => new Big(m.montant).abs().minus(m.couvert).toString()
const ongletDe = (statut: StatutMouvement): Onglet => (statut === 'a_categoriser' ? 'a_categoriser' : 'categorises')
// The filters above the tabs apply to both: year, statement, sense, search
function filtre(m: Mouvement) {
  const texte = recherche.value.trim().toUpperCase()
  return (releveId.value === null || m.releve_id === releveId.value)
    && (releveId.value !== null || !annee.value || m.date_operation.startsWith(annee.value))
    && (!sens.value || (sens.value === 'credit') === estCredit(m))
    && (!texte || `${m.libelle} ${m.detail ?? ''} ${m.note ?? ''}`.toUpperCase().includes(texte))
}
const filtres = computed(() => mouvements.value.filter(filtre))
const nombre = (o: Onglet) => filtres.value.filter((m) => ongletDe(m.statut) === o).length
const aCompleter = computed(() => filtres.value.filter((m) => m.statut === 'incomplet').length)
const nomCategorie = (c: CategorieMouvement | null) => (c ? CATEGORIES_MOUVEMENT[c].nom : '')
const iconeCategorie = (c: CategorieMouvement | null) => (c ? CATEGORIES_MOUVEMENT[c].icone : '')
const aDetail = (m: Mouvement) => m.categorie !== null && AVEC_DETAIL.includes(m.categorie)

const annees = computed(() => [...new Set(mouvements.value.map((m) => m.date_operation.slice(0, 4)))].sort().reverse())
const relevesDuFiltre = computed(() => releves.value.filter((r) => !annee.value || r.date_releve.startsWith(annee.value)))
const plusieursComptes = computed(() => new Set(releves.value.map((r) => r.compte)).size > 1)

const affiches = computed(() => filtres.value
  .filter((m) => ongletDe(m.statut) === onglet.value
    && (!seulementACompleter.value || onglet.value !== 'categorises' || m.statut === 'incomplet')
    && (onglet.value !== 'categorises' || !filtreCategorie.value || m.categorie === filtreCategorie.value))
  // Those to complete first, then by date (the table keeps this order until a column is sorted)
  .sort((a, b) => Number(b.statut === 'incomplet') - Number(a.statut === 'incomplet')
    || a.date_operation.localeCompare(b.date_operation) || a.releve_id - b.releve_id || a.ordre - b.ordre))

// ---------------------------------------------------------------- categories

const proposition = (m: Mouvement) => categoriePropose(m, sejours.value)

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

// A category with a note to type (« autre »), or the rest of a tenant payment or works to justify
const saisieNote = ref<{ mouvement: Mouvement, categorie: CategorieMouvement, note: string, titre: string } | null>(null)

function categoriser(m: Mouvement, categorie: CategorieMouvement) {
  if (categorie === 'autre') {
    saisieNote.value = { mouvement: m, categorie, note: '', titre: 'Autre : qu\'est-ce que ce mouvement ?' }
    return
  }
  // A tenant payment or works: their detail is given later, in « Catégorisés » (to complete)
  return agir(() => api.categoriserMouvement(m.id, categorie),
    AVEC_DETAIL.includes(categorie) ? `${nomCategorie(categorie)} : détail à donner dans « Catégorisés »` : nomCategorie(categorie))
}

function enregistrerNote() {
  const s = saisieNote.value
  if (!s) {
    return
  }
  saisieNote.value = null
  return agir(() => api.categoriserMouvement(s.mouvement.id, s.categorie, s.note.trim() || null), 'Enregistré')
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

// ---------------------------------------------------------------- detail: payments of a tenant, works

const paiementsDe = (m: Mouvement) => paiements.value.filter((p) => p.mouvement_id === m.id)
const travauxDe = (m: Mouvement) => travaux.value.filter((t) => t.mouvement_id === m.id)
const totalPaiement = (p: Paiement) => new Big(p.loyer).plus(p.provision).plus(p.regularisation).toString()
const moisFr = (mois: string | null) => (mois ? `${mois.slice(5, 7)}/${mois.slice(0, 4)}` : 'régularisation')
const contexte = (m: Mouvement) => ({ libelle: m.libelle, date: m.date_operation, montant: m.montant, couvert: m.couvert })

/**
 * Payments or works typed by hand that may be this movement: the server's « possibles » (same amount, ten days), of
 * the tenant named; and the payment of that tenant for the month of the transfer, of the same amount, typed later.
 */
function possibles(m: Mouvement) {
  const p = proposer(m, sejours.value, echeances.value, regularisations.value)
  const sejour = p.sejour
  const siens = sejour ? m.possibles.filter((x) => x.type !== 'travaux' && x.locataire === sejour.locataire) : []
  const liste: Possible[] = siens.length ? siens : [...m.possibles]
  if (sejour && m.statut !== 'categorise') {
    for (const x of paiements.value.filter((y) => !y.mouvement_id && y.sejour_id === sejour.id && y.mois?.slice(0, 7) === p.mois
      && new Big(totalPaiement(y)).eq(reste(m)))) {
      if (!liste.some((l) => l.type === 'paiement' && l.id === x.id)) {
        liste.push({ type: 'paiement', id: x.id, locataire: x.locataire, lot: x.lot, mois: x.mois, date: x.date_paiement })
      }
    }
  }
  return liste
}
type Possible = Mouvement['possibles'][number]
const lien = (p: Possible) =>
  p.type === 'groupe' ? { paiement_ids: p.ids } : p.type === 'paiement' ? { paiement_id: p.id } : { travaux_id: p.id }
const clePossible = (p: Possible) => (p.type === 'groupe' ? `g${p.ids.join('-')}` : `${p.type}${p.id}`)
function libellePossible(p: Possible) {
  if (p.type === 'travaux') {
    return `${p.fournisseur} : ${p.description}`
  }
  if (p.type === 'groupe') {
    return `${p.locataire}, ${p.ids.length} paiements : ${p.mois}`
  }
  return `${p.locataire}, ${moisFr(p.mois)}`
}

// The category proposed for a movement to categorise: that of the payment or works typed by hand that match it (its
// detail, linked once categorised), else the category read in its label or the tenant named in it
function proposee(m: Mouvement): CategorieMouvement | null {
  const candidats = possibles(m)
  if (candidats.length) {
    return candidats.every((c) => c.type === 'travaux') ? 'travaux' : 'locataire'
  }
  return proposition(m)
}

// Every category proposed on the rows shown, in one go (the history): the same as clicking each button of the column
const avecProposition = computed(() => (onglet.value === 'a_categoriser' ? affiches.value.filter((m) => proposee(m)) : []))
function accepterTout() {
  const liste = avecProposition.value.map((m) => ({ m, c: proposee(m)! }))
  confirm.require({
    message: `Catégoriser ${liste.length} mouvement(s) selon la catégorie proposée ? Les paiements de locataire et les travaux
      seront à compléter dans l'onglet « Catégorisés ».`,
    header: 'Accepter les propositions', acceptLabel: 'Catégoriser', rejectLabel: 'Annuler',
    accept: () => agir(async () => {
      for (const { m, c } of liste) {
        await api.categoriserMouvement(m.id, c)
      }
    }, `${liste.length} mouvement(s) catégorisé(s)`),
  })
}

/** « Catégorisés », those to complete only. */
function voirACompleter() {
  onglet.value = 'categorises'
  seulementACompleter.value = true
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
const correspondances = (m: Mouvement) =>
  possibles(m).filter((p) => (m.categorie === 'travaux') === (p.type === 'travaux')).length

// The list offers everything typed by hand and not linked (works; payments of the tenant named, else all): no filter
// on amount or date (a deposit, a transfer before the invoice). What matches the movement (same amount, close date, or
// several payments adding up to it) is marked, first, and chosen; the others by closeness of date. The choice gets
// warnings, not a refusal: amount different from the rest, date far from the movement.
type Choix = { cle: string, texte: string, correspond: boolean, lien: Possible, montant: string | null, date: string | null }
const rattachement = ref<{ mouvement: Mouvement, choix: Choix[], cle: string | null } | null>(null)
const ecartJours = (m: Mouvement, date: string | null) =>
  (date ? Math.round(Math.abs(new Date(date).getTime() - new Date(m.date_operation).getTime()) / 864e5) : null)
function ouvrirRattachement(m: Mouvement) {
  const correspondants = possibles(m)
  const correspond = (l: Possible) => correspondants.some((c) => clePossible(c) === clePossible(l))
  let choix: Choix[]
  if (m.categorie === 'travaux') {
    choix = travaux.value.filter((t) => !t.mouvement_id).map((t) => {
      const l: Possible = { type: 'travaux', id: t.id, description: t.description, fournisseur: t.fournisseur, date: t.date_paiement }
      return {
        cle: clePossible(l), texte: `${t.fournisseur} : ${t.description}, ${euros(t.montant_ttc)}, facture du ${dateFr(t.date_facture)}`,
        correspond: correspond(l), lien: l, montant: t.montant_ttc, date: t.date_paiement ?? t.date_facture,
      }
    })
  } else {
    const sejour = proposer(m, sejours.value, echeances.value, regularisations.value).sejour
    const libres = paiements.value.filter((p) => !p.mouvement_id && new Big(totalPaiement(p)).gt(0) === estCredit(m))
    const siens = sejour ? libres.filter((p) => p.sejour_id === sejour.id) : []
    choix = [
      // Several payments adding up to the transfer (several months)
      ...correspondants.filter((c) => c.type === 'groupe').map((c) => ({
        cle: clePossible(c), texte: libellePossible(c), correspond: true, lien: c, montant: null, date: null,
      })),
      ...(siens.length ? siens : libres).map((p) => {
        const l: Possible = { type: 'paiement', id: p.id, locataire: p.locataire, lot: p.lot, mois: p.mois, date: p.date_paiement }
        return {
          cle: clePossible(l), texte: `${p.locataire}, ${moisFr(p.mois)}, saisi le ${dateFr(p.date_paiement)} : ${euros(totalPaiement(p))}`,
          correspond: correspond(l), lien: l, montant: new Big(totalPaiement(p)).abs().toString(), date: p.date_paiement,
        }
      }),
    ]
  }
  choix.sort((a, b) => Number(b.correspond) - Number(a.correspond)
    || (ecartJours(m, a.date) ?? 9999) - (ecartJours(m, b.date) ?? 9999))
  rattachement.value = { mouvement: m, choix, cle: choix[0]?.cle ?? null }
}

/** Warnings on the choice: an amount different from the rest of the movement, a date far from it. */
const alertes = computed(() => {
  const r = rattachement.value
  const c = r?.choix.find((x) => x.cle === r.cle)
  if (!r || !c || c.correspond) {
    return []
  }
  const liste: string[] = []
  const resteMouvement = new Big(reste(r.mouvement))
  if (c.montant !== null && !new Big(c.montant).eq(resteMouvement)) {
    liste.push(new Big(c.montant).gt(resteMouvement)
      ? `${euros(c.montant)} pour un reste de ${euros(resteMouvement.toString())} : ce virement n'en paie qu'une partie (acompte) ?`
      : `${euros(c.montant)} sur un reste de ${euros(resteMouvement.toString())} : le reste sera à rattacher ou justifier`)
  }
  const jours = ecartJours(r.mouvement, c.date)
  if (jours !== null && jours > 31) {
    liste.push(`${jours} jours d'écart avec le mouvement : paiement en avance, ou facture reçue après ?`)
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
  return agir(() => api.lierMouvement(r.mouvement.id, lien(choisi.lien)), 'Rattaché')
}

const detacher = (m: Mouvement, l: { paiement_id: number } | { travaux_id: number }) =>
  agir(() => api.delierMouvement(m.id, l), 'Détaché (gardé dans son écran)')

function justifier(m: Mouvement) {
  const depot = /CAUTION|DEPOT|GARANTIE/i.test(`${m.libelle} ${m.detail ?? ''}`)
  saisieNote.value = {
    mouvement: m, categorie: m.categorie!, note: m.note ?? (depot ? 'Dépôt de garantie' : ''),
    titre: `Justifier le reste de ${euros(reste(m))}`,
  }
}
const retirerJustification = (m: Mouvement) => agir(() => api.categoriserMouvement(m.id, m.categorie!, null), 'Justification retirée')

// ---------------------------------------------------------------- forms (the same as the Paiements and Travaux screens)

const formulairePaiement = ref<{ brouillon: Brouillon, mouvement: Mouvement } | null>(null)
const formulaireTravaux = ref<{ brouillon: BrouillonTravaux, mouvement: Mouvement } | null>(null)
const erreurFormulaire = ref<string | null>(null)

/** The building of a stay (the forms read the amounts called of its building). */
function immeubleDuSejour(id: number | null) {
  const s = sejours.value.find((x) => x.id === id)
  for (const [immeuble, l] of lots.value) {
    if (s && l.some((x) => x.id === s.lot_id)) {
      return immeuble
    }
  }
  return immeubles.value[0]?.id ?? 0
}

function nouveauPaiement(m: Mouvement) {
  const p = proposer(m, sejours.value, echeances.value, regularisations.value, paiements.value)
  const credit = estCredit(m)
  // The month is already paid: nothing proposed, and said (link the payment typed, or change the month)
  const dejaPaye = Boolean(p.ecart?.includes('déjà payé'))
  formulairePaiement.value = {
    mouvement: m,
    brouillon: {
      id: null, date: m.date_operation, sejour_id: p.sejour?.id ?? null, mois: p.mois,
      montant: nombreFr(`${credit ? '' : '-'}${new Big(reste(m)).toFixed(2)}`),
      loyer: credit && !dejaPaye ? nombreFr(new Big(p.loyer).toFixed(2)) : '',
      provision: credit && !dejaPaye ? nombreFr(new Big(p.provision).toFixed(2)) : '',
      versements: p.regularisation_id ? [{ regularisation_id: p.regularisation_id, montant: nombreFr(p.regularisation) }] : [],
      mode: 'virement', note: '',
      // The rest of the transfer not split: a deposit, most of the time
      justification: m.note ?? (/CAUTION|DEPOT|GARANTIE/i.test(`${m.libelle} ${m.detail ?? ''}`) ? 'Dépôt de garantie' : ''),
    },
  }
  erreurFormulaire.value = dejaPaye
    ? `${p.ecart} : rattacher plutôt le paiement déjà saisi (bouton vert sous le mouvement), ou choisir un autre mois`
    : null
}

function modifierPaiement(m: Mouvement, p: Paiement) {
  formulairePaiement.value = {
    mouvement: m,
    brouillon: {
      id: p.id, date: p.date_paiement, sejour_id: p.sejour_id, mois: p.mois?.slice(0, 7) ?? '',
      montant: nombreFr(new Big(totalPaiement(p)).toFixed(2)), loyer: nombreFr(p.loyer), provision: nombreFr(p.provision),
      versements: p.regularisation_id ? [{ regularisation_id: p.regularisation_id, montant: nombreFr(p.regularisation) }] : [],
      mode: p.mode ?? '', note: p.note ?? '', justification: m.note ?? '',
    },
  }
  erreurFormulaire.value = null
}

async function enregistrerPaiement(suivant: boolean) {
  const f = formulairePaiement.value!
  const b = f.brouillon
  const reparti = saisies(b).reduce((t, x) => t.plus(x.montant!), new Big(0))
  const nonReparti = new Big(nombreApi(b.montant) ?? '0').minus(reparti)
  occupe.value = true
  try {
    await enregistrerBrouillon(b, f.mouvement.id)
    // The rest of the transfer, justified in the form: the note of the movement
    if (nonReparti.gt(0) && b.justification?.trim()) {
      await api.categoriserMouvement(f.mouvement.id, 'locataire', b.justification.trim())
    }
    await recharger()
    const m = mouvements.value.find((x) => x.id === f.mouvement.id)!
    formulairePaiement.value = null
    // « Ajouter et en saisir un autre »: the next one on what remains of the transfer
    if (suivant && new Big(reste(m)).gt(0) && m.statut === 'incomplet') {
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
    message: `Supprimer le paiement ${moisFr(p.mois)} de ${p.locataire} (${euros(totalPaiement(p))}) ?`,
    header: 'Supprimer', acceptLabel: 'Supprimer', rejectLabel: 'Annuler', acceptClass: 'p-button-danger',
    accept: () => {
      formulairePaiement.value = null
      return agir(() => api.supprimerPaiement(p.id), 'Paiement supprimé')
    },
  })
}

function nouveauxTravaux(m: Mouvement) {
  formulaireTravaux.value = {
    mouvement: m,
    brouillon: {
      id: null, immeuble_id: immeubles.value.length === 1 ? immeubles.value[0]!.id : null, lot_id: null,
      fournisseur: m.libelle.replace(/^(VIR( INST)?|PRLV SEPA|CB|PAIEMENT CB)\s+/, '').slice(0, 40), description: '',
      nature: 'entretien', date_facture: m.date_operation, date_paiement: m.date_operation,
      montant_ttc: nombreFr(new Big(reste(m)).toFixed(2)), note: '',
    },
  }
  erreurFormulaire.value = null
}

function modifierTravaux(m: Mouvement, t: Travaux) {
  formulaireTravaux.value = {
    mouvement: m,
    brouillon: {
      id: t.id, immeuble_id: t.immeuble_id, lot_id: t.lot_id, fournisseur: t.fournisseur, description: t.description,
      nature: t.nature, date_facture: t.date_facture, date_paiement: t.date_paiement ?? '', montant_ttc: nombreFr(t.montant_ttc),
      note: t.note ?? '',
    },
  }
  erreurFormulaire.value = null
}

async function enregistrerTravaux(suivant: boolean) {
  const f = formulaireTravaux.value!
  const b = f.brouillon
  if (!b.immeuble_id) {
    erreurFormulaire.value = 'Choisir l\'immeuble'
    return
  }
  const saisie = {
    immeuble_id: b.immeuble_id, lot_id: b.lot_id, fournisseur: b.fournisseur.trim(), description: b.description.trim(),
    nature: b.nature, date_facture: b.date_facture, date_paiement: b.date_paiement || null,
    montant_ttc: nombreApi(b.montant_ttc) ?? b.montant_ttc, note: b.note.trim() || null, mouvement_id: f.mouvement.id,
  }
  occupe.value = true
  try {
    if (b.id === null) {
      await api.creerTravaux(saisie)
    } else {
      await api.modifierTravaux(b.id, saisie)
    }
    await recharger()
    const m = mouvements.value.find((x) => x.id === f.mouvement.id)!
    formulaireTravaux.value = null
    if (suivant && new Big(reste(m)).gt(0)) {
      nouveauxTravaux(m)
    }
    ok('Travaux enregistrés (écran Travaux pour joindre la facture)')
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
    message: `Supprimer les travaux « ${t.description} » (${euros(t.montant_ttc)}) ?`,
    header: 'Supprimer', acceptLabel: 'Supprimer', rejectLabel: 'Annuler', acceptClass: 'p-button-danger',
    accept: () => {
      formulaireTravaux.value = null
      return agir(() => api.supprimerTravaux(t.id), 'Travaux supprimés')
    },
  })
}

const ONGLETS: { code: Onglet, nom: string }[] = [
  { code: 'a_categoriser', nom: 'À catégoriser' },
  { code: 'categorises', nom: 'Catégorisés' },
]
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
    Les mouvements des <RouterLink :to="{ name: 'releves' }">relevés bancaires</RouterLink> : chacun reçoit une catégorie.
    Un paiement de locataire et des travaux ont un détail : dépliez la ligne pour ajouter, rattacher, modifier.
  </p>


  <!-- ---------------------------------------------------------------- movements -->
  <template v-if="mouvements">
    <section class="filtres">
      <IconField>
        <InputIcon class="oi oi-search" />
        <InputText v-model="recherche" placeholder="Rechercher (libellé, détail)" size="small" />
      </IconField>
      <select v-model="annee" aria-label="Année">
        <option value="">Toutes les années</option>
        <option v-for="a in annees" :key="a" :value="a">{{ a }}</option>
      </select>
      <select v-model="releveId" aria-label="Relevé">
        <option :value="null">Tous les relevés</option>
        <option v-for="r in relevesDuFiltre" :key="r.id" :value="r.id">Relevé du {{ dateFr(r.date_releve) }}{{ plusieursComptes ? ` (${r.compte})` : '' }}</option>
      </select>
      <select v-model="sens" aria-label="Sens">
        <option value="">Crédits et débits</option>
        <option value="credit">Crédits</option>
        <option value="debit">Débits</option>
      </select>
    </section>

    <nav class="onglets">
      <button v-for="o in ONGLETS" :key="o.code" type="button" :class="{ actif: onglet === o.code }" @click="onglet = o.code">
        {{ o.nom }} ({{ nombre(o.code) }})
        <span v-if="o.code === 'categorises' && aCompleter" class="a-completer">{{ aCompleter }} à compléter</span>
      </button>
    </nav>
    <p v-if="onglet === 'a_categoriser' && aCompleter" class="message avertissement a-completer-message">
      Attention : {{ aCompleter }} mouvement(s) catégorisé(s) en paiement de locataire ou en travaux attendent leur détail.
      <a href="#" @click.prevent="voirACompleter">Les compléter</a>
    </p>
    <section class="filtres outils-onglet">
      <select v-if="onglet !== 'a_categoriser'" v-model="filtreCategorie" aria-label="Catégorie">
        <option value="">Toutes les catégories</option>
        <option v-for="(c, code) in CATEGORIES_MOUVEMENT" :key="code" :value="code">{{ c.nom }}</option>
      </select>
      <label v-if="onglet === 'categorises' && aCompleter" class="case">
        <input v-model="seulementACompleter" type="checkbox"> Seulement ceux à compléter ({{ aCompleter }})
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
      class="mouvements"
    >
      <template #empty>Aucun mouvement.</template>
      <!-- The arrow, on the categorised movements that have a detail only -->
      <Column v-if="onglet === 'categorises'" style="width: 2.5rem">
        <template #body="{ data }">
          <Button
            v-if="aDetail(data)" :icon="deplies[data.id] ? 'oi oi-chevron-down' : 'oi oi-chevron-right'" size="small" text
            rounded severity="secondary" :aria-label="deplies[data.id] ? 'Replier' : 'Déplier'" @click="basculer(data)"
          />
        </template>
      </Column>
      <Column field="date_operation" header="Date" sortable style="width: 7rem">
        <template #body="{ data }">{{ dateFr(data.date_operation) }}</template>
      </Column>
      <Column header="Opération">
        <template #body="{ data }">
          <strong>{{ data.libelle }}</strong>
          <div v-if="data.detail" class="detail-mouvement" :title="data.detail">{{ data.detail.split('\n').slice(0, 3).join(' · ') }}</div>
        </template>
      </Column>
      <Column field="montant" header="Montant" sortable body-class="nombre" header-class="nombre" style="width: 9rem">
        <template #body="{ data }">
          <span :class="estCredit(data) ? 'ok' : ''">{{ estCredit(data) ? '+' : '' }}{{ euros(data.montant) }}</span>
          <div v-if="data.statut === 'incomplet'" class="discret">reste {{ euros(reste(data)) }}</div>
        </template>
      </Column>
      <!-- To categorise: the proposal (one button), then any other category -->
      <Column v-if="onglet === 'a_categoriser'" header="Proposition" style="width: 22rem">
        <template #body="{ data }">
          <Button
            v-if="proposee(data)" :label="nomCategorie(proposee(data))" :icon="iconeCategorie(proposee(data))" size="small"
            :disabled="occupe" @click="categoriser(data, proposee(data)!)"
          />
          <span v-else class="discret">—</span>
        </template>
      </Column>
      <Column v-if="onglet === 'a_categoriser'" style="width: 11rem">
        <template #body="{ data }">
          <Button
            label="Autre catégorie" icon="oi oi-angle-down" icon-pos="right" size="small" severity="secondary" outlined
            :disabled="occupe" @click="ouvrirMenu($event, data)"
          />
        </template>
      </Column>
      <!-- Categorised: the category, its note, ✕ to take it back -->
      <Column v-else header="Catégorie" style="width: 30rem">
        <template #body="{ data }">
          <div class="categorie">
            <Tag :value="nomCategorie(data.categorie)" :icon="iconeCategorie(data.categorie)" severity="info" />
            <Tag v-if="data.statut === 'incomplet'" value="à compléter" severity="warn" />
            <span v-if="data.note" class="discret note">{{ data.note }}</span>
            <Button
              icon="oi oi-times" size="small" text rounded severity="secondary"
              :disabled="occupe || data.paiements.length > 0 || data.travaux.length > 0"
              :title="data.paiements.length || data.travaux.length ? 'Détacher d\'abord les paiements ou travaux du détail' : 'Retirer la catégorie'"
              @click="retirerCategorie(data)"
            />
          </div>
        </template>
      </Column>

      <!-- The detail of a movement: its payments or works, the actions to complete it -->
      <template #expansion="{ data }">
        <div class="deplie">
          <template v-if="aDetail(data)">
            <p class="resume">
              {{ estCredit(data) ? 'Virement reçu' : 'Débit' }} de {{ euros(data.montant) }} · rapproché {{ euros(data.couvert) }}
              · <strong :class="Number(reste(data)) > 0 && !data.note ? 'ko' : 'ok'">reste {{ euros(reste(data)) }}</strong>
              <template v-if="data.note">
                · justifié : {{ data.note }}
                <Button label="Retirer" size="small" text :disabled="occupe" @click="retirerJustification(data)" />
              </template>
            </p>
            <ul class="liens">
              <template v-if="data.categorie === 'locataire'">
                <li v-for="p in paiementsDe(data)" :key="`p${p.id}`">
                  <span class="oi oi-user" />
                  <span>
                    {{ p.locataire }}, {{ moisFr(p.mois) }} :
                    <template v-if="p.mois">loyer {{ euros(p.loyer) }} + provision {{ euros(p.provision) }}</template>
                    <template v-if="p.regularisation_id">{{ p.mois ? ' + ' : '' }}régularisation {{ euros(p.regularisation) }}</template>
                    = <strong>{{ euros(totalPaiement(p)) }}</strong>
                  </span>
                  <Button label="Modifier" size="small" text :disabled="occupe" @click="modifierPaiement(data, p)" />
                  <Button label="Détacher" size="small" text severity="secondary" :disabled="occupe" @click="detacher(data, { paiement_id: p.id })" />
                  <Button label="Supprimer" size="small" text severity="danger" :disabled="occupe" @click="supprimerPaiement(p)" />
                </li>
              </template>
              <template v-else>
                <li v-for="t in travauxDe(data)" :key="`t${t.id}`">
                  <span class="oi oi-hammer" />
                  <span>{{ t.fournisseur }} : {{ t.description }} = <strong>{{ euros(t.montant_ttc) }}</strong></span>
                  <Button label="Modifier" size="small" text :disabled="occupe" @click="modifierTravaux(data, t)" />
                  <Button label="Détacher" size="small" text severity="secondary" :disabled="occupe" @click="detacher(data, { travaux_id: t.id })" />
                  <Button label="Supprimer" size="small" text severity="danger" :disabled="occupe" @click="supprimerTravaux(t)" />
                </li>
              </template>
              <li v-if="!data.paiements.length && !data.travaux.length" class="discret">Rien de rattaché pour l'instant.</li>
            </ul>
            <div class="actions-detail">
              <Button
                v-if="data.categorie === 'locataire'" label="Ajouter un paiement du locataire…" icon="oi oi-plus" size="small"
                :disabled="occupe || Number(reste(data)) <= 0" @click="nouveauPaiement(data)"
              />
              <Button
                v-else label="Ajouter des travaux…" icon="oi oi-plus" size="small" :disabled="occupe || Number(reste(data)) <= 0"
                @click="nouveauxTravaux(data)"
              />
              <Button
                :label="(data.categorie === 'locataire' ? 'Rattacher à un paiement existant…' : 'Rattacher à des travaux existants…')
                  + (correspondances(data) ? ` ✓ ${correspondances(data)} correspond${correspondances(data) > 1 ? 'ent' : ''}` : '')"
                :icon="correspondances(data) ? 'oi oi-link' : 'oi oi-search'" size="small" outlined
                :severity="correspondances(data) ? 'success' : undefined" :disabled="occupe || Number(reste(data)) <= 0"
                @click="ouvrirRattachement(data)"
              />
              <Button
                v-if="Number(reste(data)) > 0 && !data.note" label="Justifier le reste…" icon="oi oi-comment" size="small"
                severity="secondary" outlined :disabled="occupe" @click="justifier(data)"
              />
            </div>
            <form v-if="rattachement && rattachement.mouvement.id === data.id" class="formulaire" @submit.prevent="rattacher">
              <label v-if="rattachement.choix.length">{{ data.categorie === 'locataire' ? 'Paiement saisi' : 'Travaux saisis' }}
                <select v-model="rattachement.cle" required>
                  <option v-for="c in rattachement.choix" :key="c.cle" :value="c.cle">{{ c.correspond ? '✓ correspond · ' : '' }}{{ c.texte }}</option>
                </select>
              </label>
              <span v-else class="discret">{{ data.categorie === 'locataire' ? 'Aucun paiement saisi non rattaché.' : 'Aucuns travaux saisis non rattachés.' }}</span>
              <span v-if="rattachement.choix.some((c) => c.correspond)" class="ok petit">✓ : même montant, à la date du mouvement</span>
              <span v-for="(a, i) in alertes" :key="i" class="alerte petit">⚠ {{ a }}</span>
              <Button type="submit" label="Rattacher" size="small" :disabled="occupe || !rattachement.cle" />
              <Button label="Annuler" size="small" text @click="rattachement = null" />
            </form>
          </template>
          <p v-else class="discret">
            {{ data.categorie ? `${nomCategorie(data.categorie)} : pas de détail à saisir.` : 'Pas encore de catégorie.' }}
            <span v-if="data.detail" class="pre">{{ data.detail }}</span>
          </p>
        </div>
      </template>
    </DataTable>
  </template>

  <!-- A note: « autre », or the rest justified (modal, in the middle of the screen) -->
  <Dialog
    :visible="saisieNote !== null" modal :header="saisieNote?.titre" :style="{ width: '34rem' }"
    @update:visible="(v: boolean) => { if (!v) saisieNote = null }"
  >
    <form v-if="saisieNote" class="note-form" @submit.prevent="enregistrerNote">
      <p class="discret">{{ saisieNote.mouvement.libelle }} du {{ dateFr(saisieNote.mouvement.date_operation) }} : {{ euros(saisieNote.mouvement.montant) }}</p>
      <InputText v-model="saisieNote.note" required autofocus placeholder="dépôt de garantie, apport des associés…" fluid />
      <div class="actions-detail fin">
        <Button label="Annuler" text @click="saisieNote = null" />
        <Button type="submit" label="Enregistrer" :disabled="occupe || !saisieNote.note.trim()" />
      </div>
    </form>
  </Dialog>

  <FormulairePaiement
    v-if="formulairePaiement"
    :key="formulairePaiement.brouillon.id ?? `nouveau-${formulairePaiement.mouvement.id}-${formulairePaiement.mouvement.couvert}`"
    v-model="formulairePaiement.brouillon"
    :immeuble="immeubleDuSejour(formulairePaiement.brouillon.sejour_id)"
    :sejours="sejours"
    :regularisations="regularisations"
    :echeances="echeances"
    :paiements="paiements"
    :occupe="occupe"
    :erreur="erreurFormulaire"
    :mouvement="contexte(formulairePaiement.mouvement)"
    @enregistrer="enregistrerPaiement"
    @fermer="formulairePaiement = null"
    @supprimer="supprimerPaiement(paiements.find((p) => p.id === formulairePaiement?.brouillon.id))"
  />
  <FormulaireTravaux
    v-if="formulaireTravaux"
    :key="formulaireTravaux.brouillon.id ?? `nouveaux-${formulaireTravaux.mouvement.id}-${formulaireTravaux.mouvement.couvert}`"
    v-model="formulaireTravaux.brouillon"
    :immeubles="immeubles"
    :lots="lots"
    :occupe="occupe"
    :erreur="erreurFormulaire"
    :mouvement="contexte(formulaireTravaux.mouvement)"
    @enregistrer="enregistrerTravaux"
    @fermer="formulaireTravaux = null"
    @supprimer="supprimerTravaux(travaux.find((t) => t.id === formulaireTravaux?.brouillon.id))"
  />
</template>

<style scoped>
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

.categorie .note {
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

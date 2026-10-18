<script setup lang="ts">
import Big from 'big.js'
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import {
  api, ApiError, NATURES_TRAVAUX, type Echeance, type ExtracteurEnregistre, type Immeuble, type Lot, type Mouvement,
  type NatureTravaux, type Paiement, type Regularisation, type ReleveResume, type Sejour,
} from '../api'
import { dateFr, euros, nombreApi, nombreFr } from '../format'
import { motifPropose, proposer, type Proposition } from '../rapprochement'

// Bank statements (ADR 0018): the PDFs are read here, in the browser, by the extractor of their bank, then stored with
// their movements. Each movement is then matched: a credit with the payment of a tenant (proposed from the name and
// the month written in it), a debit with works, or ignored with a reason; a payment typed by hand before is linked.

type Onglet = 'a_traiter' | 'rapproche' | 'ignore' | 'releves'

const route = useRoute()
const onglet = ref<Onglet>('a_traiter')
// Opened from a payment (?mouvement=): its movement, shown in its tab and statement, highlighted
const surligne = ref<number | null>(null)
const mouvements = ref<Mouvement[]>([])
const releves = ref<ReleveResume[]>([])
const annee = ref('')
const sens = ref<'' | 'credit' | 'debit'>('')
// One statement only (its movements, in the tab chosen)
const releveId = ref<number | null>(null)
const message = ref<{ texte: string, type: 'info' | 'erreur' } | null>(null)
const occupe = ref(false)

// What the proposals need, every building
const immeubles = ref<Immeuble[]>([])
const sejours = ref<Sejour[]>([])
const echeances = ref<Echeance[]>([])
const regularisations = ref<Regularisation[]>([])
const lots = ref<Map<number, Lot[]>>(new Map())

onMounted(async () => {
  try {
    immeubles.value = await api.immeubles()
    const parImmeuble = await Promise.all(immeubles.value.map(async (i) => ({
      sejours: await api.sejours(i.id), echeances: await api.echeances(i.id),
      regularisations: await api.regularisations(i.id), lots: (await api.immeuble(i.id)).lots, id: i.id,
    })))
    sejours.value = parImmeuble.flatMap((x) => x.sejours)
    echeances.value = parImmeuble.flatMap((x) => x.echeances)
    regularisations.value = parImmeuble.flatMap((x) => x.regularisations)
    lots.value = new Map(parImmeuble.map((x) => [x.id, x.lots]))
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
  await charger()
  await ouvrirMouvement(Number(route.query.mouvement))
})

watch(onglet, charger)

async function ouvrirMouvement(id: number) {
  if (!Number.isInteger(id) || id <= 0) {
    return
  }
  const m = (await api.mouvements('tous')).find((x) => x.id === id)
  if (!m) {
    return
  }
  annee.value = m.date_operation.slice(0, 4)
  releveId.value = m.releve_id
  surligne.value = m.id
  const cible: Onglet = m.statut === 'ignore' ? 'ignore' : m.statut === 'rapproche' ? 'rapproche' : 'a_traiter'
  if (onglet.value !== cible) {
    onglet.value = cible
    await charger()
  }
  await nextTick()
  document.getElementById(`mouvement-${m.id}`)?.scrollIntoView({ block: 'center' })
}

// The statements of the filter: those of the year chosen, the latest first
const relevesDuFiltre = computed(() => releves.value.filter((r) => !annee.value || r.date_releve.startsWith(annee.value)))
watch(annee, () => {
  if (releveId.value !== null && !relevesDuFiltre.value.some((r) => r.id === releveId.value)) {
    releveId.value = null
  }
})

/** From the list of statements: the movements of one of them still to handle. */
function voirMouvements(r: ReleveResume) {
  annee.value = r.date_releve.slice(0, 4)
  releveId.value = r.id
  onglet.value = 'a_traiter'
}

async function charger() {
  try {
    // The statements: their list, and the filter of the movements
    releves.value = await api.releves()
    if (onglet.value !== 'releves') {
      mouvements.value = await api.mouvements(onglet.value)
      const annees = [...new Set(mouvements.value.map((m) => m.date_operation.slice(0, 4)))]
      if (annee.value && !annees.includes(annee.value)) {
        annee.value = ''
      }
    }
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}

const annees = computed(() => [...new Set(mouvements.value.map((m) => m.date_operation.slice(0, 4)))].sort().reverse())
const affiches = computed(() => mouvements.value.filter((m) =>
  (releveId.value === null || m.releve_id === releveId.value)
  && (!annee.value || releveId.value !== null || m.date_operation.startsWith(annee.value))
  && (!sens.value || (sens.value === 'credit') === new Big(m.montant).gt(0))))
const estCredit = (m: Mouvement) => new Big(m.montant).gt(0)
const reste = (m: Mouvement) => new Big(m.montant).abs().minus(m.couvert).toString()

// ---------------------------------------------------------------- import

const survol = ref(false)
const resultats = ref<{ nom: string, etat: 'en_cours' | 'importe' | 'doublon' | 'erreur', texte: string }[]>([])

async function importer(fichiers: FileList | File[] | null | undefined) {
  const liste = [...(fichiers ?? [])].filter((f) => f.name.toLowerCase().endsWith('.pdf'))
  if (!liste.length) {
    return
  }
  occupe.value = true
  resultats.value = liste.map((f) => ({ nom: f.name, etat: 'en_cours', texte: 'lecture…' }))
  try {
    const { candidatsReleve, lireReleve, morceauxDuPdf } = await import('../extraction/navigateur')
    const { releveAImporter } = await import('../extraction/moteurReleve')
    const extracteurs: ExtracteurEnregistre[] = await api.extracteurs()
    for (const [i, fichier] of liste.entries()) {
      const resultat = resultats.value[i]!
      try {
        const pages = await morceauxDuPdf(fichier)
        const [candidat] = candidatsReleve(pages, extracteurs)
        if (!candidat) {
          Object.assign(resultat, { etat: 'erreur', texte: 'aucun extracteur de relevé ne reconnaît ce PDF (une facture ? une image ?)' })
          continue
        }
        const { releve, probleme } = releveAImporter(lireReleve(pages, candidat), candidat.enregistre.id)
        if (!releve) {
          Object.assign(resultat, { etat: 'erreur', texte: `${candidat.enregistre.fournisseur} : ${probleme}` })
          continue
        }
        const importe = await api.importerReleve(fichier, releve)
        Object.assign(resultat, {
          etat: 'importe', texte: `${importe.banque}, compte ${importe.compte}, relevé du ${dateFr(importe.date_releve)} : ${importe.mouvements.length} mouvement(s)`,
        })
      } catch (e) {
        const doublon = e instanceof ApiError && e.status === 409
        Object.assign(resultat, { etat: doublon ? 'doublon' : 'erreur', texte: (e as Error).message })
      }
    }
  } finally {
    occupe.value = false
  }
  await charger()
}

function choisir(event: Event) {
  const input = event.target as HTMLInputElement
  importer(input.files).finally(() => { input.value = '' })
}

// ---------------------------------------------------------------- matching

// The movement being matched, with its form: a payment (credit) or works (debit), or a reason to ignore it
type Saisie =
  | { genre: 'paiement', mouvement: Mouvement, proposition: Proposition, sejour_id: number | null, mois: string, loyer: string,
    provision: string, regularisation_id: number | null, regularisation: string, note: string }
  | { genre: 'travaux', mouvement: Mouvement, immeuble_id: number | null, lot_id: number | null, fournisseur: string,
    description: string, nature: NatureTravaux, date_facture: string }
  | { genre: 'ignorer', mouvement: Mouvement, motif: string }
  | { genre: 'lier', mouvement: Mouvement, choix: Paiement[], paiement_id: number | null }
const saisie = ref<Saisie | null>(null)

const nomSejour = (s: Sejour) => `${s.locataire} (${s.lot}${s.sortie ? `, parti le ${dateFr(s.sortie)}` : ''})`
const sejoursTries = computed(() => [...sejours.value].sort((a, b) => a.locataire.localeCompare(b.locataire)))
const regularisationsDe = (sejourId: number | null) =>
  regularisations.value.filter((r) => r.sejour_id === sejourId && r.etat === 'en_attente')

function paiement(m: Mouvement) {
  const p = proposer(m, sejours.value, echeances.value, regularisations.value)
  saisie.value = {
    genre: 'paiement', mouvement: m, proposition: p, sejour_id: p.sejour?.id ?? null, mois: p.mois,
    loyer: nombreFr(p.loyer), provision: nombreFr(p.provision), regularisation_id: p.regularisation_id,
    regularisation: nombreFr(p.regularisation), note: '',
  }
}

/** What the proposal says, in one line, before opening the form. */
function resume(m: Mouvement) {
  const p = proposer(m, sejours.value, echeances.value, regularisations.value)
  if (!p.sejour) {
    return null
  }
  const parts = p.regularisation_id
    ? `régularisation ${euros(p.regularisation)}`
    : `loyer ${euros(p.loyer)} + provision ${euros(p.provision)}`
  return { texte: `${p.sejour.locataire}, ${p.mois.split('-').reverse().join('/')} : ${parts}`, ecart: p.ecart }
}

function travaux(m: Mouvement) {
  const immeuble = immeubles.value.length === 1 ? immeubles.value[0]!.id : null
  saisie.value = {
    genre: 'travaux', mouvement: m, immeuble_id: immeuble, lot_id: null,
    fournisseur: m.libelle.replace(/^(VIR( INST)?|PRLV SEPA|CB|PAIEMENT CB)\s+/, '').slice(0, 40),
    description: '', nature: 'entretien', date_facture: m.date_operation,
  }
}

/**
 * A payment typed by hand, not linked, of a smaller amount (the transfer also paid the deposit…): those of the tenant
 * named in the label (else of everyone), within 45 days.
 */
async function rattacherUnPaiement(m: Mouvement) {
  const annees = new Set([-1, 0, 1].map((d) => Number(m.date_operation.slice(0, 4)) + d))
  const tous = (await Promise.all(immeubles.value.flatMap((i) => [...annees].map((a) => api.paiements(i.id, a))))).flat()
  const jours = (p: Paiement) => Math.abs(new Date(p.date_paiement).getTime() - new Date(m.date_operation).getTime()) / 864e5
  const total = (p: Paiement) => new Big(p.loyer).plus(p.provision).plus(p.regularisation)
  const libres = [...new Map(tous.map((p) => [p.id, p])).values()]
    .filter((p) => !p.mouvement_id && jours(p) <= 45 && total(p).gt(0) && total(p).lte(reste(m)))
  const sejour = proposer(m, sejours.value, echeances.value, regularisations.value).sejour
  const siens = sejour ? libres.filter((p) => p.sejour_id === sejour.id) : []
  const choix = (siens.length ? siens : libres).sort((a, b) => jours(a) - jours(b))
  saisie.value = { genre: 'lier', mouvement: m, choix, paiement_id: choix[0]?.id ?? null }
}
const totalPaiement = (p: Paiement) => new Big(p.loyer).plus(p.provision).plus(p.regularisation).toString()

function ignorer(m: Mouvement) {
  // Partly matched: the reason justifies the rest (a deposit paid with the rent, most of the time)
  const depot = m.statut === 'partiel' && /CAUTION|DEPOT|DÉPÔT|GARANTIE/i.test(`${m.libelle} ${m.detail ?? ''}`)
  saisie.value = { genre: 'ignorer', mouvement: m, motif: depot ? 'Dépôt de garantie' : m.statut === 'partiel' ? '' : motifPropose(m) ?? '' }
}

async function agir(action: () => Promise<unknown>, succes: string) {
  occupe.value = true
  try {
    await action()
    message.value = { texte: succes, type: 'info' }
    saisie.value = null
    await charger()
    regularisations.value = (await Promise.all(immeubles.value.map((i) => api.regularisations(i.id)))).flat()
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  } finally {
    occupe.value = false
  }
}

function enregistrer() {
  const s = saisie.value
  if (!s) {
    return
  }
  const m = s.mouvement
  if (s.genre === 'paiement') {
    if (!s.sejour_id) {
      message.value = { texte: 'Choisir le locataire', type: 'erreur' }
      return
    }
    const loyer = nombreApi(s.loyer) ?? '0'
    const provision = nombreApi(s.provision) ?? '0'
    const regularisation = s.regularisation_id ? nombreApi(s.regularisation) ?? '0' : '0'
    return agir(() => api.creerPaiement({
      sejour_id: s.sejour_id!, date_paiement: m.date_operation, mois: new Big(loyer).plus(provision).eq(0) ? null : `${s.mois}-01`,
      loyer, provision, regularisation_id: s.regularisation_id, regularisation, mode: 'virement', note: s.note.trim() || null,
      mouvement_id: m.id,
    }), 'Paiement enregistré')
  }
  if (s.genre === 'travaux') {
    if (!s.immeuble_id) {
      message.value = { texte: 'Choisir l\'immeuble', type: 'erreur' }
      return
    }
    return agir(() => api.creerTravaux({
      immeuble_id: s.immeuble_id!, lot_id: s.lot_id, fournisseur: s.fournisseur.trim(), description: s.description.trim(),
      nature: s.nature, date_facture: s.date_facture, date_paiement: m.date_operation, montant_ttc: reste(m), note: null,
      mouvement_id: m.id,
    }), 'Travaux enregistrés (écran Travaux pour joindre la facture)')
  }
  if (s.genre === 'lier') {
    if (!s.paiement_id) {
      return
    }
    return agir(() => api.lierMouvement(m.id, { paiement_id: s.paiement_id! }), 'Paiement rattaché')
  }
  return agir(() => api.ignorerMouvement(m.id, s.motif.trim()), 'Mouvement ignoré')
}

const ignorerAvecMotif = (m: Mouvement) => agir(() => api.ignorerMouvement(m.id, motifPropose(m)!), 'Mouvement ignoré')
const retablir = (m: Mouvement) => agir(() => api.retablirMouvement(m.id), 'Mouvement à traiter de nouveau')
const detacher = (m: Mouvement, lien: { paiement_id: number } | { travaux_id: number }) =>
  agir(() => api.delierMouvement(m.id, lien), 'Détaché (le paiement ou les travaux sont gardés)')

type Possible = Mouvement['possibles'][number]
const lien = (p: Possible) =>
  p.type === 'groupe' ? { paiement_ids: p.ids } : p.type === 'paiement' ? { paiement_id: p.id } : { travaux_id: p.id }
const cle = (p: Possible) => (p.type === 'groupe' ? `g${p.ids.join('-')}` : `${p.type}${p.id}`)
/** « Alice MARTIN, 02/2026 », « Alice MARTIN, 3 paiements : 10/2025, 11/2025, 12/2025 », or the works. */
function libellePossible(p: Possible) {
  if (p.type === 'travaux') {
    return p.description
  }
  if (p.type === 'groupe') {
    return `${p.locataire}, ${p.ids.length} paiements : ${p.mois}`
  }
  return `${p.locataire}${p.mois ? `, ${p.mois.slice(5, 7)}/${p.mois.slice(0, 4)}` : ''}`
}

const lier = (m: Mouvement, p: Possible) => agir(() => api.lierMouvement(m.id, lien(p)), 'Rattaché')

/**
 * Payments or works typed by hand that may be this movement (same amount, ten days): those of the tenant named in the
 * label when there is one (two tenants paying the same rent the same week), else all.
 */
function possibles(m: Mouvement) {
  if (!estCredit(m)) {
    return m.possibles
  }
  const sejour = proposer(m, sejours.value, echeances.value, regularisations.value).sejour
  const siens = sejour ? m.possibles.filter((p) => p.type !== 'travaux' && p.locataire === sejour.locataire) : []
  return siens.length ? siens : m.possibles
}

// The history: payments already typed, the same amount within ten days, one candidate only
const surs = computed(() => affiches.value.filter((m) => m.statut === 'a_traiter' && possibles(m).length === 1))
async function lierTout() {
  if (!confirm(`Rattacher ${surs.value.length} mouvements au paiement ou aux travaux déjà saisis qui leur correspondent ?`)) {
    return
  }
  await agir(async () => {
    for (const m of surs.value) {
      await api.lierMouvement(m.id, lien(possibles(m)[0]!))
    }
  }, `${surs.value.length} mouvements rattachés`)
}

// Debits with a reason found in their label (loan, insurance, energy…)
const ignorables = computed(() => affiches.value.filter((m) => m.statut === 'a_traiter' && m.possibles.length === 0 && motifPropose(m)))
async function ignorerTout() {
  if (!confirm(`Ignorer ${ignorables.value.length} débits avec le motif proposé (emprunt, assurance, énergie…) ?`)) {
    return
  }
  await agir(async () => {
    for (const m of ignorables.value) {
      await api.ignorerMouvement(m.id, motifPropose(m)!)
    }
  }, `${ignorables.value.length} débits ignorés`)
}

async function supprimerReleve(r: ReleveResume) {
  if (!confirm(`Supprimer le relevé du ${dateFr(r.date_releve)} (compte ${r.compte}) et ses mouvements ?`)) {
    return
  }
  await agir(() => api.supprimerReleve(r.id), 'Relevé supprimé')
}

const compteur = reactive({ a_traiter: 0 })
watch(mouvements, () => {
  if (onglet.value === 'a_traiter') {
    compteur.a_traiter = mouvements.value.length
  }
})
</script>

<template>
  <section class="entete-page">
    <h1>Banque</h1>
  </section>
  <p class="discret">
    Les relevés de la banque, lus ici comme les factures, puis chaque mouvement rapproché : un crédit avec le paiement
    d'un locataire, un débit avec des travaux, ou ignoré avec un motif. Un paiement saisi à la main avant se rattache.
  </p>

  <div
    class="depot" :class="{ survol }"
    @dragover.prevent="survol = true" @dragleave="survol = false" @drop.prevent="survol = false; importer($event.dataTransfer?.files)"
  >
    <p>Déposer des relevés PDF ici, ou
      <label class="bouton">Choisir des fichiers… <input type="file" accept="application/pdf" multiple hidden :disabled="occupe" @change="choisir"></label>
    </p>
    <p class="discret">Lu par l'extracteur de la banque (voir <RouterLink to="/fournisseurs">Fournisseurs</RouterLink>) ; un relevé déjà importé est refusé.</p>
  </div>
  <ul v-if="resultats.length" class="resultats">
    <li v-for="(r, i) in resultats" :key="i" :class="r.etat">
      <strong>{{ r.nom }}</strong> : {{ r.texte }}
    </li>
  </ul>

  <p v-if="message" class="message" :class="message.type">{{ message.texte }}</p>

  <nav class="onglets">
    <button type="button" :class="{ actif: onglet === 'a_traiter' }" @click="onglet = 'a_traiter'">À traiter ({{ compteur.a_traiter }})</button>
    <button type="button" :class="{ actif: onglet === 'rapproche' }" @click="onglet = 'rapproche'">Rapprochés</button>
    <button type="button" :class="{ actif: onglet === 'ignore' }" @click="onglet = 'ignore'">Ignorés</button>
    <button type="button" :class="{ actif: onglet === 'releves' }" @click="onglet = 'releves'">Relevés</button>
  </nav>

  <template v-if="onglet === 'releves'">
    <table v-if="releves.length" class="liste">
      <thead>
        <tr><th>Relevé du</th><th>Banque</th><th>Compte</th><th class="nombre">Solde précédent</th><th class="nombre">Nouveau solde</th>
          <th class="nombre">Mouvements</th><th>Suite</th><th>PDF</th><th /></tr>
      </thead>
      <tbody>
        <tr v-for="r in releves" :key="r.id" class="sans-clic">
          <td>{{ dateFr(r.date_releve) }}</td>
          <td>{{ r.banque }}</td>
          <td>{{ r.compte }}</td>
          <td class="nombre">{{ euros(r.solde_precedent) }}</td>
          <td class="nombre">{{ euros(r.nouveau_solde) }}</td>
          <td class="nombre"><a href="#" title="Ses mouvements à traiter" @click.prevent="voirMouvements(r)">{{ r.nb_mouvements }}</a></td>
          <td :class="r.suite === false ? 'ko' : 'ok'">{{ r.suite === false ? '✗ relevé manquant avant' : r.suite ? '✓' : '' }}</td>
          <td><a v-if="r.pdf" :href="api.relevePdfUrl(r.id)" target="_blank">PDF</a></td>
          <td><button type="button" class="danger" :disabled="occupe" @click="supprimerReleve(r)">Supprimer</button></td>
        </tr>
      </tbody>
    </table>
    <p v-else class="discret">Aucun relevé importé.</p>
  </template>

  <template v-else>
    <section class="filtres">
      <select v-model="annee" aria-label="Année">
        <option value="">Toutes les années</option>
        <option v-for="a in annees" :key="a" :value="a">{{ a }}</option>
      </select>
      <select v-model="releveId" aria-label="Relevé">
        <option :value="null">Tous les relevés</option>
        <option v-for="r in relevesDuFiltre" :key="r.id" :value="r.id">
          Relevé du {{ dateFr(r.date_releve) }}{{ new Set(releves.map((x) => x.compte)).size > 1 ? ` (${r.compte})` : '' }}
        </option>
      </select>
      <select v-model="sens" aria-label="Sens">
        <option value="">Crédits et débits</option>
        <option value="credit">Crédits</option>
        <option value="debit">Débits</option>
      </select>
      <span class="discret">{{ affiches.length }} mouvement(s)</span>
      <template v-if="onglet === 'a_traiter'">
        <button v-if="surs.length" type="button" :disabled="occupe" @click="lierTout">{{ surs.length > 1 ? `Rattacher les ${surs.length} déjà saisis` : 'Rattacher le seul déjà saisi' }}</button>
        <button v-if="ignorables.length" type="button" :disabled="occupe" @click="ignorerTout">{{ ignorables.length > 1 ? `Ignorer les ${ignorables.length} débits au motif proposé` : 'Ignorer le débit au motif proposé' }}</button>
      </template>
    </section>

    <table v-if="affiches.length" class="liste mouvements">
      <thead><tr><th>Date</th><th>Opération</th><th class="nombre">Montant</th><th>{{ onglet === 'a_traiter' ? 'Proposition' : onglet === 'ignore' ? 'Motif' : 'Rapproché avec' }}</th></tr></thead>
      <tbody>
        <template v-for="m in affiches" :key="m.id">
          <tr :id="`mouvement-${m.id}`" class="sans-clic" :class="{ surligne: surligne === m.id }">
            <td>{{ dateFr(m.date_operation) }}</td>
            <td>
              <strong>{{ m.libelle }}</strong>
              <div v-if="m.detail" class="detail-mouvement" :title="m.detail">{{ m.detail.split('\n').slice(0, 3).join(' · ') }}</div>
            </td>
            <td class="nombre" :class="estCredit(m) ? 'ok' : ''">
              {{ estCredit(m) ? '+' : '' }}{{ euros(m.montant) }}
              <div v-if="m.statut === 'partiel'" class="discret">reste {{ euros(reste(m)) }}</div>
            </td>
            <td class="actions-mouvement">
              <template v-if="onglet === 'a_traiter'">
                <template v-if="possibles(m).length">
                  <button v-for="p in possibles(m)" :key="cle(p)" type="button" class="principal" :disabled="occupe" @click="lier(m, p)">
                    Rattacher : {{ libellePossible(p) }}
                  </button>
                </template>
                <template v-if="estCredit(m)">
                  <span v-if="!possibles(m).length && resume(m)" class="proposition">
                    {{ resume(m)!.texte }}<span v-if="resume(m)!.ecart" class="ko"> ({{ resume(m)!.ecart }})</span>
                  </span>
                  <button type="button" :disabled="occupe" @click="paiement(m)">Paiement…</button>
                  <button v-if="!possibles(m).length" type="button" :disabled="occupe" @click="rattacherUnPaiement(m)">Rattacher un paiement…</button>
                </template>
                <template v-else>
                  <button v-if="motifPropose(m)" type="button" :disabled="occupe" @click="ignorerAvecMotif(m)">
                    Ignorer : {{ motifPropose(m) }}
                  </button>
                  <button type="button" :disabled="occupe" @click="travaux(m)">Travaux…</button>
                </template>
                <button type="button" :disabled="occupe" @click="ignorer(m)">{{ m.statut === 'partiel' ? 'Justifier le reste…' : 'Ignorer…' }}</button>
              </template>
              <template v-else-if="onglet === 'ignore'">
                {{ m.motif_ignore }}
                <button type="button" :disabled="occupe" @click="retablir(m)">Rétablir</button>
              </template>
              <template v-else>
                <span v-for="p in m.paiements" :key="`p${p.id}`" class="lien-rapproche">
                  Paiement {{ p.locataire }}{{ p.mois ? `, ${p.mois.slice(5, 7)}/${p.mois.slice(0, 4)}` : '' }} ({{ euros(p.total) }})
                  <button type="button" :disabled="occupe" @click="detacher(m, { paiement_id: p.id })">Détacher</button>
                </span>
                <span v-if="m.motif_ignore" class="lien-rapproche discret">reste : {{ m.motif_ignore }}
                  <button type="button" :disabled="occupe" @click="retablir(m)">Retirer</button>
                </span>
                <span v-for="t in m.travaux" :key="`t${t.id}`" class="lien-rapproche">
                  <RouterLink to="/travaux">Travaux : {{ t.description }}</RouterLink> ({{ euros(t.total) }})
                  <button type="button" :disabled="occupe" @click="detacher(m, { travaux_id: t.id })">Détacher</button>
                </span>
              </template>
            </td>
          </tr>

          <tr v-if="saisie && saisie.mouvement.id === m.id" class="sans-clic">
            <td colspan="4">
              <form class="formulaire" @submit.prevent="enregistrer">
                <template v-if="saisie.genre === 'paiement'">
                  <label>Locataire
                    <select v-model="saisie.sejour_id" required>
                      <option :value="null" disabled>Choisir</option>
                      <option v-for="s in sejoursTries" :key="s.id" :value="s.id">{{ nomSejour(s) }}</option>
                    </select>
                  </label>
                  <label>Mois <input v-model="saisie.mois" type="month"></label>
                  <label>Loyer <input v-model="saisie.loyer" class="nombre" size="8"></label>
                  <label>Provision <input v-model="saisie.provision" class="nombre" size="8"></label>
                  <label v-if="regularisationsDe(saisie.sejour_id).length">Régularisation
                    <select v-model="saisie.regularisation_id">
                      <option :value="null">aucune</option>
                      <option v-for="r in regularisationsDe(saisie.sejour_id)" :key="r.id" :value="r.id">
                        {{ dateFr(r.debut) }} → {{ dateFr(r.fin) }} (solde {{ euros(r.solde) }})
                      </option>
                    </select>
                  </label>
                  <label v-if="saisie.regularisation_id">Versement <input v-model="saisie.regularisation" class="nombre" size="8"></label>
                  <label class="note">Note <input v-model="saisie.note" size="20"></label>
                  <span class="discret">reçu {{ euros(reste(m)) }}<template v-if="saisie.proposition.ecart"> · {{ saisie.proposition.ecart }}</template></span>
                </template>
                <template v-else-if="saisie.genre === 'travaux'">
                  <label v-if="immeubles.length > 1">Immeuble
                    <select v-model="saisie.immeuble_id" required>
                      <option v-for="i in immeubles" :key="i.id" :value="i.id">{{ i.nom }}</option>
                    </select>
                  </label>
                  <label>Logement
                    <select v-model="saisie.lot_id">
                      <option :value="null">Immeuble, parties communes</option>
                      <option v-for="l in lots.get(saisie.immeuble_id ?? 0) ?? []" :key="l.id" :value="l.id">{{ l.code }}</option>
                    </select>
                  </label>
                  <label>Fournisseur <input v-model="saisie.fournisseur" required size="18"></label>
                  <label>Description <input v-model="saisie.description" required size="24"></label>
                  <label>Nature
                    <select v-model="saisie.nature">
                      <option v-for="(nom, code) in NATURES_TRAVAUX" :key="code" :value="code">{{ nom }}</option>
                    </select>
                  </label>
                  <label>Facture du <input v-model="saisie.date_facture" type="date" required></label>
                  <span class="discret">payé {{ euros(reste(m)) }} le {{ dateFr(m.date_operation) }}</span>
                </template>
                <template v-else-if="saisie.genre === 'lier'">
                  <label v-if="saisie.choix.length">Paiement saisi
                    <select v-model="saisie.paiement_id" required>
                      <option v-for="p in saisie.choix" :key="p.id" :value="p.id">
                        {{ p.locataire }}, {{ p.mois ? `${p.mois.slice(5, 7)}/${p.mois.slice(0, 4)}` : 'régularisation' }}
                        du {{ dateFr(p.date_paiement) }} : {{ euros(totalPaiement(p)) }}
                      </option>
                    </select>
                  </label>
                  <span v-else class="discret">Aucun paiement non rattaché d'au plus {{ euros(reste(m)) }} à 45 jours près.</span>
                  <span class="discret">reçu {{ euros(reste(m)) }} ; le reste (dépôt de garantie…) restera visible</span>
                </template>
                <template v-else>
                  <span v-if="saisie.mouvement.statut === 'partiel'" class="discret">reste {{ euros(reste(saisie.mouvement)) }} :</span>
                  <label class="note">Motif <input v-model="saisie.motif" required size="30" placeholder="emprunt, assurance, virement interne…"></label>
                </template>
                <button type="submit" class="principal" :disabled="occupe || (saisie.genre === 'lier' && !saisie.paiement_id)">
                  {{ saisie.genre === 'ignorer' ? 'Ignorer' : saisie.genre === 'lier' ? 'Rattacher' : 'Enregistrer' }}
                </button>
                <button type="button" @click="saisie = null">Annuler</button>
              </form>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
    <p v-else class="discret">Aucun mouvement.</p>
  </template>
</template>

<style scoped>
.depot {
  border: 2px dashed var(--bord);
  border-radius: 8px;
  padding: 0.8rem 1rem;
  text-align: center;
}

.depot.survol {
  border-color: var(--accent);
  background: var(--surface);
}

.depot p {
  margin: 0.3rem 0;
}

.resultats {
  font-size: 0.85rem;
  max-height: 12rem;
  overflow: auto;
}

.resultats .erreur {
  color: var(--ko);
}

.resultats .doublon {
  color: var(--discret);
}

.resultats .importe {
  color: var(--ok);
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

.mouvements td {
  vertical-align: top;
}

.mouvements tr.surligne td {
  background: #fff1a8;
}

.detail-mouvement {
  font-size: 0.8rem;
  color: var(--discret);
  max-width: 34rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions-mouvement {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem;
}

.proposition {
  font-size: 0.85rem;
}

.lien-rapproche {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  margin-right: 0.6rem;
}
</style>

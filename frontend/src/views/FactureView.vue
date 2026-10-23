<script setup lang="ts">
import { VGrid, type ColumnRegular } from '@revolist/vue3-datagrid'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, RouterLink, useRouter } from 'vue-router'

import {
  api, ApiError, CATEGORIES, ENERGIES, STATUTS, type Controle, type Facture, type FactureDetail, type FactureResumee,
  type FactureSaisie, type LiensFacture, type MouvementPourFacture, type ReglementFacture, type RegularisationTouchee,
} from '../api'
import { dateFr, depuisGrille, euros, ligneVide, nombreApi, nombreFr, versGrille, type LigneGrille } from '../format'

const props = defineProps<{ id: number }>()
const router = useRouter()

const facture = ref<Facture | null>(null)
const entete = reactive({ numero: '', date_facture: '', montant_ttc: '', energie: 'gaz' as Facture['energie'], note: '' })
const lignes = ref<LigneGrille[]>([])
const controle = ref<Controle | null>(null)
const modifie = ref(false)
const occupe = ref(false)
const message = ref<{ texte: string, type: 'info' | 'erreur' } | null>(null)
const ligneActive = ref<number | null>(null)

const liens = ref<LiensFacture | null>(null)
// Its payments by bank movements (ADR 0022), and the debits offered to link one
const reglements = ref<ReglementFacture[]>([])
const reglement = ref<{ mouvements: MouvementPourFacture[], choisi: number | null } | null>(null)
// Sent regularisations touched by a replacement just made: to check (ADR 0017)
const touchees = ref<RegularisationTouchee[]>([])

const validee = computed(() => facture.value?.statut === 'validee')
// Validated or replaced: never edited (ADR 0003, 0017)
const figee = computed(() => facture.value !== null && facture.value.statut !== 'a_verifier')

const colonnes: ColumnRegular[] = [
  { prop: 'categorie', name: 'Catégorie', size: 130 },
  { prop: 'libelle', name: 'Libellé', size: 280 },
  { prop: 'debut', name: 'Début', size: 110 },
  { prop: 'fin', name: 'Fin', size: 110 },
  { prop: 'kwh', name: 'kWh', size: 75 },
  { prop: 'montant_ht', name: 'HT', size: 85 },
  { prop: 'taux_tva', name: 'TVA %', size: 65 },
  { prop: 'montant_ttc', name: 'TTC', size: 85 },
  { prop: 'affectation', name: 'Affectation', size: 110 },
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
    appliquer(await api.facture(props.id))
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}

function appliquer(detail: FactureDetail) {
  facture.value = detail.facture
  liens.value = detail.liens
  reglements.value = detail.reglements
  Object.assign(entete, {
    numero: detail.facture.numero,
    date_facture: detail.facture.date_facture,
    montant_ttc: nombreFr(detail.facture.montant_ttc),
    energie: detail.facture.energie,
    note: detail.facture.note ?? '',
  })
  lignes.value = detail.lignes.map(versGrille)
  controle.value = detail.controle
  surligner()
  modifie.value = false
}

const saisie = (): FactureSaisie => ({
  numero: entete.numero,
  date_facture: entete.date_facture,
  montant_ttc: nombreApi(entete.montant_ttc) ?? '',
  energie: entete.energie,
  note: entete.note.trim() || null,
  lignes: lignes.value.map(depuisGrille),
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
  const numero = ++sequence
  const { montant_ttc, lignes: aControler } = saisie()
  try {
    const resultat = await api.controler({ montant_ttc, lignes: aControler })
    // An older answer arriving late must not overwrite a newer one
    if (numero === sequence) {
      controle.value = resultat
      surligner()
    }
  } catch (e) {
    message.value = { texte: `Contrôle impossible : ${(e as Error).message}`, type: 'erreur' }
  }
}

/** Highlights the lines that have a finding: an error wins over a warning. */
function surligner() {
  const parLigne = new Map<number, 'erreur' | 'avertissement'>()
  for (const c of controle.value?.constats ?? []) {
    if (c.ligne !== null && parLigne.get(c.ligne) !== 'erreur') {
      parLigne.set(c.ligne, c.severite)
    }
  }
  lignes.value = lignes.value.map((l, i) => {
    const severite = parLigne.get(i)
    return { ...l, _classe: severite ? `ligne-${severite}` : '' }
  })
}

const constats = computed(() =>
  [...(controle.value?.constats ?? [])].sort((a, b) =>
    (a.severite === b.severite ? 0 : a.severite === 'erreur' ? -1 : 1) || (a.ligne ?? -1) - (b.ligne ?? -1)),
)

// ---------------------------------------------------------------- grid events

// A single cell edit carries `prop` (and also a `data` key); a range edit (paste, autofill) carries `data` only
type EditDetail =
  | { prop: keyof LigneGrille, rowIndex: number, val: unknown }
  | { data: Record<number, Partial<LigneGrille>> }

function apresEdition(event: CustomEvent<EditDetail>) {
  const detail = event.detail
  if ('prop' in detail) {
    const ligne = lignes.value[detail.rowIndex]
    if (ligne) {
      ligne[detail.prop] = String(detail.val ?? '')
    }
  } else {
    for (const [index, valeurs] of Object.entries(detail.data)) {
      const ligne = lignes.value[Number(index)]
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
  lignes.value = [...lignes.value, ligneVide()]
  changer()
}

function supprimerLigne() {
  if (ligneActive.value === null || !lignes.value[ligneActive.value]) {
    return
  }
  lignes.value = lignes.value.filter((_, i) => i !== ligneActive.value)
  ligneActive.value = null
  changer()
}

// ---------------------------------------------------------------- actions

async function executer(action: () => Promise<FactureDetail & { regularisations?: RegularisationTouchee[] }>, succes: string) {
  occupe.value = true
  try {
    const detail = await action()
    appliquer(detail)
    touchees.value = detail.regularisations ?? []
    message.value = { texte: succes, type: 'info' }
    return true
  } catch (e) {
    if (e instanceof ApiError && e.body.controle) {
      controle.value = e.body.controle as Controle
      surligner()
    }
    message.value = { texte: (e as Error).message, type: 'erreur' }
    return false
  } finally {
    occupe.value = false
  }
}

const enregistrer = () => executer(() => api.enregistrer(props.id, saisie()), 'Brouillon enregistré')

// ---------------------------------------------------------------- payments (ADR 0022)

async function ouvrirReglement() {
  try {
    const mouvements = await api.mouvementsPourFacture(props.id)
    reglement.value = { mouvements, choisi: mouvements.find((m) => m.correspond)?.id ?? null }
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
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
      ? `Facture validée : elle remplace la facture corrigée (${corrige.fournisseur} n° ${corrige.numero}) dans les décomptes`
      : 'Facture validée : elle entre dans les décomptes',
  )
}

// ---------------------------------------------------------------- replacing a validated invoice (ADR 0017)

const remplacement = ref<{ candidates: FactureResumee[], par: number | null, motif: string } | null>(null)

async function ouvrirRemplacement() {
  if (!facture.value) {
    return
  }
  const candidates = (await api.factures(facture.value.immeuble_id))
    .filter((f) => f.statut === 'validee' && f.id !== facture.value?.id)
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
    await router.push({ name: 'facture', params: { id: copie.facture.id } })
  } catch (e) {
    const existante = e instanceof ApiError ? e.body.facture_id as number | undefined : undefined
    message.value = { texte: (e as Error).message, type: 'erreur' }
    if (existante) {
      await router.push({ name: 'facture', params: { id: existante } })
    }
  } finally {
    occupe.value = false
  }
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
      message.value = { texte: `Ce PDF est la facture ${autre}, pas ${facture.value?.fournisseur} n° ${facture.value?.numero}`, type: 'erreur' }
      return
    }
    const detail = await api.joindrePdf(props.id, file)
    facture.value = detail.facture
    versionPdf.value++
    message.value = { texte: 'PDF de la facture enregistré', type: 'info' }
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  } finally {
    occupe.value = false
  }
}

/** The invoice an extractor reads in the PDF when it is not this one (ADR 0013), else null. */
async function autreFacture(file: File): Promise<string | null> {
  try {
    const { candidats, lire, morceauxDuPdf } = await import('../extraction/navigateur')
    const pages = await morceauxDuPdf(file)
    for (const candidat of candidats(pages, await api.extracteurs())) {
      const numero = lire(pages, candidat).numero.valeur
      const fournisseur = candidat.enregistre.fournisseur
      if (numero && (fournisseur !== facture.value?.fournisseur || numero !== facture.value?.numero)) {
        return `${fournisseur} n° ${numero}`
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
  const texte = liens.value?.corrige
    ? 'Supprimer ce brouillon ? La correction est abandonnée, la facture d\'origine reste validée.'
    : 'Supprimer ce brouillon ? Le PDF pourra être importé à nouveau.'
  if (!confirm(texte)) {
    return
  }
  try {
    await api.supprimer(props.id)
    modifie.value = false
    await router.push({ name: 'factures' })
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
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
  <p><RouterLink :to="{ name: 'factures' }">← Factures</RouterLink></p>

  <template v-if="facture">
    <section class="entete-facture">
      <h1>
        {{ facture.fournisseur }}
        <span class="pastille" :class="facture.statut">{{ STATUTS[facture.statut] }}</span>
      </h1>
      <div class="champs">
        <label>N° <input v-model="entete.numero" :disabled="figee" @input="changer"></label>
        <label>Date <input v-model="entete.date_facture" type="date" :disabled="figee" @input="changer"></label>
        <label>Énergie
          <select v-model="entete.energie" :disabled="figee" @change="changer">
            <option v-for="(nom, code) in ENERGIES" :key="code" :value="code">{{ nom }}</option>
          </select>
        </label>
        <label>Total imprimé TTC
          <input v-model="entete.montant_ttc" class="nombre" :disabled="figee" @input="changer">
        </label>
        <label class="note">Note <input v-model="entete.note" :disabled="figee" @input="changer"></label>
      </div>
    </section>

    <section v-if="controle" class="bandeau" :class="controle.validable ? 'ok' : 'ko'">
      <span>Somme des lignes <strong>{{ euros(controle.total_lignes) }}</strong></span>
      <template v-if="entete.montant_ttc.trim()">
        <span>Total imprimé <strong>{{ euros(nombreApi(entete.montant_ttc)) }}</strong></span>
        <span>Écart <strong :class="controle.ok ? 'ok' : 'ko'">{{ euros(controle.ecart) }}</strong></span>
      </template>
      <span v-else>Total imprimé <strong class="ko">à saisir</strong></span>
      <span>{{ controle.validable ? '✓ Contrôles bloquants passés' : '✗ Validation impossible' }}</span>
      <span v-if="modifie" class="discret">modifications non enregistrées</span>
    </section>

    <!-- Replacement links (ADR 0017) -->
    <p v-if="facture.statut === 'remplacee'" class="message avertissement">
      Facture <strong>remplacée</strong> le {{ dateFr(facture.remplacee_le?.slice(0, 10) ?? null) }}
      <template v-if="liens?.remplacante">
        par <RouterLink :to="{ name: 'facture', params: { id: liens.remplacante.id } }">{{ liens.remplacante.fournisseur }} n° {{ liens.remplacante.numero }}</RouterLink>
      </template>
      ({{ facture.motif_remplacement }}) : elle n'entre plus dans les décomptes ni dans la synthèse fiscale.
    </p>
    <p v-if="liens?.corrige && facture.statut === 'a_verifier'" class="message info">
      Correction de <RouterLink :to="{ name: 'facture', params: { id: liens.corrige.id } }">{{ liens.corrige.fournisseur }} n° {{ liens.corrige.numero }}</RouterLink>,
      validée : à la validation de ce brouillon, elle est remplacée ; jusque-là, c'est elle qui compte. La note est reprise
      dans le motif.
    </p>
    <p v-if="liens?.correction" class="message info">
      Correction en cours :
      <RouterLink :to="{ name: 'facture', params: { id: liens.correction.id } }">brouillon {{ liens.correction.fournisseur }} n° {{ liens.correction.numero }}</RouterLink>.
    </p>
    <p v-if="liens?.remplacees.length" class="discret">
      Remplace :
      <template v-for="(r, i) in liens.remplacees" :key="r.id">
        {{ i ? ', ' : '' }}<RouterLink :to="{ name: 'facture', params: { id: r.id } }">{{ r.fournisseur }} n° {{ r.numero }}</RouterLink>
      </template>
    </p>

    <p v-if="message" class="message" :class="message.type">{{ message.texte }}</p>
    <div v-if="touchees.length" class="message avertissement">
      Régularisations envoyées dont la période touche cette facture : leur décompte refait peut différer du montant
      envoyé (« à rectifier » s'il diffère de plus de 5 €).
      <ul>
        <li v-for="r in touchees" :key="r.id">
          <RouterLink :to="{ name: 'regularisation', params: { id: r.id } }">{{ r.locataire }} ({{ r.lot }}), {{ dateFr(r.debut) }} → {{ dateFr(r.fin) }}</RouterLink>
          : solde envoyé {{ euros(r.solde) }}
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
            :source="lignes"
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
          <li v-for="(c, i) in constats" :key="i" :class="c.severite">
            <strong>{{ c.ligne === null ? 'Facture' : `Ligne ${c.ligne + 1}` }}</strong> : {{ c.message }}
          </li>
        </ul>

        <div class="actions">
          <template v-if="!figee">
            <button type="button" :disabled="occupe || !modifie" @click="enregistrer">Enregistrer le brouillon</button>
            <button type="button" class="principal" :disabled="occupe || !controle?.validable" @click="valider">
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
        <section v-if="facture.statut === 'validee' || reglements.length" class="reglements">
          <h2>
            Paiement
            <span v-if="Number(facture.reste) <= 0" class="ok">✓ payée</span>
            <span v-else-if="reglements.length">reste {{ euros(facture.reste) }} à payer</span>
            <span v-else class="discret">aucun mouvement bancaire rattaché</span>
          </h2>
          <ul v-if="reglements.length">
            <li v-for="r in reglements" :key="r.id">
              {{ dateFr(r.date_paiement) }} · {{ r.libelle }} :
              <template v-if="Number(r.montant) < 0">remboursement de <strong>{{ euros(r.montant.replace('-', '')) }}</strong></template>
              <strong v-else>{{ euros(r.montant) }}</strong>
              <RouterLink :to="{ name: 'banque', query: { mouvement: r.mouvement_id } }">voir dans la banque</RouterLink>
              <button v-if="validee" type="button" :disabled="occupe" @click="detacherReglement(r)">Détacher</button>
            </li>
          </ul>
          <template v-if="validee">
            <button v-if="!reglement" type="button" :disabled="occupe" @click="ouvrirReglement">Rattacher un paiement…</button>
            <form v-else class="formulaire" @submit.prevent="regler">
              <label v-if="reglement.mouvements.length">Mouvement bancaire
                <select v-model="reglement.choisi" required>
                  <option :value="null" disabled>Choisir un débit (ou un crédit qui la rembourse)</option>
                  <option v-for="m in reglement.mouvements" :key="m.id" :value="m.id">
                    {{ m.correspond ? '✓ même montant · ' : '' }}{{ dateFr(m.date_operation) }} · {{ m.libelle }} : {{ euros(m.montant) }}{{ Number(m.reste) < Math.abs(Number(m.montant)) ? ` (reste ${euros(m.reste)})` : '' }}
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
                {{ f.fournisseur }} n° {{ f.numero }} du {{ dateFr(f.date_facture) }} ({{ euros(f.montant_ttc) }})
              </option>
            </select>
          </label>
          <label class="note">Motif <input v-model="remplacement.motif" required placeholder="doublon, facture rectificative…"></label>
          <button type="submit" class="principal" :disabled="occupe || !remplacement.par || !remplacement.motif.trim()">Remplacer</button>
          <button type="button" @click="remplacement = null">Annuler</button>
        </form>
      </div>

      <div class="colonne-pdf">
        <template v-if="facture.pdf">
          <div class="outils">
            <a class="bouton" :href="api.pdfUrl(facture.id)" target="_blank">Ouvrir dans un onglet</a>
            <label class="bouton">
              Remplacer le PDF…
              <input type="file" accept="application/pdf" hidden @change="choisirPdf">
            </label>
          </div>
          <iframe :key="versionPdf" class="apercu" :src="`${api.pdfUrl(facture.id)}?v=${versionPdf}`" title="Facture PDF" />
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

  <p v-else-if="message" class="message erreur">{{ message.texte }}</p>
</template>

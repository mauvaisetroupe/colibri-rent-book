<script setup lang="ts">
import Big from 'big.js'
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'

import { AFFECTATIONS, api, ENERGIES, type Energie, type ExtracteurEnregistre, type FactureAvecPdf } from '../api'
import { MOTEUR, REGLAGES_PAR_DEFAUT, type Morceau } from '../extraction/contrat'
import { creerEditeur, type Editeur } from '../extraction/editeur'
import modele from '../extraction/modeles/modele.ts?raw'
import { charger, documentDe, energieDe, extraire, reconnait, type Correspondance, type Extraction } from '../extraction/moteur'
import type { Redaction } from '../extraction/extractor'
import { lignesMasquees, reglesDuDocument, type SegmentMasque } from '../extraction/masquage'
import { copieEnImages, morceauxDuPdf } from '../extraction/navigateur'
import { comparer, type Comparaison } from '../extraction/nonRegression'
import { surligner, type LigneSurlignee } from '../extraction/surlignage'
import { dateFr, euros } from '../format'

// Editing an invoice extractor (ADR 0013), from a saved version or from the template of a new supplier: saving
// creates the next version, the one edited is never changed. The code runs here, in the browser, on a sample PDF
// while it is typed. Two tabs on the same code: « Extraction » (what is read) and « Masquage » (what the copy joined to
// the supporting documents hides, ADR 0024); each checks its work in a window: the reading of every invoice of the
// supplier, the copy of the working PDF.

// The version the edition starts from; null: a new supplier, from the template
const props = defineProps<{ id: number | null }>()
const router = useRouter()
const route = useRoute()
// Page of the supplier, to go back to (none for a new supplier until its first version is saved)
const fournisseurId = ref<number | null>(null)

const enregistres = ref<ExtracteurEnregistre[]>([])
const base = ref<ExtracteurEnregistre | null>(null)
const form = reactive({ fournisseur: '', energie: 'eau' as Energie, note: '', reglages: { ...REGLAGES_PAR_DEFAUT } })
const message = ref<{ texte: string, type: 'info' | 'erreur' } | null>(null)
// Shown once the saved version is opened (the route changes)
let annonce: { texte: string, type: 'info' } | null = null

const zoneEditeur = ref<HTMLElement | null>(null)
let editeur: Editeur | null = null

const facturesExemple = ref<FactureAvecPdf[]>([])
// The sample PDF: its pieces of text, and its address to open it in another tab
const exemple = shallowRef<{ nom: string, pages: Morceau[][], url: string } | null>(null)
// Lines of the text, cut where the regular expressions of the code matched
const lignesTexte = shallowRef<LigneSurlignee[]>([])
const erreursTs = ref<string[]>([])
const erreurCode = ref<string | null>(null)
const reconnu = ref<boolean | null>(null)
const extraction = shallowRef<Extraction | null>(null)
const code = ref('')
// Test on every invoice of the supplier: one result per invoice id; « perimes » once the code or the settings change
const comparaisons = ref<Map<number, Comparaison> | null>(null)
const comparaisonsPerimees = ref(false)
const exempleId = ref<number | null>(null)
const occupe = ref(false)
// « ?onglet=masquage »: opened from an invoice whose version for the tenant still shows something personal
const onglet = ref<'extraction' | 'masquage'>(route.query.onglet === 'masquage' ? 'masquage' : 'extraction')
const fenetrePdf = ref<HTMLDialogElement | null>(null)
const fenetreVerification = ref<HTMLDialogElement | null>(null)

const prochaineVersion = computed(() =>
  1 + Math.max(0, ...enregistres.value.filter((e) => e.fournisseur === form.fournisseur.trim()).map((e) => e.version)))

const sommeLignes = computed(() =>
  (extraction.value?.lignes.valeur ?? []).reduce((s, l) => s.plus(l.montant_ttc || 0), new Big(0)).round(2, Big.roundHalfUp))

const totalOk = computed(() => {
  const total = extraction.value?.total.valeur
  return total ? sommeLignes.value.minus(total).abs().lte('0.05') : null
})

const enregistrable = computed(() =>
  !!form.fournisseur.trim() && !!code.value && erreursTs.value.length === 0 && !erreurCode.value && !occupe.value)

onMounted(async () => {
  editeur = creerEditeur(zoneEditeur.value!, modele)
  editeur.surChangement(programmer)
  await ouvrir()
  try {
    termes.value = await api.termesMasques()
    programmer()
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
})

watch(() => props.id, ouvrir)

async function ouvrir() {
  try {
    enregistres.value = await api.extracteurs()
    const version = props.id === null ? null : enregistres.value.find((e) => e.id === props.id)
    if (version) {
      await choisir(version)
    } else {
      nouveau()
      if (props.id !== null) {
        message.value = { texte: 'Extracteur introuvable', type: 'erreur' }
      }
    }
    fournisseurId.value = (await api.fournisseurs()).find((f) => f.nom === form.fournisseur)?.id ?? null
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
  if (annonce) {
    message.value = annonce
    annonce = null
  }
}

onBeforeUnmount(() => {
  editeur?.detruire()
  fermerPleinEcran()
  oublierCopie()
})

// ---------------------------------------------------------------- step 2 in full screen: only the editor and the text
// scroll, the page does not

const pleinEcran = ref(false)

function surTouche(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    fermerPleinEcran()
  }
}

function fermerPleinEcran() {
  pleinEcran.value = false
  document.documentElement.style.overflow = ''
  removeEventListener('keydown', surTouche)
}

function basculerPleinEcran() {
  if (pleinEcran.value) {
    fermerPleinEcran()
    return
  }
  pleinEcran.value = true
  document.documentElement.style.overflow = 'hidden'
  addEventListener('keydown', surTouche)
}

async function choisir(e: ExtracteurEnregistre) {
  base.value = e
  Object.assign(form, { fournisseur: e.fournisseur, energie: e.energie, note: '', reglages: { ...e.reglages } })
  editeur?.remplacer(e.source)
  comparaisons.value = null
  message.value = null
  await chargerFacturesExemple()
}

function nouveau() {
  base.value = null
  // « Écrire un extracteur » from the page of a supplier without one: its name is given
  const fournisseur = typeof route.query.fournisseur === 'string' ? route.query.fournisseur : ''
  Object.assign(form, { fournisseur, energie: 'eau', note: '', reglages: { ...REGLAGES_PAR_DEFAUT } })
  editeur?.remplacer(modele)
  facturesExemple.value = []
  exemple.value = null
  comparaisons.value = null
  message.value = null
  if (fournisseur) {
    chargerFacturesExemple()
  }
}

async function chargerFacturesExemple() {
  facturesExemple.value = form.fournisseur ? await api.facturesDuFournisseur(form.fournisseur) : []
  // « ?facture=12 »: opened from that invoice, which becomes the working PDF
  const demandee = facturesExemple.value.find((f) => String(f.id) === route.query.facture)
  const premiere = demandee ?? facturesExemple.value[0]
  if (premiere && (demandee || !exemple.value?.nom.startsWith(`${form.fournisseur} `))) {
    await exempleFacture(premiere)
  } else {
    programmer()
  }
}

async function exempleFacture(f: FactureAvecPdf) {
  exempleId.value = f.id
  try {
    const pdf = await (await fetch(api.pdfUrl(f.id))).blob()
    remplacerExemple({ nom: `${form.fournisseur} n° ${f.numero}`, pages: await morceauxDuPdf(pdf), url: api.pdfUrl(f.id) })
  } catch (e) {
    message.value = { texte: `PDF de la facture ${f.numero} illisible : ${(e as Error).message}`, type: 'erreur' }
  }
  programmer()
}

function remplacerExemple(nouveau: NonNullable<typeof exemple.value>) {
  if (exemple.value?.url.startsWith('blob:')) {
    URL.revokeObjectURL(exemple.value.url)
  }
  exemple.value = nouveau
  oublierCopie()
}

// ---------------------------------------------------------------- tab « Masquage » (ADR 0024)

// Terms masked on every invoice; the redactions of the code being edited; the text of the sample PDF as masked
const termes = ref<string[]>([])
const regles = shallowRef<Redaction[]>([])
const erreurMasquage = ref<string | null>(null)
const lignesMasques = shallowRef<SegmentMasque[][]>([])
const zonesFixes = computed(() => regles.value.filter((r) => !('text' in r) && !('pattern' in r)).length)
const aRedactions = computed(() => /^\s*redactions\s*\(/m.test(code.value) || regles.value.length > 0)
// Text selected in the text of the PDF, to add to the masked terms
const selection = ref('')

function masquer(extracteur: ReturnType<typeof charger>, document: ReturnType<typeof documentDe>) {
  try {
    regles.value = reglesDuDocument(extracteur, document)
  } catch (e) {
    erreurMasquage.value = `redactions : ${(e as Error).message}`
  }
  lignesMasques.value = lignesMasquees(document.lines, termes.value, regles.value)
}

function noterSelection() {
  const texte = window.getSelection()?.toString().trim() ?? ''
  selection.value = texte.includes('\n') ? '' : texte
}

async function modifierTermes(nouveaux: string[], succes: string) {
  try {
    termes.value = await api.modifierTermesMasques(nouveaux)
    message.value = { texte: succes, type: 'info' }
    selection.value = ''
    oublierCopie()
    programmer()
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}

const ajouterTerme = () => modifierTermes([...termes.value, selection.value],
  `« ${selection.value} » sera masqué sur toutes les factures (les copies déjà faites sont à refaire)`)
const retirerTerme = (terme: string) => modifierTermes(termes.value.filter((t) => t !== terme),
  `« ${terme} » n'est plus masqué (les copies déjà faites sont à refaire)`)

const REDACTIONS = `
  /** What to mask on the copy joined to the supporting documents, on top of the masked terms (ADR 0024). */
  redactions(): Redaction[] {
    return [
      // { text: 'a printed text' },
      // { pattern: /a regular expression, on one line/ },
      // { page: 1, x0: 0, y0: 0.9, x1: 1, y1: 1 }, // a fixed area: fractions of the page from its top-left corner
    ]
  }
`

/** Adds a commented redactions() at the end of the class, and Redaction to the import of 'extractor'. */
function ajouterRedactions() {
  if (!editeur) {
    return
  }
  let source = editeur.source()
  if (/^\s*redactions\s*\(/m.test(source)) {
    message.value = { texte: 'La méthode redactions() est déjà dans le code', type: 'info' }
    return
  }
  const fin = source.lastIndexOf('}')
  if (fin < 0) {
    return
  }
  source = `${source.slice(0, fin).trimEnd()}\n${REDACTIONS}${source.slice(fin)}`
  source = source.replace(/import \{([^}]*)\} from 'extractor'/, (tout, noms: string) =>
    (/\bRedaction\b/.test(noms) ? tout : `import {${noms.trimEnd()}, type Redaction } from 'extractor'`))
  editeur.remplacer(source)
}

// ---------------------------------------------------------------- checking the work of a tab

/** Opens the window of the tab, and starts what it shows: every invoice read again, or the copy of the working PDF. */
function ouvrirVerification() {
  fenetreVerification.value?.showModal()
  if (onglet.value === 'extraction') {
    if (facturesExemple.value.length && (!comparaisons.value || comparaisonsPerimees.value) && !occupe.value) {
      tester()
    }
  } else {
    apercuCopie()
  }
}

/** Result of the check of an invoice: ok, ko, or not read yet. */
function resultatDe(f: FactureAvecPdf): 'ok' | 'ko' | 'attente' {
  const c = comparaisons.value?.get(f.id)
  return !c ? 'attente' : c.differences.length ? 'ko' : 'ok'
}

/** An invoice of the check becomes the working PDF. */
function travaillerSur(f: FactureAvecPdf) {
  fenetreVerification.value?.close()
  exempleFacture(f)
}

// ---------------------------------------------------------------- copy joined to the supporting documents (ADR 0024)

// The copy of the sample PDF with the code being edited: what redactions() and the masked terms hide
const copie = ref<{ url: string, zones: number } | null>(null)

function oublierCopie() {
  if (copie.value) {
    URL.revokeObjectURL(copie.value.url)
    copie.value = null
  }
}

async function apercuCopie() {
  if (!exemple.value) {
    return
  }
  occupe.value = true
  try {
    const contenu = new Uint8Array(await (await fetch(exemple.value.url)).arrayBuffer())
    const { pdf, zones } = await copieEnImages(contenu, await api.termesMasques(),
      { classe: charger(code.value), reglages: form.reglages })
    oublierCopie()
    copie.value = { url: URL.createObjectURL(new Blob([pdf as Uint8Array<ArrayBuffer>], { type: 'application/pdf' })), zones: zones.length }
  } catch (e) {
    message.value = { texte: `Copie jointe : ${(e as Error).message}`, type: 'erreur' }
  } finally {
    occupe.value = false
  }
}

async function exempleFichier(event: Event) {
  const input = event.target as HTMLInputElement
  const fichier = input.files?.[0]
  if (fichier) {
    try {
      remplacerExemple({ nom: fichier.name, pages: await morceauxDuPdf(fichier), url: URL.createObjectURL(fichier) })
    } catch {
      message.value = { texte: `${fichier.name} : PDF illisible`, type: 'erreur' }
    }
    programmer()
  }
  input.value = ''
}

// ---------------------------------------------------------------- live run

let minuterie: ReturnType<typeof setTimeout> | undefined
let sequence = 0

function programmer() {
  if (comparaisons.value) {
    comparaisonsPerimees.value = true
  }
  clearTimeout(minuterie)
  minuterie = setTimeout(analyser, 300)
}

watch(() => ({ ...form.reglages }), programmer)

async function analyser() {
  if (!editeur) {
    return
  }
  const numero = ++sequence
  const { code: js, erreurs } = await editeur.compiler()
  if (numero !== sequence) {
    return
  }
  code.value = js
  erreursTs.value = erreurs
  const document = exemple.value ? documentDe(exemple.value.pages, form.reglages) : null
  lignesTexte.value = (document?.lines ?? []).map((texte) =>
    ({ segments: [{ texte, champ: null }], trouvee: false, dansZone: false, erreur: null }))
  erreurCode.value = null
  reconnu.value = null
  extraction.value = null
  lignesMasques.value = (document?.lines ?? []).map((texte) => [{ texte, origine: null }])
  regles.value = []
  erreurMasquage.value = null
  let extracteur
  try {
    extracteur = charger(js)
    form.energie = energieDe(extracteur)
  } catch (e) {
    erreurCode.value = (e as Error).message
    return
  }
  if (document) {
    reconnu.value = reconnait(extracteur, document)
    const correspondances: Correspondance[] = []
    extraction.value = extraire(extracteur, document, correspondances)
    const { lignesEnErreur: enErreur, zone, trouvees } = extraction.value
    lignesTexte.value = surligner(document, correspondances, { enErreur, zone, trouvees })
    masquer(extracteur, document)
  }
}

// ---------------------------------------------------------------- non-regression, then save

async function tester() {
  occupe.value = true
  try {
    const extracteur = charger(code.value)
    const resultats = new Map<number, Comparaison>()
    for (const f of facturesExemple.value) {
      resultats.set(f.id, await comparer(extracteur, form.reglages, f))
      comparaisons.value = new Map(resultats)
    }
    comparaisonsPerimees.value = false
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  } finally {
    occupe.value = false
  }
}

const reussies = computed(() => [...(comparaisons.value?.values() ?? [])].filter((c) => c.differences.length === 0).length)
const enEchec = computed(() => [...(comparaisons.value?.values() ?? [])].filter((c) => c.differences.length > 0))

/** ✓ or ✗ in front of an invoice of the selector, once tested. */
function marque(f: FactureAvecPdf) {
  const c = comparaisons.value?.get(f.id)
  return c ? (c.differences.length ? '✗ ' : '✓ ') : ''
}

function choisirExemple(event: Event) {
  const f = facturesExemple.value.find((x) => x.id === Number((event.target as HTMLSelectElement).value))
  if (f) {
    exempleFacture(f)
  }
}

async function enregistrer() {
  if (!editeur || !enregistrable.value) {
    return
  }
  occupe.value = true
  try {
    const cree = await api.nouvelleVersion({
      fournisseur: form.fournisseur.trim(), energie: form.energie, reglages: { ...form.reglages },
      source: editeur.source(), code: code.value, moteur: MOTEUR, note: form.note.trim() || null,
    })
    annonce = { texte: `${cree.fournisseur} : version ${cree.version} enregistrée`, type: 'info' }
    await router.push({ name: 'extracteur', params: { id: cree.id } })
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  } finally {
    occupe.value = false
  }
}
</script>

<template>
  <RouterLink v-if="fournisseurId" :to="{ name: 'fournisseur', params: { id: fournisseurId } }">← {{ form.fournisseur }}</RouterLink>
  <RouterLink v-else :to="{ name: 'fournisseurs' }">← Fournisseurs</RouterLink>
  <section class="entete-page">
    <h1>
      {{ base ? `${base.fournisseur}, à partir de la version ${base.version}` : 'Nouveau fournisseur' }}
    </h1>
    <p v-if="base" class="discret">
      Version {{ base.version }} du {{ dateFr(base.cree_le.slice(0, 10)) }}{{ base.note ? ` : ${base.note}` : '' }}
      · {{ base.nb_factures }} facture(s) lue(s). Elle ne change pas : enregistrer crée la version {{ prochaineVersion }}.
    </p>
  </section>

  <p v-if="message" class="message" :class="message.type">{{ message.texte }}</p>

  <div class="champs">
    <label>Fournisseur <input v-model="form.fournisseur" :readonly="!!base" size="14"></label>
    <label>Énergie
      <select v-model="form.energie" disabled>
        <option v-for="(nom, c) in ENERGIES" :key="c" :value="c">{{ nom }}</option>
      </select>
    </label>
    <label class="note">Note de version <input v-model="form.note" size="40" placeholder="ce qui change"></label>
  </div>

  <nav class="onglets">
    <button type="button" :class="{ actif: onglet === 'extraction' }" @click="onglet = 'extraction'">Extraction</button>
    <button type="button" :class="{ actif: onglet === 'masquage' }" @click="onglet = 'masquage'">Masquage</button>
    <span class="pdf-travail">
      PDF de travail : <strong>{{ exemple?.nom ?? 'aucun' }}</strong>
      <button type="button" :class="{ principal: !exemple }" @click="fenetrePdf?.showModal()">Changer…</button>
    </span>
  </nav>

  <section class="phase" :class="{ 'plein-ecran': pleinEcran }">
    <div class="titre-phase">
      <p v-if="onglet === 'masquage'" class="legende-couleurs">
        <mark class="masque-termes">termes masqués</mark><mark class="masque-extracteur">redactions()</mark>
        <span v-if="!selection" class="discret">Sélectionner un texte du PDF pour le masquer sur toutes les factures.</span>
        <button v-else type="button" class="principal" @click="ajouterTerme">
          Masquer « {{ selection.length > 40 ? `${selection.slice(0, 40)}…` : selection }} » sur toutes les factures
        </button>
        <button v-if="!aRedactions" type="button" @click="ajouterRedactions">Ajouter redactions() au code</button>
      </p>
      <p v-else class="legende-couleurs">
        <mark class="numero">invoiceNumber</mark><mark class="date">invoiceDate</mark><mark class="total">total</mark><span
          class="zone">linesZone</span><span class="trouvee">findLine</span><mark class="lecture">readLine</mark>
      </p>
      <button type="button" @click="basculerPleinEcran">{{ pleinEcran ? 'Réduire (Échap)' : 'Agrandir ⤢' }}</button>
    </div>
    <div class="cote-a-cote">
      <div>
        <div ref="zoneEditeur" class="editeur" />
        <ul v-if="erreursTs.length || erreurCode || erreurMasquage" class="erreurs-code">
          <li v-for="(e, i) in erreursTs" :key="i">{{ e }}</li>
          <li v-if="erreurCode">{{ erreurCode }}</li>
          <li v-if="onglet === 'masquage' && erreurMasquage">{{ erreurMasquage }}</li>
        </ul>
      </div>
      <ol v-if="onglet === 'masquage' && lignesMasques.length" class="texte-pdf" @mouseup="noterSelection">
        <li v-for="(segments, i) in lignesMasques" :key="i"><code><template v-for="(seg, j) in segments" :key="j"><mark
          v-if="seg.origine" :class="`masque-${seg.origine}`">{{ seg.texte }}</mark><template v-else>{{ seg.texte }}</template></template></code></li>
      </ol>
      <ol v-else-if="onglet === 'extraction' && lignesTexte.length" class="texte-pdf">
        <li v-for="(ligne, i) in lignesTexte" :key="i"
          :class="{ 'en-erreur': ligne.erreur, trouvee: ligne.trouvee, 'dans-zone': ligne.dansZone }"
          :title="ligne.erreur ?? undefined"><span v-if="ligne.erreur" class="croix">✖</span><code><template
          v-for="(seg, j) in ligne.segments" :key="j"><mark v-if="seg.champ" :class="seg.champ">{{ seg.texte }}</mark><template
            v-else>{{ seg.texte }}</template></template></code></li>
      </ol>
      <p v-else class="discret texte-pdf vide">
        Choisir le PDF de travail (« Changer… » en haut) pour voir son texte, ligne par ligne, tel que le code le reçoit.
      </p>
    </div>
  </section>

  <div class="actions">
    <span v-if="onglet === 'extraction' && extraction" class="resume">
      <span :class="reconnu ? 'ok' : 'ko'">{{ reconnu ? 'reconnu' : 'non reconnu' }}</span>
      <span v-for="c in (['numero', 'date', 'total'] as const)" :key="c" :class="extraction[c].erreur ? 'ko' : 'ok'">
        {{ c }} : {{ extraction[c].erreur ? '✖' : (extraction[c].valeur ?? 'à saisir') }}
      </span>
      <span :class="extraction.lignes.erreur || totalOk === false ? 'ko' : 'ok'">
        {{ extraction.lignes.valeur
          ? `${extraction.lignes.valeur.length} lignes` + (totalOk === null ? '' : totalOk ? ' = total' : ' ≠ total')
            + (extraction.lignesEnErreur.length ? `, ${extraction.lignesEnErreur.length} en erreur` : '')
          : 'lignes ✖' }}
      </span>
    </span>
    <span v-else-if="onglet === 'masquage'" class="resume">
      <span>{{ termes.length }} terme(s) masqué(s)</span>
      <span>redactions() : {{ aRedactions ? `${regles.length - zonesFixes} texte(s) ou motif(s), ${zonesFixes} zone(s) fixe(s)` : 'absente' }}</span>
    </span>
    <button type="button" :disabled="!exemple || !!erreurCode" @click="ouvrirVerification">
      {{ onglet === 'extraction' ? 'Vérifier l\'extraction…' : 'Vérifier le masquage…' }}
    </button>
    <button type="button" class="principal" :disabled="!enregistrable" @click="enregistrer">
      Enregistrer la version {{ prochaineVersion }}
    </button>
    <span v-if="erreursTs.length" class="ko">Corriger les erreurs du code avant d'enregistrer</span>
  </div>

  <!-- The working PDF and how its pieces of text are grouped into lines -->
  <dialog ref="fenetrePdf" class="fenetre large">
    <h2 tabindex="-1" autofocus>PDF de travail et regroupement en lignes</h2>
    <p class="discret">
      Le code s'écrit et se vérifie sur ce PDF. pdf.js donne des morceaux de texte et leur position ; le regroupement les
      range en lignes. Les réglages sont enregistrés avec l'extracteur : les changer change le texte que reçoit le code.
    </p>
    <div class="outils">
      <select v-if="facturesExemple.length" :value="exempleId ?? undefined" @change="choisirExemple">
        <option v-for="f in facturesExemple" :key="f.id" :value="f.id">
          {{ marque(f) }}{{ f.numero }} ({{ dateFr(f.date_facture) }}, {{ f.immeuble }})
        </option>
      </select>
      <label class="bouton">Autre PDF… <input type="file" accept="application/pdf" hidden @change="exempleFichier"></label>
      <a v-if="exemple" :href="exemple.url" target="_blank" class="bouton">Ouvrir le PDF ↗</a>
    </div>
    <div class="champs reglages">
      <label>Même ligne si les hauteurs diffèrent d'au plus
        <span><input v-model.number="form.reglages.toleranceHauteur" type="number" step="0.1" min="0" class="nombre"> pt</span>
      </label>
      <label>Morceaux collés si l'écart est sous
        <span><input v-model.number="form.reglages.collage" type="number" step="0.1" min="0" class="nombre"> pt</span>
      </label>
      <label>Changement de colonne (3 espaces) au-delà de
        <span><input v-model.number="form.reglages.colonne" type="number" step="1" min="0" class="nombre"> pt</span>
      </label>
    </div>
    <div class="actions">
      <button type="button" class="principal" @click="fenetrePdf?.close()">Fermer</button>
    </div>
  </dialog>

  <!-- Checking the work of the tab: what is read, on this PDF and on every invoice; the copy of this PDF -->
  <dialog ref="fenetreVerification" class="fenetre verification">
    <template v-if="onglet === 'extraction'">
      <h2 tabindex="-1" autofocus>Extraction</h2>
      <h3>Sur les {{ facturesExemple.length }} factures de ce fournisseur, comparées à ce qui est enregistré</h3>
      <p v-if="!facturesExemple.length" class="discret">Aucune facture de ce fournisseur avec son PDF.</p>
      <template v-else>
        <p>
          <span v-if="occupe" class="discret">Lecture des factures…</span>
          <span v-if="comparaisons" :class="enEchec.length ? 'ko' : 'ok'">
            {{ enEchec.length ? '✗' : '✓' }} {{ reussies }}/{{ facturesExemple.length }} identiques
          </span>
          <button v-if="!occupe && comparaisonsPerimees" type="button" @click="tester">Relancer (le code a changé)</button>
        </p>
        <ul v-if="comparaisons" class="verifiees">
          <li v-for="f in facturesExemple" :key="f.id" :class="resultatDe(f)">
            <span>{{ resultatDe(f) === 'ko' ? '✗' : resultatDe(f) === 'ok' ? '✓' : '…' }}</span>
            <a href="#" @click.prevent="travaillerSur(f)">{{ f.numero }}</a>
            <span class="discret">{{ dateFr(f.date_facture) }}, {{ f.immeuble }}{{ f.statut === 'validee' ? '' : ', brouillon' }}</span>
            <span v-if="comparaisons.get(f.id)?.differences.length">{{ comparaisons.get(f.id)!.differences.join(' ; ') }}</span>
            <span v-else-if="comparaisons.get(f.id)?.remarques.length" class="discret">{{ comparaisons.get(f.id)!.remarques.join(' ; ') }}</span>
          </li>
        </ul>
        <p class="discret">Cliquer un numéro pour travailler sur cette facture.</p>
      </template>

      <h3>Sur {{ exemple?.nom }}</h3>
      <p v-if="!extraction" class="discret">Le code ne se charge pas.</p>
      <template v-else>
        <p :class="reconnu ? 'ok' : 'ko'">reconnait : {{ reconnu ? 'oui' : 'non' }}</p>
        <ul class="champs-lus">
          <li v-for="c in (['numero', 'date', 'total'] as const)" :key="c" :class="extraction[c].erreur ? 'ko' : 'ok'">
            {{ c }} : {{ extraction[c].erreur ?? (extraction[c].valeur ?? 'absent (à saisir)') }}
          </li>
        </ul>
        <p v-if="extraction.lignes.erreur" class="ko">lignes : {{ extraction.lignes.erreur }}</p>
        <ul v-if="extraction.lignesEnErreur.length" class="erreurs-code">
          <li v-for="l in extraction.lignesEnErreur" :key="l.position">
            ligne {{ l.position + 1 }} « {{ l.texte.slice(0, 60) }} » : {{ l.erreur }}
          </li>
        </ul>
        <table v-if="extraction.lignes.valeur" class="liste">
          <thead>
            <tr><th>Catégorie</th><th>Libellé</th><th>Début</th><th>Fin</th><th class="nombre">Montant</th><th>Affectation</th><th>Note</th></tr>
          </thead>
          <tbody>
            <tr v-for="(l, i) in extraction.lignes.valeur" :key="i" class="sans-clic">
              <td>{{ l.categorie }}</td><td>{{ l.libelle }}</td><td>{{ dateFr(l.debut) }}</td><td>{{ dateFr(l.fin) }}</td>
              <td class="nombre">{{ euros(l.montant_ttc) }}</td><td>{{ AFFECTATIONS[l.affectation] }}</td><td class="discret">{{ l.note }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td colspan="4">Somme des lignes</td>
              <td class="nombre">{{ euros(sommeLignes.toString()) }}</td>
              <td colspan="2" :class="totalOk ? 'ok' : 'ko'">
                {{ totalOk === null ? 'total à saisir' : totalOk ? '= total' : `≠ total (${euros(extraction.total.valeur)})` }}
              </td>
            </tr>
          </tfoot>
        </table>
      </template>
    </template>

    <template v-else>
      <h2 tabindex="-1" autofocus>Masquage : copie jointe aux justificatifs de {{ exemple?.nom }}</h2>
      <p class="discret">
        Chaque page en image noir et blanc, où sont peints en noir les termes masqués (toutes les factures, tous
        fournisseurs) et ce que rend <code>redactions()</code> (ce fournisseur : un texte qui change à chaque facture, une
        zone fixe d'un scan). C'est ce que reçoit le locataire.
      </p>
      <div class="termes">
        <strong>Termes masqués :</strong>
        <span v-for="t in termes" :key="t" class="terme">{{ t }}
          <button type="button" class="lien" :title="`Ne plus masquer « ${t} »`" @click="retirerTerme(t)">×</button></span>
        <span v-if="!termes.length" class="discret">aucun</span>
      </div>
      <p>
        <span v-if="occupe" class="discret">Copie en cours…</span>
        <template v-if="copie">{{ copie.zones }} zone(s) masquée(s) · <a :href="copie.url" target="_blank">ouvrir dans un onglet ↗</a></template>
      </p>
      <iframe v-if="copie" :key="copie.url" class="apercu-copie" :src="copie.url" title="Copie jointe aux justificatifs" />
    </template>
    <div class="actions">
      <button type="button" class="principal" @click="fenetreVerification?.close()">Fermer</button>
    </div>
  </dialog>
</template>

<style scoped>
.echecs.remarques {
  color: var(--discret);
}

.echecs {
  margin: 0.3rem 0 0.6rem;
  padding-left: 1.2rem;
  max-height: 8rem;
  overflow: auto;
  font-size: 0.85rem;
  color: var(--ko);
}

.phase {
  margin: 1.2rem 0;
}

.phase h2 {
  margin: 0 0 0.3rem;
  font-size: 1.1rem;
}

.phase > p.discret {
  margin: 0 0 0.5rem;
}

.reglages label span {
  white-space: nowrap;
}

.reglages input {
  width: 4rem;
}

.cote-a-cote {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 0.8rem;
}

.editeur,
.texte-pdf {
  height: calc(100vh - 9rem);
  min-height: 420px;
}

.editeur {
  border: 1px solid var(--bord);
}

.texte-pdf.vide {
  padding: 1rem;
}

.texte-pdf {
  overflow: auto;
  margin: 0;
  padding: 0.3rem 0 0.3rem 3rem;
  border: 1px solid var(--bord);
  background: var(--surface);
  font-size: 12px;
}

.texte-pdf code {
  white-space: pre;
}

.titre-phase {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.8rem;
  margin-bottom: 0.3rem;
}

.titre-phase h2 {
  margin: 0;
}

.resume {
  display: flex;
  gap: 1rem;
  font-size: 0.85rem;
}

.plein-ecran {
  position: fixed;
  inset: 0;
  z-index: 100;
  margin: 0;
  padding: 0.6rem 0.8rem;
  background: var(--fond);
  display: flex;
  flex-direction: column;
}

.plein-ecran .cote-a-cote {
  flex: 1;
  min-height: 0;
  grid-template-rows: minmax(0, 1fr);
}

.plein-ecran .cote-a-cote > div {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.plein-ecran .editeur,
.plein-ecran .texte-pdf {
  height: auto;
  min-height: 0;
  flex: 1;
}

.plein-ecran .erreurs-code {
  max-height: 6rem;
  overflow: auto;
}

.phase > p mark {
  padding: 0 0.3rem;
  margin-left: 0.3rem;
}

mark {
  border-radius: 2px;
  color: inherit;
}

mark.numero {
  background: #cfe3ff;
}

mark.date {
  background: #e8d7ff;
}

mark.total {
  background: #c8f0d2;
}

/* A line found by findLine, on its whole width; the legend uses the same colour */
.trouvee {
  background: #fff1a8;
}

mark.lecture {
  background: #ffc98f;
}

/* Tab « Masquage »: what the copy hides, still readable */
mark.masque-termes {
  background: #555;
  color: #fff;
}

mark.masque-extracteur {
  background: #000;
  color: #fff;
}

.onglets {
  display: flex;
  gap: 0.4rem;
  align-items: center;
  margin: 0.8rem 0 0.4rem;
  border-bottom: 1px solid var(--bord, #d0d7de);
}

.onglets button {
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
  margin-bottom: -1px;
}

.onglets button.actif {
  font-weight: bold;
  border-bottom-color: var(--fond, #fff);
}

/* The working PDF, at the right of the tabs */
.pdf-travail {
  margin-left: auto;
  display: flex;
  gap: 0.5rem;
  align-items: center;
  padding-bottom: 0.3rem;
}

.titre-phase .legende-couleurs {
  flex: 1;
  margin: 0;
}

/* Under the code: a summary of the work of the tab, the check, the save */
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.8rem;
  align-items: center;
  margin-top: 0.6rem;
}

.actions .resume {
  margin-right: auto;
}

dialog.fenetre.verification {
  width: min(72rem, 96vw);
}

.verifiees {
  list-style: none;
  padding: 0;
  margin: 0.4rem 0;
}

.verifiees li {
  display: flex;
  gap: 0.6rem;
  align-items: baseline;
  padding: 0.15rem 0;
}

.verifiees li.ok > span:first-child {
  color: var(--ok);
}

.verifiees li.ko > span:first-child,
.verifiees li.ko > span:last-child {
  color: var(--ko);
}

dialog.fenetre .actions {
  justify-content: flex-end;
}

/* The title takes the focus when a window opens (not the last button, which would scroll it down) */
dialog.fenetre h2:focus {
  outline: none;
}

.termes {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: center;
  margin: 0.4rem 0;
}

.terme {
  font-family: monospace;
  background: #555;
  color: #fff;
  border-radius: 3px;
  padding: 0 0 0 0.4rem;
}

.terme .lien {
  color: #fff;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0 0.4rem;
}

.apercu-copie {
  width: 100%;
  height: 65vh;
  border: 1px solid var(--bord, #d0d7de);
  margin-top: 0.5rem;
}

.texte-pdf li::marker {
  color: var(--discret);
}

/* The lines of linesZone: their number, in the colour of linesZone in the editor */
.texte-pdf li.dans-zone::marker {
  color: #0a7e8c;
  font-weight: bold;
}

/* Legend: the colours used in the text and in the margin of the editor */
.legende-couleurs > * {
  padding: 0 0.3rem;
  margin-right: 0.3rem;
  border-radius: 2px;
}

.zone {
  color: #0a7e8c;
  font-weight: bold;
}

.texte-pdf li {
  position: relative;
}

.texte-pdf li.en-erreur {
  background: var(--fond-erreur);
}

/* In the margin, before the line number, as the error marks of VS Code */
.croix {
  position: absolute;
  left: -2.9rem;
  color: var(--ko);
  font-weight: bold;
  cursor: help;
}

.erreurs-code {
  color: var(--ko);
  margin: 0.4rem 0;
  padding-left: 1.2rem;
}

.champs-lus {
  list-style: none;
  padding: 0;
  display: flex;
  gap: 1.5rem;
}
</style>

<style>
/* Gutter of the code editor (Monaco decorations are outside the component): colour of each method, the same as what
   it highlights in the text of the PDF */
.methode-numero,
.methode-date,
.methode-total,
.methode-zone,
.methode-lignes,
.methode-lecture {
  margin-left: 3px;
  width: 4px !important;
}

.methode-numero {
  background: #8ab8ff;
}

.methode-date {
  background: #c4a3ff;
}

.methode-total {
  background: #7ad69a;
}

.methode-zone {
  background: #0a7e8c;
}

.methode-lignes {
  background: #f2cc3d;
}

.methode-lecture {
  background: #ff9f45;
}

.methode-masquage {
  margin-left: 3px;
  width: 4px !important;
  background: #000;
}
</style>

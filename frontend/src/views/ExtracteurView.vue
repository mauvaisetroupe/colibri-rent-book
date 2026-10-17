<script setup lang="ts">
import Big from 'big.js'
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'

import { AFFECTATIONS, api, ENERGIES, type Energie, type ExtracteurEnregistre, type FactureAvecPdf } from '../api'
import { MOTEUR, REGLAGES_PAR_DEFAUT, type Morceau } from '../extraction/contrat'
import { creerEditeur, type Editeur } from '../extraction/editeur'
import modele from '../extraction/modeles/modele.ts?raw'
import { charger, documentDe, energieDe, extraire, reconnait, type Correspondance, type Extraction } from '../extraction/moteur'
import { morceauxDuPdf } from '../extraction/navigateur'
import { comparer, type Comparaison } from '../extraction/nonRegression'
import { surligner, type LigneSurlignee } from '../extraction/surlignage'
import { dateFr, euros } from '../format'

// Editing an invoice extractor (ADR 0013), from a saved version or from the template of a new supplier: saving
// creates the next version, the one edited is never changed. The code runs here, in the browser, on a sample PDF
// while it is typed.

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
  const premiere = facturesExemple.value[0]
  if (premiere && !exemple.value?.nom.startsWith(`${form.fournisseur} `)) {
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
// Identical, but completed by hand (total typed, line added): shown, not failed
const avecRemarques = computed(() =>
  [...(comparaisons.value?.values() ?? [])].filter((c) => c.differences.length === 0 && c.remarques.length > 0))

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

  <section class="phase">
    <h2>1. PDF d'exemple et regroupement en lignes</h2>
    <p class="discret">
      pdf.js donne des morceaux de texte et leur position ; le regroupement les range en lignes. Les réglages sont
      enregistrés avec l'extracteur : les changer change le texte que reçoit le code.
    </p>
    <div class="outils">
      <strong>PDF d'exemple :</strong>
      <select v-if="facturesExemple.length" :value="exempleId ?? undefined" @change="choisirExemple">
        <option v-for="f in facturesExemple" :key="f.id" :value="f.id">
          {{ marque(f) }}{{ f.numero }} ({{ dateFr(f.date_facture) }}, {{ f.immeuble }})
        </option>
      </select>
      <label class="bouton">Autre PDF… <input type="file" accept="application/pdf" hidden @change="exempleFichier"></label>
      <a v-if="exemple" :href="exemple.url" target="_blank" class="bouton">Ouvrir le PDF ↗</a>
      <button v-if="facturesExemple.length" type="button" :disabled="!code || !!erreurCode || occupe" @click="tester">
        Tester sur les {{ facturesExemple.length }} factures
      </button>
      <span v-if="comparaisons" :class="enEchec.length ? 'ko' : 'ok'">
        {{ enEchec.length ? '✗' : '✓' }} {{ reussies }}/{{ facturesExemple.length }} identiques
        <span v-if="comparaisonsPerimees" class="discret">(avant la dernière modification : relancer)</span>
      </span>
    </div>
    <ul v-if="enEchec.length" class="echecs">
      <li v-for="c in enEchec" :key="c.facture.id">
        <a href="#" @click.prevent="exempleFacture(c.facture)">✗ {{ c.facture.numero }}</a>
        ({{ c.facture.statut === 'validee' ? 'validée' : 'brouillon' }}) : {{ c.differences.join(' ; ') }}
      </li>
    </ul>
    <ul v-if="avecRemarques.length" class="echecs remarques">
      <li v-for="c in avecRemarques" :key="c.facture.id">
        <a href="#" @click.prevent="exempleFacture(c.facture)">✓ {{ c.facture.numero }}</a> : {{ c.remarques.join(' ; ') }}
      </li>
    </ul>
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
  </section>

  <section class="phase" :class="{ 'plein-ecran': pleinEcran }">
    <div class="titre-phase">
      <h2>2. Code de l'extracteur, d'après le texte du PDF</h2>
      <button type="button" @click="basculerPleinEcran">{{ pleinEcran ? 'Réduire (Échap)' : 'Agrandir ⤢' }}</button>
      <span v-if="pleinEcran && extraction" class="resume">
        <span v-for="c in (['numero', 'date', 'total'] as const)" :key="c" :class="extraction[c].erreur ? 'ko' : 'ok'">
          {{ c }} : {{ extraction[c].erreur ? '✖' : (extraction[c].valeur ?? 'à saisir') }}
        </span>
        <span :class="extraction.lignes.erreur || totalOk === false ? 'ko' : 'ok'">
          {{ extraction.lignes.valeur
            ? `${extraction.lignes.valeur.length} lignes, somme ${euros(sommeLignes.toString())}`
              + (totalOk === null ? '' : totalOk ? ' = total' : ' ≠ total')
              + (extraction.lignesEnErreur.length ? `, ${extraction.lignesEnErreur.length} en erreur` : '')
            : `lignes : ${extraction.lignes.erreur}` }}
        </span>
      </span>
    </div>
    <p class="legende-couleurs">
      <mark class="numero">invoiceNumber</mark><mark class="date">invoiceDate</mark><mark class="total">total</mark><span
        class="zone">linesZone</span><span class="trouvee">findLine</span><mark class="lecture">readLine</mark>
    </p>
    <div class="cote-a-cote">
      <div>
        <div ref="zoneEditeur" class="editeur" />
        <ul v-if="erreursTs.length || erreurCode" class="erreurs-code">
          <li v-for="(e, i) in erreursTs" :key="i">{{ e }}</li>
          <li v-if="erreurCode">{{ erreurCode }}</li>
        </ul>
      </div>
      <ol v-if="lignesTexte.length" class="texte-pdf">
        <li v-for="(ligne, i) in lignesTexte" :key="i"
          :class="{ 'en-erreur': ligne.erreur, trouvee: ligne.trouvee, 'dans-zone': ligne.dansZone }"
          :title="ligne.erreur ?? undefined"><span v-if="ligne.erreur" class="croix">✖</span><code><template
          v-for="(seg, j) in ligne.segments" :key="j"><mark v-if="seg.champ" :class="seg.champ">{{ seg.texte }}</mark><template
            v-else>{{ seg.texte }}</template></template></code></li>
      </ol>
      <p v-else class="discret texte-pdf vide">Choisir un PDF d'exemple pour voir son texte, ligne par ligne, tel que le code le reçoit.</p>
    </div>
  </section>

  <section class="phase">
    <h2>3. Résultat{{ exemple ? ` sur ${exemple.nom}` : '' }}</h2>
    <p v-if="!extraction" class="discret">Le résultat s'affiche ici dès qu'un PDF d'exemple est choisi et que le code se charge.</p>
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
  </section>

  <div class="actions">
    <button type="button" class="principal" :disabled="!enregistrable" @click="enregistrer">
      Enregistrer la version {{ prochaineVersion }}
    </button>
    <span v-if="erreursTs.length" class="ko">Corriger les erreurs du code avant d'enregistrer</span>
  </div>

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
</style>

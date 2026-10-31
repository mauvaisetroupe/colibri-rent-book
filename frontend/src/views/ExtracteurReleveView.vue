<script setup lang="ts">
import Big from 'big.js'
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'

import { api, type ExtracteurEnregistre, type ReleveAvecPdf } from '../api'
import { MOTEUR, REGLAGES_RELEVE_PAR_DEFAUT, type Morceau } from '../extraction/contrat'
import { creerEditeur, type Editeur } from '../extraction/editeur'
import modele from '../extraction/modeles/modele-releve.ts?raw'
import {
  chargerReleve, documentReleve, extraireReleve, reconnaitReleve, type ClasseExtracteurReleve, type ExtractionReleve,
} from '../extraction/moteurReleve'
import { morceauxDuPdf } from '../extraction/navigateur'
import { dateFr, euros } from '../format'

// Editing a bank statement extractor (ADR 0018), from a saved version or from the template of a new bank: saving
// creates the next version, the one edited is never changed. As for invoices (ExtracteurView), the code runs here on a
// sample PDF while it is typed; « Tester » reads again every statement of the bank already imported.

const props = defineProps<{ id: number | null }>()
const router = useRouter()
const route = useRoute()
const fournisseurId = ref<number | null>(null)

const enregistres = ref<ExtracteurEnregistre[]>([])
const base = ref<ExtracteurEnregistre | null>(null)
const form = reactive({ supplier: '', note: '', settings: { ...REGLAGES_RELEVE_PAR_DEFAUT, margin: REGLAGES_RELEVE_PAR_DEFAUT.margin ?? 0 } })
const message = ref<{ text: string, type: 'info' | 'erreur' } | null>(null)
let annonce: { text: string, type: 'info' } | null = null

const zoneEditeur = ref<HTMLElement | null>(null)
let editeur: Editeur | null = null

const relevesExemple = ref<ReleveAvecPdf[]>([])
const exemple = shallowRef<{ name: string, pages: Morceau[][], url: string } | null>(null)
const exempleId = ref<number | null>(null)
const erreursTs = ref<string[]>([])
const erreurCode = ref<string | null>(null)
const reconnu = ref<boolean | null>(null)
const extraction = shallowRef<ExtractionReleve | null>(null)
const code = ref('')
const occupe = ref(false)
// Test on every statement of the bank: an error list per statement id (empty: identical)
const comparaisons = ref<Map<number, string[]> | null>(null)

const prochaineVersion = computed(() =>
  1 + Math.max(0, ...enregistres.value.filter((e) => e.supplier === form.supplier.trim()).map((e) => e.version)))
const enregistrable = computed(() =>
  !!form.supplier.trim() && !!code.value && erreursTs.value.length === 0 && !erreurCode.value && !occupe.value)

onMounted(async () => {
  editeur = creerEditeur(zoneEditeur.value!, modele)
  editeur.surChangement(programmer)
  await ouvrir()
})
watch(() => props.id, ouvrir)
onBeforeUnmount(() => editeur?.detruire())

async function ouvrir() {
  try {
    enregistres.value = await api.extractors()
    const version = props.id === null ? null : enregistres.value.find((e) => e.id === props.id)
    if (version) {
      base.value = version
      Object.assign(form, { supplier: version.supplier, note: '', settings: { margin: 0, ...version.settings } })
      editeur?.remplacer(version.source)
    } else {
      base.value = null
      const supplier = typeof route.query.supplier === 'string' ? route.query.supplier : ''
      Object.assign(form, { supplier, note: '', settings: { ...REGLAGES_RELEVE_PAR_DEFAUT, margin: REGLAGES_RELEVE_PAR_DEFAUT.margin ?? 0 } })
      editeur?.remplacer(modele)
      if (props.id !== null) {
        message.value = { text: 'Extracteur introuvable', type: 'erreur' }
      }
    }
    comparaisons.value = null
    await chargerExemples()
    fournisseurId.value = (await api.suppliers()).find((f) => f.name === form.supplier)?.id ?? null
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
  }
  if (annonce) {
    message.value = annonce
    annonce = null
  }
}

async function chargerExemples() {
  relevesExemple.value = form.supplier ? await api.relevesDeLaBanque(form.supplier) : []
  const premier = relevesExemple.value[0]
  if (premier && !exemple.value) {
    await exempleReleve(premier)
  } else {
    programmer()
  }
}

async function exempleReleve(r: ReleveAvecPdf) {
  exempleId.value = r.id
  try {
    const pdf = await (await fetch(api.relevePdfUrl(r.id))).blob()
    remplacerExemple({ name: `relevé du ${dateFr(r.statement_date)}`, pages: await morceauxDuPdf(pdf), url: api.relevePdfUrl(r.id) })
  } catch (e) {
    message.value = { text: `PDF du relevé illisible : ${(e as Error).message}`, type: 'erreur' }
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
      remplacerExemple({ name: fichier.name, pages: await morceauxDuPdf(fichier), url: URL.createObjectURL(fichier) })
    } catch {
      message.value = { text: `${fichier.name} : PDF illisible`, type: 'erreur' }
    }
    programmer()
  }
  input.value = ''
}

function choisirExemple(event: Event) {
  const r = relevesExemple.value.find((x) => x.id === Number((event.target as HTMLSelectElement).value))
  if (r) {
    exempleReleve(r)
  }
}

// ---------------------------------------------------------------- live run

let minuterie: ReturnType<typeof setTimeout> | undefined
let sequence = 0

function programmer() {
  clearTimeout(minuterie)
  minuterie = setTimeout(analyser, 300)
}
watch(() => ({ ...form.settings }), programmer)

const lines = computed(() => {
  const x = extraction.value
  const document = x?.document ?? (exemple.value ? documentReleve(exemple.value.pages, form.settings) : null)
  if (!document) {
    return []
  }
  const erreurs = new Map((x?.mouvementsEnErreur ?? []).map((e) => [e.position, e.erreur]))
  const zone = new Set(x?.zone)
  const trouvees = new Set(x?.trouvees)
  const details = new Set(x?.details)
  return document.rows.map((r) => ({
    text: r.text, erreur: erreurs.get(r.index) ?? null, dansZone: zone.has(r.index), trouvee: trouvees.has(r.index),
    detail: details.has(r.index),
  }))
})

async function analyser() {
  if (!editeur) {
    return
  }
  const number = ++sequence
  const { code: js, erreurs } = await editeur.compiler()
  if (number !== sequence) {
    return
  }
  code.value = js
  erreursTs.value = erreurs
  erreurCode.value = null
  reconnu.value = null
  extraction.value = null
  let classe: ClasseExtracteurReleve
  try {
    classe = chargerReleve(js)
  } catch (e) {
    erreurCode.value = (e as Error).message
    return
  }
  if (exemple.value) {
    const document = documentReleve(exemple.value.pages, form.settings)
    reconnu.value = reconnaitReleve(classe, document)
    extraction.value = extraireReleve(classe, document)
  }
}

// ---------------------------------------------------------------- non-regression, then save

async function tester() {
  occupe.value = true
  try {
    const classe = chargerReleve(code.value)
    const resultats = new Map<number, string[]>()
    for (const r of relevesExemple.value) {
      resultats.set(r.id, await comparer(classe, r))
      comparaisons.value = new Map(resultats)
    }
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
  } finally {
    occupe.value = false
  }
}

/** What the version being edited reads differently from the stored statement. */
async function comparer(classe: ClasseExtracteurReleve, r: ReleveAvecPdf): Promise<string[]> {
  try {
    const pdf = await (await fetch(api.relevePdfUrl(r.id))).blob()
    const document = documentReleve(await morceauxDuPdf(pdf), form.settings)
    if (!reconnaitReleve(classe, document)) {
      return ['PDF non reconnu par cette version']
    }
    const lu = extraireReleve(classe, document)
    const stocke = await api.releve(r.id)
    const ecarts: string[] = []
    const egal = (a: string | null, b: string) => a !== null && new Big(a).eq(b)
    if (lu.account.valeur !== stocke.account) ecarts.push(`compte ${lu.account.valeur ?? lu.account.erreur}`)
    if (lu.date.valeur !== stocke.statement_date) ecarts.push(`date ${lu.date.valeur ?? lu.date.erreur}`)
    if (!egal(lu.soldePrecedent.valeur, stocke.previous_balance)) ecarts.push(`solde précédent ${lu.soldePrecedent.valeur ?? lu.soldePrecedent.erreur}`)
    if (!egal(lu.nouveauSolde.valeur, stocke.new_balance)) ecarts.push(`nouveau solde ${lu.nouveauSolde.valeur ?? lu.nouveauSolde.erreur}`)
    const transactions = lu.transactions.valeur ?? []
    if (lu.transactions.erreur) {
      ecarts.push(`mouvements : ${lu.transactions.erreur}`)
    } else if (transactions.length !== stocke.transactions.length) {
      ecarts.push(`${transactions.length} mouvements lus, ${stocke.transactions.length} enregistrés`)
    } else {
      transactions.forEach((m, i) => {
        const s = stocke.transactions[i]!
        if (m.transaction_date !== s.transaction_date || !new Big(m.amount).eq(s.amount) || m.label !== s.label) {
          ecarts.push(`mouvement ${i + 1} : ${m.label} ${m.amount} (enregistré : ${s.label} ${s.amount})`)
        } else if ((m.detail ?? '') !== (s.detail ?? '')) {
          ecarts.push(`mouvement ${i + 1} : détail différent`)
        }
      })
    }
    return ecarts
  } catch (e) {
    return [`lecture impossible : ${(e as Error).message}`]
  }
}

const reussis = computed(() => [...(comparaisons.value?.values() ?? [])].filter((c) => !c.length).length)
const enEchec = computed(() => [...(comparaisons.value?.entries() ?? [])].filter(([, c]) => c.length))
const releveDe = (id: number) => relevesExemple.value.find((r) => r.id === id)

async function enregistrer() {
  if (!editeur || !enregistrable.value) {
    return
  }
  occupe.value = true
  try {
    const created = await api.nouvelleVersion({
      supplier: form.supplier.trim(), type: 'bank_statement', energy: null, settings: { ...form.settings },
      source: editeur.source(), code: code.value, engine: MOTEUR, note: form.note.trim() || null,
    })
    annonce = { text: `${created.supplier} : version ${created.version} enregistrée`, type: 'info' }
    await router.push({ name: 'extracteur-releve', params: { id: created.id } })
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
  } finally {
    occupe.value = false
  }
}
</script>

<template>
  <RouterLink v-if="fournisseurId" :to="{ name: 'supplier', params: { id: fournisseurId } }">← {{ form.supplier }}</RouterLink>
  <RouterLink v-else :to="{ name: 'suppliers' }">← Fournisseurs</RouterLink>
  <section class="entete-page">
    <h1>{{ base ? `${base.supplier} (relevés), à partir de la version ${base.version}` : 'Nouvelle banque' }}</h1>
    <p v-if="base" class="discret">
      Version {{ base.version }} du {{ dateFr(base.created_at.slice(0, 10)) }}{{ base.note ? ` : ${base.note}` : '' }}
      · {{ base.statement_count }} relevé(s) lu(s). Elle ne change pas : enregistrer crée la version {{ prochaineVersion }}.
    </p>
  </section>

  <p v-if="message" class="message" :class="message.type">{{ message.text }}</p>

  <div class="champs">
    <label>Banque <input v-model="form.supplier" :readonly="!!base" size="16"></label>
    <label class="note">Note de version <input v-model="form.note" size="40" placeholder="ce qui change"></label>
  </div>

  <section class="phase">
    <h2>1. Relevé d'exemple et regroupement en lignes</h2>
    <div class="outils">
      <strong>PDF d'exemple :</strong>
      <select v-if="relevesExemple.length" :value="exempleId ?? undefined" @change="choisirExemple">
        <option v-for="r in relevesExemple" :key="r.id" :value="r.id">
          {{ comparaisons?.get(r.id) ? (comparaisons.get(r.id)!.length ? '✗ ' : '✓ ') : '' }}{{ dateFr(r.statement_date) }} ({{ r.account }})
        </option>
      </select>
      <label class="bouton">Autre PDF… <input type="file" accept="application/pdf" hidden @change="exempleFichier"></label>
      <a v-if="exemple" :href="exemple.url" target="_blank" class="bouton">Ouvrir le PDF ↗</a>
      <button v-if="relevesExemple.length" type="button" :disabled="!code || !!erreurCode || occupe" @click="tester">
        Tester sur les {{ relevesExemple.length }} relevés
      </button>
      <span v-if="comparaisons" :class="enEchec.length ? 'ko' : 'ok'">
        {{ enEchec.length ? '✗' : '✓' }} {{ reussis }}/{{ relevesExemple.length }} identiques
      </span>
    </div>
    <ul v-if="enEchec.length" class="echecs">
      <li v-for="[id, ecarts] in enEchec" :key="id">
        <a href="#" @click.prevent="exempleReleve(releveDe(id)!)">✗ {{ dateFr(releveDe(id)?.statement_date ?? null) }}</a> : {{ ecarts.join(' ; ') }}
      </li>
    </ul>
    <div class="champs reglages">
      <label>Même ligne si les hauteurs diffèrent d'au plus
        <span><input v-model.number="form.settings.lineTolerance" type="number" step="0.1" min="0" class="nombre"> pt</span>
      </label>
      <label>Morceaux collés si l'écart est sous
        <span><input v-model.number="form.settings.joinGap" type="number" step="0.1" min="0" class="nombre"> pt</span>
      </label>
      <label>Changement de colonne (3 espaces) au-delà de
        <span><input v-model.number="form.settings.columnGap" type="number" step="1" min="0" class="nombre"> pt</span>
      </label>
      <label>Marge ignorée à gauche de
        <span><input v-model.number="form.settings.margin" type="number" step="1" min="0" class="nombre"> pt</span>
      </label>
    </div>
  </section>

  <section class="phase">
    <h2>2. Code de l'extracteur, d'après le texte du PDF</h2>
    <p class="legende-couleurs">
      <span class="zone">movementsZone</span><span class="trouvee">findMovement</span><span class="ligne-detail">détail d'un mouvement</span>
    </p>
    <div class="cote-a-cote">
      <div>
        <div ref="zoneEditeur" class="editeur" />
        <ul v-if="erreursTs.length || erreurCode" class="erreurs-code">
          <li v-for="(e, i) in erreursTs" :key="i">{{ e }}</li>
          <li v-if="erreurCode">{{ erreurCode }}</li>
        </ul>
      </div>
      <ol v-if="lines.length" class="texte-pdf">
        <li v-for="(l, i) in lines" :key="i"
          :class="{ 'en-erreur': l.erreur, trouvee: l.trouvee, 'ligne-detail': l.detail, 'dans-zone': l.dansZone }"
          :title="l.erreur ?? undefined"><span v-if="l.erreur" class="croix">✖</span><code>{{ l.text }}</code></li>
      </ol>
      <p v-else class="discret texte-pdf vide">Choisir un relevé d'exemple pour voir son texte, ligne par ligne.</p>
    </div>
  </section>

  <section class="phase">
    <h2>3. Résultat{{ exemple ? ` sur ${exemple.name}` : '' }}</h2>
    <p v-if="!extraction" class="discret">Le résultat s'affiche ici dès qu'un PDF d'exemple est choisi et que le code se charge.</p>
    <template v-else>
      <p :class="reconnu ? 'ok' : 'ko'">reconnait : {{ reconnu ? 'oui' : 'non' }}</p>
      <ul class="champs-lus">
        <li :class="extraction.account.erreur ? 'ko' : 'ok'">compte : {{ extraction.account.erreur ?? extraction.account.valeur }}</li>
        <li :class="extraction.date.erreur ? 'ko' : 'ok'">date : {{ extraction.date.erreur ?? dateFr(extraction.date.valeur) }}</li>
        <li :class="extraction.soldePrecedent.erreur ? 'ko' : 'ok'">solde précédent : {{ extraction.soldePrecedent.erreur ?? euros(extraction.soldePrecedent.valeur) }}</li>
        <li :class="extraction.nouveauSolde.erreur ? 'ko' : 'ok'">nouveau solde : {{ extraction.nouveauSolde.erreur ?? euros(extraction.nouveauSolde.valeur) }}</li>
      </ul>
      <p :class="extraction.checks.equilibre === false || extraction.checks.totaux === false ? 'ko' : 'ok'">
        Crédits {{ euros(extraction.checks.credits) }}, débits {{ euros(extraction.checks.debits) }} :
        solde calculé {{ euros(extraction.checks.calcule) }}
        {{ extraction.checks.equilibre === null ? '' : extraction.checks.equilibre ? '= nouveau solde ✓' : '≠ nouveau solde ✗' }}
        <template v-if="extraction.checks.totaux !== null">
          · totaux imprimés {{ extraction.checks.totaux ? '✓' : '✗' }}
        </template>
      </p>
      <p v-if="extraction.transactions.erreur" class="ko">mouvements : {{ extraction.transactions.erreur }}</p>
      <ul v-if="extraction.mouvementsEnErreur.length" class="erreurs-code">
        <li v-for="l in extraction.mouvementsEnErreur" :key="l.position">ligne {{ l.position + 1 }} « {{ l.text.slice(0, 60) }} » : {{ l.erreur }}</li>
      </ul>
      <table v-if="extraction.transactions.valeur" class="liste">
        <thead><tr><th>Date</th><th>Valeur</th><th>Libellé</th><th>Détail</th><th class="nombre">Montant</th></tr></thead>
        <tbody>
          <tr v-for="(m, i) in extraction.transactions.valeur" :key="i" class="sans-clic">
            <td>{{ dateFr(m.transaction_date) }}</td><td>{{ dateFr(m.value_date) }}</td><td>{{ m.label }}</td>
            <td class="discret detail-cell">{{ m.detail }}</td>
            <td class="nombre" :class="Number(m.amount) > 0 ? 'ok' : ''">{{ euros(m.amount) }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </section>

  <div class="actions">
    <button type="button" class="principal" :disabled="!enregistrable" @click="enregistrer">Enregistrer la version {{ prochaineVersion }}</button>
    <span v-if="erreursTs.length" class="ko">Corriger les erreurs du code avant d'enregistrer</span>
  </div>
</template>

<style scoped>
.phase {
  margin: 1.2rem 0;
}

.phase h2 {
  margin: 0 0 0.3rem;
  font-size: 1.1rem;
}

.reglages label span {
  white-space: nowrap;
}

.reglages input {
  width: 4rem;
}

.echecs {
  margin: 0.3rem 0 0.6rem;
  padding-left: 1.2rem;
  max-height: 8rem;
  overflow: auto;
  font-size: 0.85rem;
  color: var(--ko);
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

.texte-pdf {
  overflow: auto;
  margin: 0;
  padding: 0.3rem 0 0.3rem 3rem;
  border: 1px solid var(--bord);
  background: var(--surface);
  font-size: 12px;
}

.texte-pdf.vide {
  padding: 1rem;
}

.texte-pdf code {
  white-space: pre;
}

.texte-pdf li {
  position: relative;
}

.texte-pdf li::marker {
  color: var(--discret);
}

.texte-pdf li.dans-zone::marker,
.zone {
  color: #0a7e8c;
  font-weight: bold;
}

.trouvee {
  background: #fff1a8;
}

.ligne-detail {
  background: #fff9dc;
}

.texte-pdf li.en-erreur {
  background: var(--fond-erreur);
}

.croix {
  position: absolute;
  left: -2.9rem;
  color: var(--ko);
  font-weight: bold;
}

.legende-couleurs > * {
  padding: 0 0.3rem;
  margin-right: 0.3rem;
  border-radius: 2px;
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
  flex-wrap: wrap;
  gap: 1.5rem;
}

.detail-cell {
  white-space: pre-line;
  font-size: 0.8rem;
}
</style>

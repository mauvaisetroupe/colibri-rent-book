<script setup lang="ts">
import { VGrid, type ColumnRegular } from '@revolist/vue3-datagrid'
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { onBeforeRouteLeave, RouterLink, useRouter } from 'vue-router'

import {
  api, ApiError, CATEGORIES, ENERGIES, type Controle, type Facture, type FactureDetail, type FactureSaisie,
} from '../api'
import { depuisGrille, euros, ligneVide, nombreApi, nombreFr, versGrille, type LigneGrille } from '../format'

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

const validee = computed(() => facture.value?.statut === 'validee')

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

async function charger() {
  try {
    appliquer(await api.facture(props.id))
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}

function appliquer(detail: FactureDetail) {
  facture.value = detail.facture
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

async function executer(action: () => Promise<FactureDetail>, succes: string) {
  occupe.value = true
  try {
    appliquer(await action())
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

async function valider() {
  if (modifie.value && !(await enregistrer())) {
    return
  }
  await executer(() => api.valider(props.id), 'Facture validée : elle entre dans les décomptes')
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
  if (!confirm('Supprimer ce brouillon ? Le PDF pourra être importé à nouveau.')) {
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
        <span class="pastille" :class="facture.statut">{{ validee ? 'Validée' : 'Brouillon' }}</span>
      </h1>
      <div class="champs">
        <label>N° <input v-model="entete.numero" :disabled="validee" @input="changer"></label>
        <label>Date <input v-model="entete.date_facture" type="date" :disabled="validee" @input="changer"></label>
        <label>Énergie
          <select v-model="entete.energie" :disabled="validee" @change="changer">
            <option v-for="(nom, code) in ENERGIES" :key="code" :value="code">{{ nom }}</option>
          </select>
        </label>
        <label>Total imprimé TTC
          <input v-model="entete.montant_ttc" class="nombre" :disabled="validee" @input="changer">
        </label>
        <label class="note">Note <input v-model="entete.note" :disabled="validee" @input="changer"></label>
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

    <p v-if="message" class="message" :class="message.type">{{ message.texte }}</p>

    <div class="edition">
      <div class="gauche">
        <div v-if="!validee" class="outils">
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
            :readonly="validee"
            :range="true"
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
          <template v-if="!validee">
            <button type="button" :disabled="occupe || !modifie" @click="enregistrer">Enregistrer le brouillon</button>
            <button type="button" class="principal" :disabled="occupe || !controle?.validable" @click="valider">
              Valider la facture
            </button>
            <button type="button" class="danger" :disabled="occupe" @click="supprimer">Supprimer le brouillon</button>
          </template>
          <p v-else class="discret">
            Facture validée : elle entre dans les décomptes et ne peut plus être modifiée.
          </p>
        </div>
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

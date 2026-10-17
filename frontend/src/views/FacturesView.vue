<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'

import { api, ApiError, ENERGIES, type Energie, type ExtracteurEnregistre, type FactureResumee } from '../api'
import type { Candidat } from '../extraction/navigateur'
import { dateFr, euros, nombreApi } from '../format'
import { useImmeuble } from '../immeuble'

type Resultat = {
  fichier: string
  etat: 'en_cours' | 'importee' | 'doublon' | 'erreur'
  message: string
  id?: number
  // PDF not read automatically: kept to be attached to the invoice typed by hand
  aSaisir?: File
  // Several extractors recognise the PDF: the user chooses (ADR 0013)
  choix?: { fichier: File, candidats: Candidat[] }
}

type Saisie = {
  fournisseur: string, energie: Energie, numero: string, date_facture: string, montant_ttc: string, note: string
  fichier: File | null
}

const router = useRouter()
const { immeubleId: immeuble, pret } = useImmeuble()
const factures = ref<FactureResumee[]>([])
const erreur = ref<string | null>(null)
const energie = ref<Energie | ''>('')
const annee = ref<string>('')
const resultats = ref<Resultat[]>([])
const survol = ref(false)
const saisie = ref<Saisie | null>(null)
const erreurSaisie = ref<string | null>(null)

onMounted(async () => {
  try {
    await pret
    await charger()
  } catch (e) {
    erreur.value = (e as Error).message
  }
})

async function charger() {
  if (immeuble.value === null) {
    return
  }
  try {
    factures.value = await api.factures(immeuble.value)
    erreur.value = null
  } catch (e) {
    erreur.value = (e as Error).message
  }
}

watch(immeuble, charger)

const annees = computed(() =>
  [...new Set(factures.value.map((f) => f.date_facture?.slice(0, 4)).filter(Boolean))].sort().reverse(),
)

const affichees = computed(() =>
  factures.value.filter((f) =>
    (!energie.value || f.energie === energie.value) && (!annee.value || f.date_facture?.startsWith(annee.value))),
)

const brouillons = computed(() => factures.value.filter((f) => f.statut === 'a_verifier').length)

async function importer(files: FileList | File[] | null) {
  if (!files || immeuble.value === null) {
    return
  }
  let extracteurs: ExtracteurEnregistre[]
  try {
    extracteurs = await api.extracteurs()
  } catch (e) {
    erreur.value = (e as Error).message
    return
  }
  // One at a time, in the order given: results appear as they come
  for (const file of Array.from(files)) {
    const resultat: Resultat = { fichier: file.name, etat: 'en_cours', message: 'Lecture…' }
    resultats.value.unshift(resultat)
    await lireEtImporter(resultat, file, extracteurs)
    resultats.value = [...resultats.value]
  }
  await charger()
}

/** The PDF is read in the browser by the last version of each supplier's extractor, then sent with its draft. */
async function lireEtImporter(resultat: Resultat, file: File, extracteurs: ExtracteurEnregistre[], choisi?: Candidat) {
  const echec = (message: string) => Object.assign(resultat, { etat: 'erreur', message, aSaisir: file, choix: undefined })
  // pdf.js is loaded with the first import only
  const { brouillonDe, candidats, lire, morceauxDuPdf } = await import('../extraction/navigateur')
  let pages
  try {
    pages = await morceauxDuPdf(file)
  } catch {
    echec('PDF illisible (scan ou fichier abîmé) : saisir la facture à la main')
    return
  }
  const trouves = choisi ? [choisi] : candidats(pages, extracteurs)
  if (trouves.length === 0) {
    echec('Aucun extracteur ne reconnaît ce PDF : saisir la facture à la main, ou écrire un extracteur')
    return
  }
  if (trouves.length > 1) {
    Object.assign(resultat, {
      etat: 'erreur', message: 'Plusieurs extracteurs reconnaissent ce PDF : choisir', choix: { fichier: file, candidats: trouves },
    })
    return
  }
  const candidat = trouves[0]!
  const { brouillon, probleme } = brouillonDe(lire(pages, candidat), candidat.enregistre.id)
  if (!brouillon) {
    echec(`${candidat.enregistre.fournisseur} v${candidat.enregistre.version} : ${probleme}`)
    return
  }
  try {
    const { facture, controle } = await api.importer(immeuble.value!, file, brouillon)
    Object.assign(resultat, {
      etat: 'importee',
      id: facture.id,
      choix: undefined,
      message: `${facture.fournisseur} n° ${facture.numero} : brouillon créé`
        + (controle.validable ? '' : ' (contrôles en erreur)'),
    })
  } catch (e) {
    const doublon = e instanceof ApiError && e.status === 409
    Object.assign(resultat, {
      etat: doublon ? 'doublon' : 'erreur',
      id: doublon ? Number(e.body.facture_id) : undefined,
      message: (e as Error).message,
      aSaisir: e instanceof ApiError && e.body.code === 'saisie_manuelle' ? file : undefined,
      choix: undefined,
    })
  }
}

async function choisirExtracteur(resultat: Resultat, candidat: Candidat) {
  if (!resultat.choix) {
    return
  }
  Object.assign(resultat, { etat: 'en_cours', message: 'Lecture…' })
  await lireEtImporter(resultat, resultat.choix.fichier, [], candidat)
  resultats.value = [...resultats.value]
  await charger()
}

function deposer(event: DragEvent) {
  survol.value = false
  importer(event.dataTransfer?.files ?? null)
}

function choisir(event: Event) {
  const input = event.target as HTMLInputElement
  importer(input.files).finally(() => { input.value = '' })
}

// ---------------------------------------------------------------- invoice typed by hand (no PDF, or not read)

const fournisseurs = computed(() => [...new Set(factures.value.map((f) => f.fournisseur))].sort())

// A known supplier gives the energy of its other invoices
watch(() => saisie.value?.fournisseur, (nom) => {
  const connue = factures.value.find((f) => f.fournisseur === nom)
  if (saisie.value && connue) {
    saisie.value.energie = connue.energie
  }
})

function nouvelleSaisie(fichier: File | null = null) {
  saisie.value = { fournisseur: '', energie: 'eau', numero: '', date_facture: '', montant_ttc: '', note: '', fichier }
  erreurSaisie.value = null
}

async function creer() {
  if (!saisie.value || immeuble.value === null) {
    return
  }
  const { fichier, montant_ttc, note, ...entete } = saisie.value
  try {
    const { facture } = await api.creerFacture(
      immeuble.value,
      { ...entete, montant_ttc: nombreApi(montant_ttc) ?? montant_ttc, note: note.trim() || null },
      fichier,
    )
    await router.push({ name: 'facture', params: { id: facture.id } })
  } catch (e) {
    erreurSaisie.value = (e as Error).message
  }
}

const periode = (f: FactureResumee) => (f.debut && f.fin ? `${dateFr(f.debut)} → ${dateFr(f.fin)}` : '')
</script>

<template>
  <section class="entete-page">
    <h1>Factures</h1>
  </section>

  <p v-if="erreur" class="message erreur">{{ erreur }}</p>

  <section
    class="depot"
    :class="{ survol }"
    @dragover.prevent="survol = true"
    @dragleave="survol = false"
    @drop.prevent="deposer"
  >
    <p>Déposer des factures PDF ici, ou</p>
    <label class="bouton">
      Choisir des fichiers…
      <input type="file" accept="application/pdf" multiple hidden @change="choisir">
    </label>
    <p class="discret">Les factures d'un fournisseur qui a un extracteur (EDF, ENGIE… voir <RouterLink :to="{ name: 'fournisseurs' }">Fournisseurs</RouterLink>) sont lues automatiquement, dans le navigateur. Chaque facture importée reste un brouillon jusqu'à sa validation.</p>
  </section>

  <ul v-if="resultats.length" class="resultats">
    <li v-for="(r, i) in resultats" :key="i" :class="r.etat">
      <strong>{{ r.fichier }}</strong> : {{ r.message }}
      <RouterLink v-if="r.id" :to="{ name: 'facture', params: { id: r.id } }">ouvrir</RouterLink>
      <button v-if="r.aSaisir" type="button" @click="nouvelleSaisie(r.aSaisir)">Saisir à la main avec ce PDF</button>
      <template v-if="r.choix">
        <button v-for="c in r.choix.candidats" :key="c.enregistre.id" type="button" @click="choisirExtracteur(r, c)">
          {{ c.enregistre.fournisseur }} (v{{ c.enregistre.version }})
        </button>
      </template>
    </li>
  </ul>

  <form v-if="saisie" class="formulaire" @submit.prevent="creer">
    <strong>Nouvelle facture {{ saisie.fichier ? `(PDF joint : ${saisie.fichier.name})` : 'sans PDF' }}</strong>
    <label>Fournisseur <input v-model="saisie.fournisseur" list="fournisseurs" size="16" required></label>
    <datalist id="fournisseurs">
      <option v-for="f in fournisseurs" :key="f" :value="f" />
    </datalist>
    <label>Énergie
      <select v-model="saisie.energie">
        <option v-for="(nom, code) in ENERGIES" :key="code" :value="code">{{ nom }}</option>
      </select>
    </label>
    <label>N° <input v-model="saisie.numero" size="14" required></label>
    <label>Date <input v-model="saisie.date_facture" type="date" required></label>
    <label>Total imprimé TTC <input v-model="saisie.montant_ttc" class="nombre" size="9" required></label>
    <label>Note <input v-model="saisie.note" size="26"></label>
    <button type="submit" class="principal">Créer le brouillon</button>
    <button type="button" @click="saisie = null">Annuler</button>
    <p v-if="erreurSaisie" class="message erreur">{{ erreurSaisie }}</p>
    <p class="discret">Les lignes se saisissent ensuite dans la grille, comme pour une facture importée.</p>
  </form>
  <p v-else>
    <button type="button" @click="nouvelleSaisie()">+ Saisir une facture</button>
    <span class="discret"> sans PDF, ou dont le PDF n'est pas lu automatiquement (eau, taxe foncière…)</span>
  </p>

  <section class="filtres">
    <select v-model="energie">
      <option value="">Toutes les énergies</option>
      <option v-for="(nom, code) in ENERGIES" :key="code" :value="code">{{ nom }}</option>
    </select>
    <select v-model="annee">
      <option value="">Toutes les années</option>
      <option v-for="a in annees" :key="a" :value="a">{{ a }}</option>
    </select>
    <span class="discret">
      {{ affichees.length }} facture(s)<template v-if="brouillons"> · {{ brouillons }} brouillon(s) à vérifier</template>
    </span>
  </section>

  <table class="liste">
    <thead>
      <tr>
        <th>Date</th>
        <th>Fournisseur</th>
        <th>N°</th>
        <th>Énergie</th>
        <th>Période des lignes</th>
        <th class="nombre">Total TTC</th>
        <th class="nombre">Lignes</th>
        <th>Total</th>
        <th>Statut</th>
        <th>PDF</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="f in affichees" :key="f.id" @click="router.push({ name: 'facture', params: { id: f.id } })">
        <td>{{ dateFr(f.date_facture) }}</td>
        <td>{{ f.fournisseur }}</td>
        <td>{{ f.numero }}</td>
        <td>{{ ENERGIES[f.energie] }}</td>
        <td>{{ periode(f) }}</td>
        <td class="nombre">{{ euros(f.montant_ttc) }}</td>
        <td class="nombre">{{ f.nb_lignes }}</td>
        <td :class="f.total_ok ? 'ok' : 'ko'">{{ f.total_ok ? '✓' : f.montant_ttc === null ? '✗ total à saisir' : '✗ écart' }}</td>
        <td><span class="pastille" :class="f.statut">{{ f.statut === 'validee' ? 'Validée' : 'Brouillon' }}</span></td>
        <td>
          <a v-if="f.pdf" :href="api.pdfUrl(f.id)" target="_blank" title="Ouvrir le PDF" @click.stop>PDF</a>
          <span v-else class="discret" title="Pas de PDF : le joindre depuis la facture">—</span>
        </td>
      </tr>
    </tbody>
  </table>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'

import { api, ENERGIES, type ExtracteurEnregistre, type FactureAvecPdf, type Fournisseur, type ZoneSaisie } from '../api'
import EditeurZones from '../components/EditeurZones.vue'
import type { Zone } from '../extraction/masquage'
import { dateFr } from '../format'

// A supplier (ADR 0013, 0014): « confidentiel » (its invoices are never joined to a supporting document), and the
// versions of its extractor, the last one reading the imports; a version opens in the editor. The copies of its
// invoices joined to the supporting documents, made again at once after a change of its extractor (ADR 0024); the
// zones masked by hand on its invoices, drawn on one of them (ADR 0025).

const props = defineProps<{ id: number }>()
const router = useRouter()
const supplier = ref<Fournisseur | null>(null)
const versions = ref<ExtracteurEnregistre[]>([])
const message = ref<{ text: string, type: 'info' | 'erreur' } | null>(null)

async function charger() {
  try {
    supplier.value = await api.supplier(props.id)
    versions.value = (await api.extractors()).filter((e) => e.supplier === supplier.value?.name)
    invoices.value = await api.facturesDuFournisseur(supplier.value.name)
    zones.value = supplier.value.masked_zones.map((z) => ({ ...z }))
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
  }
}

onMounted(charger)
watch(() => props.id, charger)

const latest = computed(() => versions.value[0] ?? null)

// ---------------------------------------------------------------- copies joined to the supporting documents (ADR 0024)

const invoices = ref<FactureAvecPdf[]>([])
// Invoices whose copy can be joined: not replaced, its supplier not confidential
const aJoindre = computed(() => invoices.value.filter((f) => f.status !== 'replaced' && f.tenant_copy !== 'confidential'))
const account = (state: FactureAvecPdf['tenant_copy']) => aJoindre.value.filter((f) => f.tenant_copy === state).length
const progression = ref<string | null>(null)

async function refaireCopies() {
  if (!supplier.value) {
    return
  }
  const { preparerAnnexe } = await import('../extraction/navigateur')
  const donnees = { terms: await api.termesMasques(), extractors: await api.extractors(), modele: supplier.value.masked_zones }
  const erreurs: string[] = []
  const liste = aJoindre.value
  for (const [i, f] of liste.entries()) {
    progression.value = `Copie ${i + 1} sur ${liste.length} : n° ${f.number}…`
    try {
      await preparerAnnexe({ ...f, supplier: supplier.value.name }, donnees)
    } catch (e) {
      erreurs.push(`n° ${f.number} : ${(e as Error).message}`)
    }
  }
  progression.value = null
  message.value = erreurs.length
    ? { text: `Copies non refaites : ${erreurs.join(' ; ')}`, type: 'erreur' }
    : { text: `${liste.length} version(s) locataire recréée(s) : à contrôler sur chaque facture`, type: 'info' }
  await charger()
}

// ---------------------------------------------------------------- zones drawn by hand (ADR 0025)

const zones = ref<ZoneSaisie[]>([])
// The invoice the zones are drawn on, and its PDF
const factureZones = ref<number | null>(null)
const contenuZones = ref<Uint8Array | null>(null)
// What the terms and its extractor already mask on that invoice
const automatiques = ref<Zone[]>([])
const zonesModifiees = computed(() => JSON.stringify(zones.value) !== JSON.stringify(supplier.value?.masked_zones ?? []))

watch(factureZones, async (id) => {
  automatiques.value = []
  const contenu = id === null ? null : new Uint8Array(await (await fetch(api.pdfUrl(id))).arrayBuffer())
  contenuZones.value = contenu
  if (contenu && supplier.value) {
    const { zonesAutomatiques } = await import('../extraction/navigateur')
    const zones = await zonesAutomatiques(contenu.slice(), supplier.value.name)
    if (contenuZones.value === contenu) {
      automatiques.value = zones
    }
  }
})

async function enregistrerZones() {
  if (!supplier.value) {
    return
  }
  try {
    supplier.value = await api.modifierZonesFournisseur(supplier.value.id, zones.value)
    message.value = { text: 'Zones enregistrées : recréer les versions locataire pour les appliquer', type: 'info' }
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
  }
}

const energies = computed(() => (supplier.value?.energies ?? []).map((e) => ENERGIES[e]).join(', '))

async function basculerConfidentiel(event: Event) {
  if (!supplier.value) {
    return
  }
  const confidential = (event.target as HTMLInputElement).checked
  try {
    supplier.value = await api.modifierFournisseur(supplier.value.id, { confidential })
    message.value = {
      text: confidential ? 'Ses factures ne seront plus jointes aux justificatifs' : 'Ses factures seront jointes aux justificatifs',
      type: 'info',
    }
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
  }
}

function ecrireExtracteur(type: 'invoice' | 'bank_statement') {
  router.push({ name: type === 'bank_statement' ? 'nouvel-extracteur-releve' : 'nouvel-extracteur', query: { supplier: supplier.value?.name } })
}

// A bank: its extractor reads statements, edited in its own editor (ADR 0018)
const releve = computed(() => latest.value?.type === 'bank_statement')
const editeur = (id: number) => ({ name: releve.value ? 'extracteur-releve' : 'extractor', params: { id } })
</script>

<template>
  <RouterLink :to="{ name: 'suppliers' }">← Fournisseurs</RouterLink>
  <template v-if="supplier">
    <section class="entete-page">
      <h1>{{ supplier.name }}</h1>
    </section>
    <p v-if="releve" class="discret">Banque · {{ supplier.statement_count }} relevé(s) importé(s) (écran Banque)</p>
    <p v-else class="discret">
      {{ energies || 'Énergie non connue' }} ·
      {{ supplier.invoice_count }} facture(s), dont {{ supplier.pdf_count }} avec PDF
    </p>

    <p v-if="message" class="message" :class="message.type">{{ message.text }}</p>

    <h2 v-if="!releve">Justificatifs des régularisations</h2>
    <label v-if="!releve" class="case">
      <input type="checkbox" :checked="supplier.confidential" @change="basculerConfidentiel">
      Confidentiel : ne jamais joindre ses factures au justificatif d'une régularisation (elles y sont listées,
      « non jointe : document confidentiel, consultable sur demande »)
    </label>

    <template v-if="!releve && !supplier.confidential && aJoindre.length">
      <p class="discret">
        Ses factures sont jointes au justificatif dans leur version locataire, en images, où sont masqués les termes de
        l'écran « Fournisseurs » et ce que masque son extracteur ({{ account('checked') }} contrôlée(s),
        {{ account('to_check') }} à contrôler, {{ account('to_make') }} à créer). Après un changement de l'extracteur ou
        des termes, les recréer : chacune est alors à contrôler de nouveau.
      </p>
      <div class="actions-page">
        <button type="button" :disabled="!!progression" @click="refaireCopies">
          Recréer les versions locataire de ses {{ aJoindre.length }} facture(s)
        </button>
        <span v-if="progression" class="discret">{{ progression }}</span>
      </div>
      <h3>Zones masquées à la main</h3>
      <p class="discret">
        Sur une facture scannée, le texte lu par le scanner n'est pas fiable : seules ces zones y sont masquées. Sur une
        facture en texte, elles masquent ce que la recherche ne trouve pas (une image, un QR code), en plus des termes et
        de l'extracteur ({{ supplier.masked_zones.length }} enregistrée(s)). Les tracer à la souris sur une de ses
        factures ; chaque facture peut ensuite ajuster les siennes (onglet « Version locataire »).
      </p>
      <div class="actions-page">
        <label>Tracer sur la facture
          <select v-model="factureZones">
            <option :value="null">—</option>
            <option v-for="f in aJoindre" :key="f.id" :value="f.id">n° {{ f.number }} ({{ dateFr(f.invoice_date) }})</option>
          </select>
        </label>
        <button type="button" :disabled="!zonesModifiees" @click="enregistrerZones">Enregistrer les zones</button>
        <button type="button" :disabled="!zonesModifiees" @click="zones = supplier.masked_zones.map((z) => ({ ...z }))">
          Annuler
        </button>
      </div>
      <EditeurZones v-if="contenuZones" v-model="zones" :contenu="contenuZones" :automatiques="automatiques" />
      <ul v-if="account('to_check') || account('to_make')" class="a-verifier">
        <li v-for="f in aJoindre.filter((f) => f.tenant_copy !== 'checked')" :key="f.id">
          <RouterLink :to="{ name: 'invoice', params: { id: f.id } }">n° {{ f.number }}</RouterLink>
          ({{ f.building }}, {{ dateFr(f.invoice_date) }}) : {{ f.tenant_copy === 'to_make' ? 'à créer' : 'à contrôler' }}
        </li>
      </ul>
    </template>

    <h2>Extracteur</h2>
    <template v-if="latest">
      <p class="discret">
        La dernière version lit les PDF de ce {{ releve ? 'banque (relevés)' : 'fournisseur' }} à l'import. Une version
        ne change plus : la modifier, c'est enregistrer la suivante.
      </p>
      <div class="actions-page">
        <RouterLink :to="editeur(latest.id)" class="bouton">
          Modifier l'extracteur (à partir de la v{{ latest.version }})
        </RouterLink>
      </div>
      <table class="liste">
        <thead>
          <tr><th>Version</th><th>Créée le</th><th>Note</th><th class="nombre">{{ releve ? 'Relevés lus' : 'Factures lues' }}</th><th /></tr>
        </thead>
        <tbody>
          <tr v-for="v in versions" :key="v.id" @click="router.push(editeur(v.id))">
            <td>v{{ v.version }}{{ v.latest ? ' (utilisée)' : '' }}</td>
            <td>{{ dateFr(v.created_at.slice(0, 10)) }}</td>
            <td class="discret">{{ v.note }}</td>
            <td class="nombre">{{ releve ? v.statement_count : v.invoice_count }}</td>
            <td><RouterLink :to="editeur(v.id)">ouvrir</RouterLink></td>
          </tr>
        </tbody>
      </table>
    </template>
    <template v-else>
      <p class="discret">Pas d'extracteur : ses factures se saisissent à la main.</p>
      <div class="actions-page">
        <button type="button" @click="ecrireExtracteur('invoice')">Écrire un extracteur de factures</button>
        <button type="button" @click="ecrireExtracteur('bank_statement')">Écrire un extracteur de relevés (banque)</button>
      </div>
    </template>
  </template>
  <p v-else-if="message" class="message" :class="message.type">{{ message.text }}</p>
</template>

<style scoped>
.liste tbody tr {
  cursor: pointer;
}

.case {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
  max-width: 60rem;
}
</style>

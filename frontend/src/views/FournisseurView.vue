<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'

import { api, ENERGIES, type ExtracteurEnregistre, type Fournisseur } from '../api'
import { dateFr } from '../format'

// A supplier (ADR 0013, 0014): « confidentiel » (its invoices are never joined to a supporting document), and the
// versions of its extractor, the last one reading the imports; a version opens in the editor.

const props = defineProps<{ id: number }>()
const router = useRouter()
const fournisseur = ref<Fournisseur | null>(null)
const versions = ref<ExtracteurEnregistre[]>([])
const message = ref<{ texte: string, type: 'info' | 'erreur' } | null>(null)

async function charger() {
  try {
    fournisseur.value = await api.fournisseur(props.id)
    versions.value = (await api.extracteurs()).filter((e) => e.fournisseur === fournisseur.value?.nom)
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}

onMounted(charger)
watch(() => props.id, charger)

const derniere = computed(() => versions.value[0] ?? null)
const energies = computed(() => (fournisseur.value?.energies ?? []).map((e) => ENERGIES[e]).join(', '))

async function basculerConfidentiel(event: Event) {
  if (!fournisseur.value) {
    return
  }
  const confidentiel = (event.target as HTMLInputElement).checked
  try {
    fournisseur.value = await api.modifierFournisseur(fournisseur.value.id, { confidentiel })
    message.value = {
      texte: confidentiel ? 'Ses factures ne seront plus jointes aux justificatifs' : 'Ses factures seront jointes aux justificatifs',
      type: 'info',
    }
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}

function ecrireExtracteur(type: 'facture' | 'releve') {
  router.push({ name: type === 'releve' ? 'nouvel-extracteur-releve' : 'nouvel-extracteur', query: { fournisseur: fournisseur.value?.nom } })
}

// A bank: its extractor reads statements, edited in its own editor (ADR 0018)
const releve = computed(() => derniere.value?.type === 'releve')
const editeur = (id: number) => ({ name: releve.value ? 'extracteur-releve' : 'extracteur', params: { id } })
</script>

<template>
  <RouterLink :to="{ name: 'fournisseurs' }">← Fournisseurs</RouterLink>
  <template v-if="fournisseur">
    <section class="entete-page">
      <h1>{{ fournisseur.nom }}</h1>
    </section>
    <p v-if="releve" class="discret">Banque · {{ fournisseur.nb_releves }} relevé(s) importé(s) (écran Banque)</p>
    <p v-else class="discret">
      {{ energies || 'Énergie non connue' }} ·
      {{ fournisseur.nb_factures }} facture(s), dont {{ fournisseur.nb_pdf }} avec PDF
    </p>

    <p v-if="message" class="message" :class="message.type">{{ message.texte }}</p>

    <h2 v-if="!releve">Justificatifs des régularisations</h2>
    <label v-if="!releve" class="case">
      <input type="checkbox" :checked="fournisseur.confidentiel" @change="basculerConfidentiel">
      Confidentiel : ne jamais joindre ses factures au justificatif d'une régularisation (elles y sont listées,
      « non jointe : document confidentiel, consultable sur demande »)
    </label>

    <h2>Extracteur</h2>
    <template v-if="derniere">
      <p class="discret">
        La dernière version lit les PDF de ce {{ releve ? 'banque (relevés)' : 'fournisseur' }} à l'import. Une version
        ne change plus : la modifier, c'est enregistrer la suivante.
      </p>
      <div class="actions-page">
        <RouterLink :to="editeur(derniere.id)" class="bouton">
          Modifier l'extracteur (à partir de la v{{ derniere.version }})
        </RouterLink>
      </div>
      <table class="liste">
        <thead>
          <tr><th>Version</th><th>Créée le</th><th>Note</th><th class="nombre">{{ releve ? 'Relevés lus' : 'Factures lues' }}</th><th /></tr>
        </thead>
        <tbody>
          <tr v-for="v in versions" :key="v.id" @click="router.push(editeur(v.id))">
            <td>v{{ v.version }}{{ v.derniere ? ' (utilisée)' : '' }}</td>
            <td>{{ dateFr(v.cree_le.slice(0, 10)) }}</td>
            <td class="discret">{{ v.note }}</td>
            <td class="nombre">{{ releve ? v.nb_releves : v.nb_factures }}</td>
            <td><RouterLink :to="editeur(v.id)">ouvrir</RouterLink></td>
          </tr>
        </tbody>
      </table>
    </template>
    <template v-else>
      <p class="discret">Pas d'extracteur : ses factures se saisissent à la main.</p>
      <div class="actions-page">
        <button type="button" @click="ecrireExtracteur('facture')">Écrire un extracteur de factures</button>
        <button type="button" @click="ecrireExtracteur('releve')">Écrire un extracteur de relevés (banque)</button>
      </div>
    </template>
  </template>
  <p v-else-if="message" class="message" :class="message.type">{{ message.texte }}</p>
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

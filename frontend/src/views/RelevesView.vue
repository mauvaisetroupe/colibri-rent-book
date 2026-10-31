<script setup lang="ts">
import Button from 'openvue/button'
import Column from 'openvue/column'
import ConfirmDialog from 'openvue/confirmdialog'
import DataTable from 'openvue/datatable'
import Toast from 'openvue/toast'
import { useConfirm } from 'openvue/useconfirm'
import { useToast } from 'openvue/usetoast'
import { onMounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'

import { api, ApiError, type ExtracteurEnregistre, type ReleveResume } from '../api'
import { dateFr, euros } from '../format'
import { stateKey } from '../lists'

// Bank statements (ADR 0018): the PDFs are read here, in the browser, by the extractor of their bank, checked (the
// balances add up to the cent) and stored with their movements; each statement opens on its page (PDF and movements
// read, side by side), to check what the extractor read. The movements are categorised in « Catégorisation ».

const router = useRouter()
const confirm = useConfirm()
const toast = useToast()

const statements = ref<ReleveResume[]>([])
const occupe = ref(false)

onMounted(charger)

async function charger() {
  try {
    statements.value = await api.statements()
  } catch (e) {
    toast.add({ severity: 'error', summary: (e as Error).message, life: 6000 })
  }
}

// ---------------------------------------------------------------- import

const survol = ref(false)
const resultats = ref<{ name: string, state: 'en_cours' | 'importe' | 'doublon' | 'erreur', text: string, releveId: number | null }[]>([])

async function importer(fichiers: FileList | File[] | null | undefined) {
  const liste = [...(fichiers ?? [])].filter((f) => f.name.toLowerCase().endsWith('.pdf'))
  if (!liste.length) {
    return
  }
  occupe.value = true
  resultats.value = liste.map((f) => ({ name: f.name, state: 'en_cours', text: 'lecture…', releveId: null }))
  try {
    const { candidatsReleve, lireReleve, morceauxDuPdf } = await import('../extraction/navigateur')
    const { releveAImporter } = await import('../extraction/moteurReleve')
    const extractors: ExtracteurEnregistre[] = await api.extractors()
    for (const [i, fichier] of liste.entries()) {
      const resultat = resultats.value[i]!
      try {
        const pages = await morceauxDuPdf(fichier)
        const [candidat] = candidatsReleve(pages, extractors)
        if (!candidat) {
          Object.assign(resultat, { state: 'erreur', text: 'aucun extracteur de relevé ne reconnaît ce PDF (une facture ? une image ?)' })
          continue
        }
        const { releve, probleme } = releveAImporter(lireReleve(pages, candidat), candidat.enregistre.id)
        if (!releve) {
          Object.assign(resultat, { state: 'erreur', text: `${candidat.enregistre.supplier} : ${probleme}` })
          continue
        }
        const importe = await api.importerReleve(fichier, releve)
        Object.assign(resultat, {
          state: 'importe', releveId: importe.id,
          text: `${importe.bank}, compte ${importe.account}, relevé du ${dateFr(importe.statement_date)} : ${importe.transactions.length} mouvement(s)`,
        })
      } catch (e) {
        const doublon = e instanceof ApiError && e.status === 409
        Object.assign(resultat, {
          state: doublon ? 'doublon' : 'erreur', text: (e as Error).message,
          releveId: doublon ? (e as ApiError).body.bank_statement_id as number ?? null : null,
        })
      }
    }
  } finally {
    occupe.value = false
  }
  await charger()
  // One statement imported: its page, to check what was read
  const importes = resultats.value.filter((r) => r.state === 'importe')
  if (liste.length === 1 && importes.length === 1) {
    await router.push({ name: 'bank_statement', params: { id: importes[0]!.releveId! } })
  }
}

function choisirFichiers(event: Event) {
  const input = event.target as HTMLInputElement
  importer(input.files).finally(() => { input.value = '' })
}

function supprimer(r: ReleveResume) {
  confirm.require({
    message: `Supprimer le relevé du ${dateFr(r.statement_date)} (compte ${r.account}) et ses mouvements ?`,
    header: 'Supprimer', acceptLabel: 'Supprimer', rejectLabel: 'Annuler', acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await api.supprimerReleve(r.id)
        toast.add({ severity: 'success', summary: 'Relevé supprimé', life: 3000 })
        await charger()
      } catch (e) {
        toast.add({ severity: 'error', summary: (e as Error).message, life: 6000 })
      }
    },
  })
}
</script>

<template>
  <Toast />
  <ConfirmDialog />
  <section class="entete-page">
    <h1>Relevés bancaires</h1>
  </section>
  <p class="discret">
    Les relevés PDF de la banque, lus par l'extracteur de la banque (voir <RouterLink to="/fournisseurs">Fournisseurs</RouterLink>).
    Un relevé n'est enregistré que si solde précédent + crédits − débits retombe au centime sur le nouveau solde. Ouvrir
    un relevé pour comparer son PDF aux mouvements lus ; ses mouvements se catégorisent dans
    <RouterLink to="/banque">Catégorisation des mouvements</RouterLink>.
  </p>

  <div
    class="depot" :class="{ survol }"
    @dragover.prevent="survol = true" @dragleave="survol = false" @drop.prevent="survol = false; importer($event.dataTransfer?.files)"
  >
    <p>Déposer des relevés PDF ici, ou
      <label class="bouton">Choisir des fichiers… <input type="file" accept="application/pdf" multiple hidden :disabled="occupe" @change="choisirFichiers"></label>
    </p>
    <p class="discret">Un relevé déjà importé est refusé.</p>
  </div>
  <ul v-if="resultats.length" class="resultats">
    <li v-for="(r, i) in resultats" :key="i" :class="r.state">
      <strong>{{ r.name }}</strong> : {{ r.text }}
      <RouterLink v-if="r.releveId" :to="{ name: 'bank_statement', params: { id: r.releveId } }">ouvrir</RouterLink>
    </li>
  </ul>

  <DataTable
    :value="statements" data-key="id" size="small" striped-rows paginator :rows="25" sort-field="statement_date" :sort-order="-1"
    state-storage="session" :state-key="stateKey('statements')"
    class="releves" @row-click="router.push({ name: 'bank_statement', params: { id: $event.data.id } })"
  >
    <template #empty>Aucun relevé importé.</template>
    <Column field="statement_date" header="Relevé du" sortable>
      <template #body="{ data }">{{ dateFr(data.statement_date) }}</template>
    </Column>
    <Column field="bank" header="Banque" />
    <Column field="account" header="Compte" sortable />
    <Column header="Solde précédent" body-class="nombre" header-class="nombre">
      <template #body="{ data }">{{ euros(data.previous_balance) }}</template>
    </Column>
    <Column header="Nouveau solde" body-class="nombre" header-class="nombre">
      <template #body="{ data }">{{ euros(data.new_balance) }}</template>
    </Column>
    <Column field="transaction_count" header="Mouvements" body-class="nombre" header-class="nombre" />
    <Column header="Suite">
      <template #body="{ data }">
        <span :class="data.suite === false ? 'ko' : 'ok'">{{ data.suite === false ? '✗ relevé manquant avant' : data.suite ? '✓' : '' }}</span>
      </template>
    </Column>
    <Column>
      <template #body="{ data }">
        <span class="actions" @click.stop>
          <a v-if="data.pdf" :href="api.relevePdfUrl(data.id)" target="_blank">PDF</a>
          <Button label="Supprimer" severity="danger" text size="small" :disabled="occupe" @click="supprimer(data)" />
        </span>
      </template>
    </Column>
  </DataTable>
</template>

<style scoped>
.depot {
  border: 2px dashed var(--bord);
  border-radius: 8px;
  padding: 0.8rem 1rem;
  text-align: center;
  margin-bottom: 0.8rem;
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

.releves :deep(tbody tr) {
  cursor: pointer;
}

.actions {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}
</style>

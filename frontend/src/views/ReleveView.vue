<script setup lang="ts">
import Big from 'big.js'
import Button from 'openvue/button'
import Column from 'openvue/column'
import ConfirmDialog from 'openvue/confirmdialog'
import DataTable from 'openvue/datatable'
import Tag from 'openvue/tag'
import Toast from 'openvue/toast'
import { useConfirm } from 'openvue/useconfirm'
import { useToast } from 'openvue/usetoast'
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'

import { api, CATEGORIES_MOUVEMENT, type CategorieMouvement, type ReleveDetail, type ReleveResume } from '../api'
import { dateFr, euros } from '../format'

// A bank statement (ADR 0018): its PDF next to the movements read by the extractor, with the checks, to see that
// nothing was misread (a date, a label, a detail attached to the wrong movement). Movements are not changed by hand:
// they are the bank's; a wrong reading is corrected in the extractor, then the statement is deleted and imported again.

const props = defineProps<{ id: number }>()
const router = useRouter()
// Opened from a movement (« Catégorisation »): that movement is highlighted
const route = useRoute()
const surligne = computed(() => Number(route.query.bank_transaction) || null)
const confirm = useConfirm()
const toast = useToast()

const releve = ref<ReleveDetail | null>(null)
const statements = ref<ReleveResume[]>([])

watch(() => props.id, charger, { immediate: true })

async function charger() {
  try {
    ;[releve.value, statements.value] = await Promise.all([api.releve(props.id), api.statements()])
  } catch (e) {
    toast.add({ severity: 'error', summary: (e as Error).message, life: 6000 })
  }
}

const credits = computed(() => (releve.value?.transactions ?? []).filter((m) => new Big(m.amount).gt(0))
  .reduce((t, m) => t.plus(m.amount), new Big(0)))
const debits = computed(() => (releve.value?.transactions ?? []).filter((m) => new Big(m.amount).lt(0))
  .reduce((t, m) => t.plus(m.amount), new Big(0)).abs())
const calcule = computed(() => (releve.value ? new Big(releve.value.previous_balance).plus(credits.value).minus(debits.value) : null))
const equilibre = computed(() => Boolean(releve.value && calcule.value?.eq(releve.value.new_balance)))

// The statements of the same account, in date order: the previous one, the next one, and whether they follow each other
const duCompte = computed(() => statements.value.filter((r) => r.account === releve.value?.account)
  .sort((a, b) => a.statement_date.localeCompare(b.statement_date)))
const rang = computed(() => duCompte.value.findIndex((r) => r.id === props.id))
const previous = computed(() => duCompte.value[rang.value - 1] ?? null)
const suivant = computed(() => duCompte.value[rang.value + 1] ?? null)
const suite = computed(() => duCompte.value[rang.value]?.suite ?? null)

const nomCategorie = (c: CategorieMouvement) => CATEGORIES_MOUVEMENT[c].name
const categorises = computed(() => (releve.value?.transactions ?? []).filter((m) => m.category).length)

function supprimer() {
  const r = releve.value
  if (!r) {
    return
  }
  confirm.require({
    message: `Supprimer le relevé du ${dateFr(r.statement_date)} (compte ${r.account}) et ses mouvements ? Pour le lire de nouveau (extracteur corrigé), le réimporter ensuite.`,
    header: 'Supprimer', acceptLabel: 'Supprimer', rejectLabel: 'Annuler', acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await api.supprimerReleve(r.id)
        await router.push({ name: 'statements' })
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
  <RouterLink :to="{ name: 'statements' }">← Relevés bancaires</RouterLink>
  <template v-if="releve">
    <section class="entete-page">
      <h1>Relevé du {{ dateFr(releve.statement_date) }}</h1>
      <span class="discret">{{ releve.bank }}, compte {{ releve.account }}</span>
      <span class="navigation">
        <Button
          icon="oi oi-angle-left" :label="previous ? dateFr(previous.statement_date) : ''" size="small" text :disabled="!previous"
          @click="previous && router.push({ name: 'bank_statement', params: { id: previous.id } })"
        />
        <Button
          icon="oi oi-angle-right" icon-pos="right" :label="suivant ? dateFr(suivant.statement_date) : ''" size="small" text :disabled="!suivant"
          @click="suivant && router.push({ name: 'bank_statement', params: { id: suivant.id } })"
        />
      </span>
    </section>

    <ul class="controles">
      <li>Solde précédent <strong>{{ euros(releve.previous_balance) }}</strong></li>
      <li>+ crédits <strong class="ok">{{ euros(credits.toString()) }}</strong></li>
      <li>− débits <strong>{{ euros(debits.toString()) }}</strong></li>
      <li>= <strong>{{ euros(calcule?.toString() ?? null) }}</strong></li>
      <li :class="equilibre ? 'ok' : 'ko'">{{ equilibre ? '✓' : '✗' }} nouveau solde {{ euros(releve.new_balance) }}</li>
      <li v-if="suite !== null" :class="suite ? 'ok' : 'ko'">
        {{ suite ? '✓ suit le relevé précédent' : '✗ ne suit pas le relevé précédent (relevé manquant ?)' }}
      </li>
    </ul>

    <div class="cote-a-cote">
      <div class="mouvements">
        <DataTable
          :value="releve.transactions" data-key="id" size="small" striped-rows
          :row-class="(m: { id: number }) => (m.id === surligne ? 'surligne' : '')"
        >
          <template #header>
            <div class="entete-table">
              <span>{{ releve.transactions.length }} mouvement(s) lus, {{ categorises }} catégorisé(s)</span>
              <RouterLink :to="{ name: 'bank', query: { releve: releve.id } }" class="bouton">Catégoriser ses mouvements</RouterLink>
            </div>
          </template>
          <Column header="Date">
            <template #body="{ data }">
              {{ dateFr(data.transaction_date) }}
              <div v-if="data.value_date && data.value_date !== data.transaction_date" class="discret petit">valeur {{ dateFr(data.value_date) }}</div>
            </template>
          </Column>
          <Column header="Opération">
            <template #body="{ data }">
              <strong>{{ data.label }}</strong>
              <div v-if="data.detail" class="detail-ligne">{{ data.detail }}</div>
            </template>
          </Column>
          <Column header="Débit" body-class="nombre" header-class="nombre">
            <template #body="{ data }">{{ Number(data.amount) < 0 ? euros(new Big(data.amount).abs().toString()) : '' }}</template>
          </Column>
          <Column header="Crédit" body-class="nombre" header-class="nombre">
            <template #body="{ data }"><span class="ok">{{ Number(data.amount) > 0 ? euros(data.amount) : '' }}</span></template>
          </Column>
          <Column header="Catégorie">
            <template #body="{ data }">
              <Tag v-if="data.category" :value="nomCategorie(data.category)" severity="info" />
            </template>
          </Column>
        </DataTable>
        <div class="pied">
          <span class="discret">
            Une erreur de lecture ? Corriger l'extracteur de la banque
            (<RouterLink to="/fournisseurs">Fournisseurs</RouterLink>), puis supprimer et réimporter ce relevé.
          </span>
          <Button label="Supprimer le relevé" severity="danger" text size="small" @click="supprimer" />
        </div>
      </div>
      <iframe v-if="releve.pdf" class="apercu" :src="api.relevePdfUrl(releve.id)" title="Relevé PDF" />
      <p v-else class="discret">Pas de PDF pour ce relevé.</p>
    </div>
  </template>
</template>

<style scoped>
.entete-page {
  align-items: baseline;
}

.navigation {
  margin-left: auto;
  display: inline-flex;
  gap: 0.3rem;
}

.controles {
  display: flex;
  flex-wrap: wrap;
  gap: 1.2rem;
  list-style: none;
  padding: 0.5rem 0.8rem;
  margin: 0.5rem 0 0.8rem;
  border-radius: 6px;
  background: var(--surface);
}

.cote-a-cote {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
  gap: 0.8rem;
  align-items: start;
}

.apercu {
  width: 100%;
  height: calc(100vh - 13rem);
  min-height: 500px;
  border: 1px solid var(--bord);
}

.detail-ligne {
  white-space: pre-line;
  font-size: 0.8rem;
  color: var(--discret);
}

.mouvements :deep(tr.surligne > td) {
  background: var(--fond-avertissement);
}

.petit {
  font-size: 0.75rem;
}

.entete-table {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.pied {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
</style>

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
const surligne = computed(() => Number(route.query.mouvement) || null)
const confirm = useConfirm()
const toast = useToast()

const releve = ref<ReleveDetail | null>(null)
const releves = ref<ReleveResume[]>([])

watch(() => props.id, charger, { immediate: true })

async function charger() {
  try {
    ;[releve.value, releves.value] = await Promise.all([api.releve(props.id), api.releves()])
  } catch (e) {
    toast.add({ severity: 'error', summary: (e as Error).message, life: 6000 })
  }
}

const credits = computed(() => (releve.value?.mouvements ?? []).filter((m) => new Big(m.montant).gt(0))
  .reduce((t, m) => t.plus(m.montant), new Big(0)))
const debits = computed(() => (releve.value?.mouvements ?? []).filter((m) => new Big(m.montant).lt(0))
  .reduce((t, m) => t.plus(m.montant), new Big(0)).abs())
const calcule = computed(() => (releve.value ? new Big(releve.value.solde_precedent).plus(credits.value).minus(debits.value) : null))
const equilibre = computed(() => Boolean(releve.value && calcule.value?.eq(releve.value.nouveau_solde)))

// The statements of the same account, in date order: the previous one, the next one, and whether they follow each other
const duCompte = computed(() => releves.value.filter((r) => r.compte === releve.value?.compte)
  .sort((a, b) => a.date_releve.localeCompare(b.date_releve)))
const rang = computed(() => duCompte.value.findIndex((r) => r.id === props.id))
const precedent = computed(() => duCompte.value[rang.value - 1] ?? null)
const suivant = computed(() => duCompte.value[rang.value + 1] ?? null)
const suite = computed(() => duCompte.value[rang.value]?.suite ?? null)

const nomCategorie = (c: CategorieMouvement) => CATEGORIES_MOUVEMENT[c].nom
const categorises = computed(() => (releve.value?.mouvements ?? []).filter((m) => m.categorie).length)

function supprimer() {
  const r = releve.value
  if (!r) {
    return
  }
  confirm.require({
    message: `Supprimer le relevé du ${dateFr(r.date_releve)} (compte ${r.compte}) et ses mouvements ? Pour le lire de nouveau (extracteur corrigé), le réimporter ensuite.`,
    header: 'Supprimer', acceptLabel: 'Supprimer', rejectLabel: 'Annuler', acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await api.supprimerReleve(r.id)
        await router.push({ name: 'releves' })
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
  <RouterLink :to="{ name: 'releves' }">← Relevés bancaires</RouterLink>
  <template v-if="releve">
    <section class="entete-page">
      <h1>Relevé du {{ dateFr(releve.date_releve) }}</h1>
      <span class="discret">{{ releve.banque }}, compte {{ releve.compte }}</span>
      <span class="navigation">
        <Button
          icon="oi oi-angle-left" :label="precedent ? dateFr(precedent.date_releve) : ''" size="small" text :disabled="!precedent"
          @click="precedent && router.push({ name: 'releve', params: { id: precedent.id } })"
        />
        <Button
          icon="oi oi-angle-right" icon-pos="right" :label="suivant ? dateFr(suivant.date_releve) : ''" size="small" text :disabled="!suivant"
          @click="suivant && router.push({ name: 'releve', params: { id: suivant.id } })"
        />
      </span>
    </section>

    <ul class="controles">
      <li>Solde précédent <strong>{{ euros(releve.solde_precedent) }}</strong></li>
      <li>+ crédits <strong class="ok">{{ euros(credits.toString()) }}</strong></li>
      <li>− débits <strong>{{ euros(debits.toString()) }}</strong></li>
      <li>= <strong>{{ euros(calcule?.toString() ?? null) }}</strong></li>
      <li :class="equilibre ? 'ok' : 'ko'">{{ equilibre ? '✓' : '✗' }} nouveau solde {{ euros(releve.nouveau_solde) }}</li>
      <li v-if="suite !== null" :class="suite ? 'ok' : 'ko'">
        {{ suite ? '✓ suit le relevé précédent' : '✗ ne suit pas le relevé précédent (relevé manquant ?)' }}
      </li>
    </ul>

    <div class="cote-a-cote">
      <div class="mouvements">
        <DataTable
          :value="releve.mouvements" data-key="id" size="small" striped-rows
          :row-class="(m: { id: number }) => (m.id === surligne ? 'surligne' : '')"
        >
          <template #header>
            <div class="entete-table">
              <span>{{ releve.mouvements.length }} mouvement(s) lus, {{ categorises }} catégorisé(s)</span>
              <RouterLink :to="{ name: 'banque', query: { releve: releve.id } }" class="bouton">Catégoriser ses mouvements</RouterLink>
            </div>
          </template>
          <Column header="Date">
            <template #body="{ data }">
              {{ dateFr(data.date_operation) }}
              <div v-if="data.date_valeur && data.date_valeur !== data.date_operation" class="discret petit">valeur {{ dateFr(data.date_valeur) }}</div>
            </template>
          </Column>
          <Column header="Opération">
            <template #body="{ data }">
              <strong>{{ data.libelle }}</strong>
              <div v-if="data.detail" class="detail-ligne">{{ data.detail }}</div>
            </template>
          </Column>
          <Column header="Débit" body-class="nombre" header-class="nombre">
            <template #body="{ data }">{{ Number(data.montant) < 0 ? euros(new Big(data.montant).abs().toString()) : '' }}</template>
          </Column>
          <Column header="Crédit" body-class="nombre" header-class="nombre">
            <template #body="{ data }"><span class="ok">{{ Number(data.montant) > 0 ? euros(data.montant) : '' }}</span></template>
          </Column>
          <Column header="Catégorie">
            <template #body="{ data }">
              <Tag v-if="data.categorie" :value="nomCategorie(data.categorie)" severity="info" />
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

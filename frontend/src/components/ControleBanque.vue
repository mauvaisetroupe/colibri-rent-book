<script setup lang="ts">
import Big from 'big.js'
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

import { api, type FactureResumee, type Mouvement, type Paiement, type ReleveResume } from '../api'
import { etatBanque, facturesAvecEcart, nbProblemesBanque } from '../controleBanque'
import { dateFr, euros } from '../format'

// The « Banque » group of the checks: statements missing, movements to categorise or to complete, payments of the
// exercise that no statement shows (see controleBanque.ts).

const props = defineProps<{ building: number, start: string, end: string }>()

const statements = ref<ReleveResume[]>([])
const transactions = ref<Mouvement[]>([])
const payments = ref<Paiement[]>([])
const invoices = ref<FactureResumee[]>([])
const erreur = ref<string | null>(null)

async function charger() {
  try {
    const annees = [...new Set([Number(props.start.slice(0, 4)), Number(props.end.slice(0, 4))])]
    let lus: Paiement[][]
    ;[statements.value, transactions.value, invoices.value, ...lus] = await Promise.all([
      api.statements(), api.transactions('tous', props.start, props.end), api.invoices(props.building),
      ...annees.map((a) => api.payments(props.building, a)),
    ])
    payments.value = lus.flat()
    erreur.value = null
  } catch (e) {
    erreur.value = (e as Error).message
  }
}
watch(() => [props.building, props.start, props.end], charger, { immediate: true })

const state = computed(() => etatBanque(statements.value, transactions.value, payments.value, props.start, props.end))
const problemes = computed(() => nbProblemesBanque(state.value))
// Invoices paid with a gap (ADR 0022: a balance rounded by the supplier, up to 1 euro): shown, not a problem
const ecarts = computed(() => facturesAvecEcart(invoices.value, props.start, props.end))
const total = (p: Paiement) => new Big(p.rent).plus(p.charge_advance).plus(p.charge_adjustment).toString()
const month = (p: Paiement) => (p.month ? `${p.month.slice(5, 7)}/${p.month.slice(0, 4)}` : 'régularisation')
</script>

<template>
  <section class="bloc">
    <h2>Banque</h2>
    <p v-if="erreur" class="message erreur">{{ erreur }}</p>
    <template v-else-if="!statements.length">
      <p class="discret">Aucun relevé importé (<RouterLink to="/banque/releves">Relevés bancaires</RouterLink>).</p>
    </template>
    <template v-else>
      <p class="bilan" :class="problemes ? 'ko' : 'ok'">
        <template v-if="problemes">
          {{ state.aCategoriser.length }} mouvement(s) à catégoriser · {{ state.incomplets.length }} à rattacher ·
          {{ state.sansMouvement.length }} paiement(s) absent(s) des relevés
        </template>
        <template v-else>✓ Relevés complets, chaque mouvement catégorisé, chaque paiement vu sur un relevé</template>
      </p>
      <p class="discret">
        <template v-for="(c, i) in state.comptes" :key="c.account">
          {{ i ? ' · ' : '' }}Compte {{ c.account }} : relevés du {{ dateFr(c.premier) }} au {{ dateFr(c.last) }}
        </template>
      </p>

      <ul v-if="state.finManquante || state.comptes.some((c) => c.manquants.length)" class="constats">
        <li v-if="state.finManquante" class="avertissement">
          Dernier relevé importé : {{ dateFr(state.finManquante) }} ;
          <RouterLink to="/banque/releves">importer les suivants</RouterLink>
        </li>
        <template v-for="c in state.comptes" :key="c.account">
          <li v-for="d in c.manquants" :key="d" class="erreur">
            Compte {{ c.account }} : un relevé manque avant celui du {{ dateFr(d) }} (les soldes ne se suivent pas)
          </li>
        </template>
      </ul>

      <template v-if="state.sansMouvement.length">
        <h3>Paiements qu'aucun relevé ne montre</h3>
        <p class="discret">
          Saisis dans Paiements, sur une période couverte par les relevés, mais rattachés à aucun mouvement : une saisie
          en double, un paiement en espèces ou par l'agence, ou un paiement jamais reçu.
        </p>
        <table class="liste">
          <thead><tr><th>Date</th><th>Locataire</th><th>Mois</th><th class="nombre">Montant</th><th>Note</th></tr></thead>
          <tbody>
            <tr v-for="p in state.sansMouvement" :key="p.id" class="sans-clic">
              <td>{{ dateFr(p.payment_date) }}</td>
              <td>{{ p.tenant }} ({{ p.unit }})</td>
              <td>{{ month(p) }}</td>
              <td class="nombre">{{ euros(total(p)) }}</td>
              <td class="discret">{{ p.note }}</td>
            </tr>
          </tbody>
        </table>
      </template>

      <template v-if="state.incomplets.length">
        <h3>Mouvements à rattacher</h3>
        <p class="discret">
          Paiement de locataire, travaux ou dépôt de garantie dont le détail ne couvre pas le montant : un loyer reçu
          mais pas saisi, une facture de travaux (ou son solde) à saisir, ou un dépôt à enregistrer.
        </p>
        <ul class="constats">
          <li v-for="m in state.incomplets" :key="m.id" class="avertissement">
            <RouterLink :to="{ name: 'bank', query: { bank_transaction: m.id } }">{{ dateFr(m.transaction_date) }} {{ m.label }}</RouterLink>
            : {{ euros(m.amount) }}, rattaché {{ euros(m.covered) }}
          </li>
        </ul>
      </template>

      <template v-if="ecarts.length">
        <h3>Factures payées avec un écart</h3>
        <p class="discret">Le prélèvement dépasse la facture de quelques centimes (solde arrondi par le fournisseur).</p>
        <ul class="constats">
          <li v-for="f in ecarts" :key="f.id">
            <RouterLink :to="{ name: 'invoice', params: { id: f.id } }">{{ f.supplier }} n° {{ f.number }}</RouterLink>
            : {{ euros(f.total_incl_tax) }}, payée {{ euros(f.paid) }} (écart {{ euros(f.remaining.replace('-', '')) }})
          </li>
        </ul>
      </template>

      <p v-if="state.aCategoriser.length">
        <RouterLink to="/banque">{{ state.aCategoriser.length }} mouvement(s) de l'exercice à catégoriser</RouterLink>
      </p>
    </template>
  </section>
</template>

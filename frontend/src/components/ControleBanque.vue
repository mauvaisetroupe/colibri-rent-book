<script setup lang="ts">
import Big from 'big.js'
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

import { api, type FactureResumee, type Mouvement, type Paiement, type ReleveResume } from '../api'
import { etatBanque, facturesAvecEcart, nbProblemesBanque } from '../controleBanque'
import { dateFr, euros } from '../format'

// The « Banque » group of the checks: statements missing, movements to categorise or to complete, payments of the
// exercise that no statement shows (see controleBanque.ts).

const props = defineProps<{ immeuble: number, debut: string, fin: string }>()

const releves = ref<ReleveResume[]>([])
const mouvements = ref<Mouvement[]>([])
const paiements = ref<Paiement[]>([])
const factures = ref<FactureResumee[]>([])
const erreur = ref<string | null>(null)

async function charger() {
  try {
    const annees = [...new Set([Number(props.debut.slice(0, 4)), Number(props.fin.slice(0, 4))])]
    let lus: Paiement[][]
    ;[releves.value, mouvements.value, factures.value, ...lus] = await Promise.all([
      api.releves(), api.mouvements('tous', props.debut, props.fin), api.factures(props.immeuble),
      ...annees.map((a) => api.paiements(props.immeuble, a)),
    ])
    paiements.value = lus.flat()
    erreur.value = null
  } catch (e) {
    erreur.value = (e as Error).message
  }
}
watch(() => [props.immeuble, props.debut, props.fin], charger, { immediate: true })

const etat = computed(() => etatBanque(releves.value, mouvements.value, paiements.value, props.debut, props.fin))
const problemes = computed(() => nbProblemesBanque(etat.value))
// Invoices paid with a gap (ADR 0022: a balance rounded by the supplier, up to 1 euro): shown, not a problem
const ecarts = computed(() => facturesAvecEcart(factures.value, props.debut, props.fin))
const total = (p: Paiement) => new Big(p.loyer).plus(p.provision).plus(p.regularisation).toString()
const mois = (p: Paiement) => (p.mois ? `${p.mois.slice(5, 7)}/${p.mois.slice(0, 4)}` : 'régularisation')
</script>

<template>
  <section class="bloc">
    <h2>Banque</h2>
    <p v-if="erreur" class="message erreur">{{ erreur }}</p>
    <template v-else-if="!releves.length">
      <p class="discret">Aucun relevé importé (<RouterLink to="/banque/releves">Relevés bancaires</RouterLink>).</p>
    </template>
    <template v-else>
      <p class="bilan" :class="problemes ? 'ko' : 'ok'">
        <template v-if="problemes">
          {{ etat.aCategoriser.length }} mouvement(s) à catégoriser · {{ etat.incomplets.length }} à rattacher ·
          {{ etat.sansMouvement.length }} paiement(s) absent(s) des relevés
        </template>
        <template v-else>✓ Relevés complets, chaque mouvement catégorisé, chaque paiement vu sur un relevé</template>
      </p>
      <p class="discret">
        <template v-for="(c, i) in etat.comptes" :key="c.compte">
          {{ i ? ' · ' : '' }}Compte {{ c.compte }} : relevés du {{ dateFr(c.premier) }} au {{ dateFr(c.dernier) }}
        </template>
      </p>

      <ul v-if="etat.finManquante || etat.comptes.some((c) => c.manquants.length)" class="constats">
        <li v-if="etat.finManquante" class="avertissement">
          Dernier relevé importé : {{ dateFr(etat.finManquante) }} ;
          <RouterLink to="/banque/releves">importer les suivants</RouterLink>
        </li>
        <template v-for="c in etat.comptes" :key="c.compte">
          <li v-for="d in c.manquants" :key="d" class="erreur">
            Compte {{ c.compte }} : un relevé manque avant celui du {{ dateFr(d) }} (les soldes ne se suivent pas)
          </li>
        </template>
      </ul>

      <template v-if="etat.sansMouvement.length">
        <h3>Paiements qu'aucun relevé ne montre</h3>
        <p class="discret">
          Saisis dans Paiements, sur une période couverte par les relevés, mais rattachés à aucun mouvement : une saisie
          en double, un paiement en espèces ou par l'agence, ou un paiement jamais reçu.
        </p>
        <table class="liste">
          <thead><tr><th>Date</th><th>Locataire</th><th>Mois</th><th class="nombre">Montant</th><th>Note</th></tr></thead>
          <tbody>
            <tr v-for="p in etat.sansMouvement" :key="p.id" class="sans-clic">
              <td>{{ dateFr(p.date_paiement) }}</td>
              <td>{{ p.locataire }} ({{ p.lot }})</td>
              <td>{{ mois(p) }}</td>
              <td class="nombre">{{ euros(total(p)) }}</td>
              <td class="discret">{{ p.note }}</td>
            </tr>
          </tbody>
        </table>
      </template>

      <template v-if="etat.incomplets.length">
        <h3>Mouvements à rattacher</h3>
        <p class="discret">
          Paiement de locataire, travaux ou dépôt de garantie dont le détail ne couvre pas le montant : un loyer reçu
          mais pas saisi, une facture de travaux (ou son solde) à saisir, ou un dépôt à enregistrer.
        </p>
        <ul class="constats">
          <li v-for="m in etat.incomplets" :key="m.id" class="avertissement">
            <RouterLink :to="{ name: 'banque', query: { mouvement: m.id } }">{{ dateFr(m.date_operation) }} {{ m.libelle }}</RouterLink>
            : {{ euros(m.montant) }}, rattaché {{ euros(m.couvert) }}
          </li>
        </ul>
      </template>

      <template v-if="ecarts.length">
        <h3>Factures payées avec un écart</h3>
        <p class="discret">Le prélèvement dépasse la facture de quelques centimes (solde arrondi par le fournisseur).</p>
        <ul class="constats">
          <li v-for="f in ecarts" :key="f.id">
            <RouterLink :to="{ name: 'facture', params: { id: f.id } }">{{ f.fournisseur }} n° {{ f.numero }}</RouterLink>
            : {{ euros(f.montant_ttc) }}, payée {{ euros(f.paye) }} (écart {{ euros(f.reste.replace('-', '')) }})
          </li>
        </ul>
      </template>

      <p v-if="etat.aCategoriser.length">
        <RouterLink to="/banque">{{ etat.aCategoriser.length }} mouvement(s) de l'exercice à catégoriser</RouterLink>
      </p>
    </template>
  </section>
</template>

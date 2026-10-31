<script setup lang="ts">
import Big from 'big.js'
import { onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

import { api, ENERGIES, NATURES_TRAVAUX, type SyntheseFiscale } from '../api'
import { dateFr, euros } from '../format'
import { useImmeuble } from '../immeuble'

// Tax summary of a calendar year (SPEC § 9, ADR 0008): what can be deducted as recoverable charges not recovered.

const { immeubleId, pret } = useImmeuble()
const year = ref(new Date().getFullYear() - 1)
const summary = ref<SyntheseFiscale | null>(null)
const erreur = ref<string | null>(null)

async function charger() {
  if (immeubleId.value === null) {
    return
  }
  try {
    summary.value = await api.fiscal(immeubleId.value, year.value)
    erreur.value = null
  } catch (e) {
    erreur.value = (e as Error).message
  }
}

onMounted(async () => {
  await pret
  await charger()
})
watch([immeubleId, year], charger)

const current = new Date().getFullYear()
const annees = [current, current - 1, current - 2, current - 3, current - 4]
</script>

<template>
  <section class="entete-page">
    <h1>Synthèse fiscale</h1>
    <label>Année
      <select v-model="year">
        <option v-for="a in annees" :key="a" :value="a">{{ a }}</option>
      </select>
    </label>
  </section>
  <p class="message avertissement-fiscal">
    Méthode reprise de la SPEC (§ 9, BOFiP BOI-RFPI-BASE-20-40), <strong>à faire valider par l'expert-comptable</strong>.
    Les provisions reçues ne sont pas des recettes et les charges payées pour le compte des locataires ne sont pas
    déductibles : seules le sont les charges de la vacance et les charges récupérables restées impayées au
    31 décembre de l'année du départ d'un locataire.
  </p>
  <p v-if="erreur" class="message erreur">{{ erreur }}</p>

  <template v-if="summary">
    <table class="liste synthese">
      <tbody>
        <tr class="sans-clic"><td>Charges de la vacance</td><td class="nombre">{{ euros(summary.total_vacancy) }}</td></tr>
        <tr class="sans-clic"><td>Charges non remboursées par les locataires partis en {{ summary.year }}</td><td class="nombre">{{ euros(summary.total_not_refunded) }}</td></tr>
      </tbody>
      <tfoot>
        <tr><th>Charges récupérables non récupérées (2044, ligne 225)</th><th class="nombre">{{ euros(summary.total_deductible) }}</th></tr>
        <tr><th>Dépôts de garantie conservés pour charges (à ajouter aux recettes)</th><th class="nombre">{{ euros(summary.total_deposits_retained) }}</th></tr>
      </tfoot>
    </table>
    <p class="discret">Pour une SCI : déclaration 2072, puis quote-part de chaque associé.</p>

    <h2>Vacance</h2>
    <p class="discret">Charges des jours où un lot était vide, restées au propriétaire (R4) : la part du propriétaire du décompte de l'année.</p>
    <table class="liste synthese">
      <thead><tr><th>Énergie</th><th class="nombre">Part du propriétaire</th></tr></thead>
      <tbody>
        <tr v-for="v in summary.vacance" :key="v.energy" class="sans-clic">
          <td>{{ ENERGIES[v.energy] }}</td>
          <td class="nombre">{{ euros(v.amount) }}</td>
        </tr>
      </tbody>
    </table>
    <p>
      <RouterLink :to="{ name: 'charge_statement', query: { start: `${summary.year}-01-01`, end: `${summary.year}-12-31` } }">
        Détail dans le décompte {{ summary.year }}
      </RouterLink>
    </p>

    <h2>Locataires partis en {{ summary.year }}</h2>
    <p class="discret">
      Depuis l'entrée du locataire, ou depuis le début de la gestion de l'immeuble s'il est plus tardif : charges − provisions
      − versements de régularisation reçus au 31/12/{{ summary.year }} (la caution retenue n'en est pas un : elle est le
      dépôt conservé, à ajouter aux recettes). Un montant négatif est dû au locataire et ne se déduit pas. Perte nette :
      déductible − dépôt conservé.
    </p>
    <table v-if="summary.departs.length" class="liste">
      <thead>
        <tr>
          <th>Lot</th><th>Locataire</th><th>Séjour</th><th class="nombre">Charges</th><th class="nombre">Provisions</th>
          <th class="nombre">Versements</th><th class="nombre">Non remboursé</th><th class="nombre">Déductible</th>
          <th class="nombre">Dépôt conservé</th><th class="nombre">Perte nette</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="d in summary.departs" :key="d.tenancy_id">
          <tr class="sans-clic">
            <td>{{ d.unit }}</td>
            <td>{{ d.tenant }}</td>
            <td>
              {{ dateFr(d.move_in) }} → {{ dateFr(d.move_out) }}
              <div v-if="d.calculation_start > d.move_in" class="discret">compté depuis le {{ dateFr(d.calculation_start) }} (début de la gestion)</div>
            </td>
            <td class="nombre">{{ euros(d.charges) }}</td>
            <td class="nombre">{{ euros(d.advances) }}</td>
            <td class="nombre">{{ euros(d.versements) }}</td>
            <td class="nombre">{{ euros(d.not_refunded) }}</td>
            <td class="nombre"><strong>{{ euros(d.deductible) }}</strong></td>
            <td class="nombre">{{ euros(d.deposit_retained) }}</td>
            <td class="nombre">{{ euros(new Big(d.deductible).minus(d.deposit_retained).toString()) }}</td>
          </tr>
          <tr v-if="d.incomplet.length" class="sans-clic">
            <td colspan="10" class="avertissement-ligne">
              Données incomplètes : pas de facture validée pour {{ d.incomplet.join(' ; ') }}. Les charges de ce séjour
              sont sous-estimées tant que ces factures ne sont pas importées.
            </td>
          </tr>
        </template>
      </tbody>
    </table>
    <p v-else class="discret">Aucun départ cette année.</p>

    <h2>Travaux payés en {{ summary.year }}</h2>
    <p class="discret">
      Dépenses de réparation, d'entretien et d'amélioration (2044, ligne 224), par date de paiement (écran Travaux) :
      une facture payée en plusieurs fois compte pour chaque règlement de l'année. Construction et agrandissement ne
      sont pas déductibles.
    </p>
    <table v-if="summary.works_invoice.length" class="liste">
      <thead><tr><th>Payé le</th><th>Fournisseur</th><th>Description</th><th>Nature</th><th class="nombre">Montant payé</th></tr></thead>
      <tbody>
        <tr v-for="(t, i) in summary.works_invoice" :key="i" class="sans-clic">
          <td>{{ dateFr(t.payment_date) }}</td>
          <td>{{ t.supplier }}</td>
          <td>{{ t.description }}{{ t.unit ? ` (${t.unit})` : '' }}</td>
          <td :class="t.deductible ? '' : 'discret'">{{ NATURES_TRAVAUX[t.nature] }}{{ t.deductible ? '' : ' (non déductible)' }}</td>
          <td class="nombre">
            {{ euros(t.amount) }}
            <div v-if="t.amount !== t.total_incl_tax" class="discret">sur une facture de {{ euros(t.total_incl_tax) }}</div>
          </td>
        </tr>
      </tbody>
      <tfoot>
        <tr><td colspan="4"><strong>Travaux déductibles (2044, ligne 224)</strong></td><td class="nombre"><strong>{{ euros(summary.total_deductible_works) }}</strong></td></tr>
      </tfoot>
    </table>
    <p v-else class="discret">Aucuns travaux payés cette année.</p>
    <p v-if="summary.unpaid_works.length" class="discret">
      Restant à payer au 31/12/{{ summary.year }} (comptent l'année de leur paiement) :
      {{ summary.unpaid_works.map((t) => `${t.description} ${euros(t.amount)}`).join(' ; ') }}
    </p>

    <h2>Pour information</h2>
    <h3>Lignes à la charge du propriétaire, factures de {{ summary.year }}</h3>
    <p class="discret">Exclues de la répartition (pénalités de retard, taxe foncière hors ordures ménagères, frais propres au bailleur) : traitement à voir avec l'expert-comptable. Les lignes « hors immeuble » (un autre bien) n'y figurent pas.</p>
    <table v-if="summary.non_recoverable.length" class="liste">
      <thead><tr><th>Date</th><th>Facture</th><th>Libellé</th><th class="nombre">Montant</th></tr></thead>
      <tbody>
        <tr v-for="l in summary.non_recoverable" :key="`${l.invoice_id}-${l.label}`" class="sans-clic">
          <td>{{ dateFr(l.invoice_date) }}</td>
          <td><RouterLink :to="{ name: 'invoice', params: { id: l.invoice_id } }">{{ l.supplier }} {{ l.number }}</RouterLink></td>
          <td>{{ l.label }}</td>
          <td class="nombre">{{ euros(l.amount) }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else class="discret">Aucune.</p>

    <h3>Régularisations abandonnées à des locataires encore présents</h3>
    <p class="discret">Une charge offerte à un locataire en place n'est pas déductible avant son départ.</p>
    <ul v-if="summary.pending_write_offs.length">
      <li v-for="a in summary.pending_write_offs" :key="a.charge_adjustment_id">
        {{ a.tenant }} ({{ a.unit }}), exercice du {{ dateFr(a.start) }} au {{ dateFr(a.end) }} : {{ euros(a.remaining) }}
      </li>
    </ul>
    <p v-else class="discret">Aucune.</p>
  </template>
</template>

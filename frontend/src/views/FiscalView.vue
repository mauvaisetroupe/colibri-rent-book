<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

import { api, ENERGIES, NATURES_TRAVAUX, type SyntheseFiscale } from '../api'
import { dateFr, euros } from '../format'
import { useImmeuble } from '../immeuble'

// Tax summary of a calendar year (SPEC § 9, ADR 0008): what can be deducted as recoverable charges not recovered.

const { immeubleId, pret } = useImmeuble()
const annee = ref(new Date().getFullYear() - 1)
const synthese = ref<SyntheseFiscale | null>(null)
const erreur = ref<string | null>(null)

async function charger() {
  if (immeubleId.value === null) {
    return
  }
  try {
    synthese.value = await api.fiscal(immeubleId.value, annee.value)
    erreur.value = null
  } catch (e) {
    erreur.value = (e as Error).message
  }
}

onMounted(async () => {
  await pret
  await charger()
})
watch([immeubleId, annee], charger)

const courante = new Date().getFullYear()
const annees = [courante, courante - 1, courante - 2, courante - 3, courante - 4]
</script>

<template>
  <section class="entete-page">
    <h1>Synthèse fiscale</h1>
    <label>Année
      <select v-model="annee">
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

  <template v-if="synthese">
    <table class="liste synthese">
      <tbody>
        <tr class="sans-clic"><td>Charges de la vacance</td><td class="nombre">{{ euros(synthese.total_vacance) }}</td></tr>
        <tr class="sans-clic"><td>Charges non remboursées par les locataires partis en {{ synthese.annee }}</td><td class="nombre">{{ euros(synthese.total_non_rembourse) }}</td></tr>
      </tbody>
      <tfoot>
        <tr><th>Charges récupérables non récupérées (2044, ligne 225)</th><th class="nombre">{{ euros(synthese.total_deductible) }}</th></tr>
        <tr><th>Dépôts de garantie conservés pour charges (à ajouter aux recettes)</th><th class="nombre">{{ euros(synthese.total_depots_retenus) }}</th></tr>
      </tfoot>
    </table>
    <p class="discret">Pour une SCI : déclaration 2072, puis quote-part de chaque associé.</p>

    <h2>Vacance</h2>
    <p class="discret">Charges des jours où un lot était vide, restées au propriétaire (R4) : la part du propriétaire du décompte de l'année.</p>
    <table class="liste synthese">
      <thead><tr><th>Énergie</th><th class="nombre">Part du propriétaire</th></tr></thead>
      <tbody>
        <tr v-for="v in synthese.vacance" :key="v.energie" class="sans-clic">
          <td>{{ ENERGIES[v.energie] }}</td>
          <td class="nombre">{{ euros(v.montant) }}</td>
        </tr>
      </tbody>
    </table>
    <p>
      <RouterLink :to="{ name: 'decompte', query: { debut: `${synthese.annee}-01-01`, fin: `${synthese.annee}-12-31` } }">
        Détail dans le décompte {{ synthese.annee }}
      </RouterLink>
    </p>

    <h2>Locataires partis en {{ synthese.annee }}</h2>
    <p class="discret">
      Sur toute la durée du séjour : charges − provisions − versements de régularisation reçus au 31/12/{{ synthese.annee }}.
      Un montant négatif est dû au locataire et ne se déduit pas.
    </p>
    <table v-if="synthese.departs.length" class="liste">
      <thead>
        <tr>
          <th>Lot</th><th>Locataire</th><th>Séjour</th><th class="nombre">Charges</th><th class="nombre">Provisions</th>
          <th class="nombre">Versements</th><th class="nombre">Non remboursé</th><th class="nombre">Déductible</th>
          <th class="nombre">Dépôt conservé</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="d in synthese.departs" :key="d.sejour_id">
          <tr class="sans-clic">
            <td>{{ d.lot }}</td>
            <td>{{ d.locataire }}</td>
            <td>{{ dateFr(d.entree) }} → {{ dateFr(d.sortie) }}</td>
            <td class="nombre">{{ euros(d.charges) }}</td>
            <td class="nombre">{{ euros(d.provisions) }}</td>
            <td class="nombre">{{ euros(d.versements) }}</td>
            <td class="nombre">{{ euros(d.non_rembourse) }}</td>
            <td class="nombre"><strong>{{ euros(d.deductible) }}</strong></td>
            <td class="nombre">{{ euros(d.depot_retenu) }}</td>
          </tr>
          <tr v-if="d.incomplet.length" class="sans-clic">
            <td colspan="9" class="avertissement-ligne">
              Données incomplètes : pas de facture validée pour {{ d.incomplet.join(' ; ') }}. Les charges de ce séjour
              sont sous-estimées tant que ces factures ne sont pas importées.
            </td>
          </tr>
        </template>
      </tbody>
    </table>
    <p v-else class="discret">Aucun départ cette année.</p>

    <h2>Travaux payés en {{ synthese.annee }}</h2>
    <p class="discret">
      Dépenses de réparation, d'entretien et d'amélioration (2044, ligne 224), par date de paiement (écran Travaux) :
      une facture payée en plusieurs fois compte pour chaque règlement de l'année. Construction et agrandissement ne
      sont pas déductibles.
    </p>
    <table v-if="synthese.travaux.length" class="liste">
      <thead><tr><th>Payé le</th><th>Fournisseur</th><th>Description</th><th>Nature</th><th class="nombre">Montant payé</th></tr></thead>
      <tbody>
        <tr v-for="(t, i) in synthese.travaux" :key="i" class="sans-clic">
          <td>{{ dateFr(t.date_paiement) }}</td>
          <td>{{ t.fournisseur }}</td>
          <td>{{ t.description }}{{ t.lot ? ` (${t.lot})` : '' }}</td>
          <td :class="t.deductible ? '' : 'discret'">{{ NATURES_TRAVAUX[t.nature] }}{{ t.deductible ? '' : ' (non déductible)' }}</td>
          <td class="nombre">
            {{ euros(t.montant) }}
            <div v-if="t.montant !== t.montant_ttc" class="discret">sur une facture de {{ euros(t.montant_ttc) }}</div>
          </td>
        </tr>
      </tbody>
      <tfoot>
        <tr><td colspan="4"><strong>Travaux déductibles (2044, ligne 224)</strong></td><td class="nombre"><strong>{{ euros(synthese.total_travaux_deductibles) }}</strong></td></tr>
      </tfoot>
    </table>
    <p v-else class="discret">Aucuns travaux payés cette année.</p>
    <p v-if="synthese.travaux_non_payes.length" class="discret">
      Restant à payer au 31/12/{{ synthese.annee }} (comptent l'année de leur paiement) :
      {{ synthese.travaux_non_payes.map((t) => `${t.description} ${euros(t.montant)}`).join(' ; ') }}
    </p>

    <h2>Pour information</h2>
    <h3>Lignes à la charge du propriétaire, factures de {{ synthese.annee }}</h3>
    <p class="discret">Exclues de la répartition (pénalités de retard, taxe foncière hors ordures ménagères, frais propres au bailleur) : traitement à voir avec l'expert-comptable. Les lignes « hors immeuble » (un autre bien) n'y figurent pas.</p>
    <table v-if="synthese.non_recuperables.length" class="liste">
      <thead><tr><th>Date</th><th>Facture</th><th>Libellé</th><th class="nombre">Montant</th></tr></thead>
      <tbody>
        <tr v-for="l in synthese.non_recuperables" :key="`${l.facture_id}-${l.libelle}`" class="sans-clic">
          <td>{{ dateFr(l.date_facture) }}</td>
          <td><RouterLink :to="{ name: 'facture', params: { id: l.facture_id } }">{{ l.fournisseur }} {{ l.numero }}</RouterLink></td>
          <td>{{ l.libelle }}</td>
          <td class="nombre">{{ euros(l.montant) }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else class="discret">Aucune.</p>

    <h3>Régularisations abandonnées à des locataires encore présents</h3>
    <p class="discret">Une charge offerte à un locataire en place n'est pas déductible avant son départ.</p>
    <ul v-if="synthese.abandons_en_cours.length">
      <li v-for="a in synthese.abandons_en_cours" :key="a.regularisation_id">
        {{ a.locataire }} ({{ a.lot }}), exercice du {{ dateFr(a.debut) }} au {{ dateFr(a.fin) }} : {{ euros(a.reste) }}
      </li>
    </ul>
    <p v-else class="discret">Aucune.</p>
  </template>
</template>

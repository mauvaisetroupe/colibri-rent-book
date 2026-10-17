<script setup lang="ts">
import Big from 'big.js'
import { computed, onMounted, ref, watch } from 'vue'

import {
  api, COLONNES_DECOMPTE, ENERGIES, type ColonneDecompte, type Decompte, type DetailFiltre, type Energie,
  type LigneDecompte, type LigneDetail,
} from '../api'
import ChoixExercice from '../components/ChoixExercice.vue'
import { useExercice } from '../exercice'
import { dateFr, euros } from '../format'
import { useImmeuble } from '../immeuble'

// Statement of an exercise (SPEC § 7): one row per stay, summary per energy, click on an amount → the invoice lines
// behind it (function repartition). Amounts come unrounded from the SQL engine: rounding happens here, for display.

const { immeubleId, pret } = useImmeuble()
const { debut, fin } = useExercice()
const decompte = ref<Decompte | null>(null)
const erreur = ref<string | null>(null)
const detail = ref<{ titre: string, lignes: LigneDetail[] } | null>(null)

const exercice = computed(() =>
  (immeubleId.value === null ? null : { immeuble: immeubleId.value, debut: debut.value, fin: fin.value }))

async function charger() {
  if (!exercice.value) {
    return
  }
  try {
    decompte.value = await api.decompte(exercice.value)
    detail.value = null
    erreur.value = null
  } catch (e) {
    erreur.value = (e as Error).message
  }
}

onMounted(async () => {
  await pret
  await charger()
})
watch(exercice, charger)

const colonnes = Object.entries(COLONNES_DECOMPTE) as [ColonneDecompte, string][]

const FILTRES: Record<ColonneDecompte, Pick<DetailFiltre, 'energie' | 'groupe'>> = {
  gaz_consommation: { energie: 'gaz', groupe: 'consommation' },
  gaz_autres: { energie: 'gaz', groupe: 'autres' },
  electricite_consommation: { energie: 'electricite', groupe: 'consommation' },
  electricite_autres: { energie: 'electricite', groupe: 'autres' },
  eau: { energie: 'eau' },
  ordures_menageres: { energie: 'ordures_menageres' },
}

const somme = (cle: keyof LigneDecompte) =>
  (decompte.value?.sejours ?? []).reduce((total, s) => total.plus(String(s[cle])), new Big(0)).toString()

const totaux = computed(() => Object.fromEntries(
  [...colonnes.map(([c]) => c), 'total', 'provisions', 'solde'].map((c) => [c, somme(c as keyof LigneDecompte)]),
))

const sens = (solde: string) => {
  const arrondi = new Big(solde).round(2, Big.roundHalfUp)
  return arrondi.gt(0) ? 'à payer' : arrondi.lt(0) ? 'à rembourser' : ''
}

async function ouvrir(titre: string, filtre: DetailFiltre) {
  if (!exercice.value) {
    return
  }
  try {
    detail.value = { titre, lignes: await api.detail(exercice.value, filtre) }
  } catch (e) {
    erreur.value = (e as Error).message
  }
}

const ouvrirCellule = (s: LigneDecompte, c: ColonneDecompte) =>
  ouvrir(`${s.locataire} (${s.lot}) – ${COLONNES_DECOMPTE[c]}`, { sejour: s.sejour_id, ...FILTRES[c] })

const ouvrirProprietaire = (energie: Energie) =>
  ouvrir(`Part du propriétaire (vacance) – ${ENERGIES[energie]}`, { sejour: 'proprietaire', energie })

const totalDetail = computed(() =>
  (detail.value?.lignes ?? []).reduce((t, l) => t.plus(l.montant), new Big(0)).toString())
</script>

<template>
  <section class="entete-page">
    <h1>Décompte</h1>
    <ChoixExercice />
  </section>
  <p class="actions-page">
    <a v-if="exercice" class="bouton" :href="api.exportUrl(exercice)">Exporter en Excel</a>
    <RouterLink class="bouton" :to="{ name: 'nouvelle-regularisation' }">Préparer les régularisations →</RouterLink>
  </p>

  <p v-if="erreur" class="message erreur">{{ erreur }}</p>

  <template v-if="decompte">
    <ul v-if="decompte.avertissements.length" class="constats">
      <li v-for="(a, i) in decompte.avertissements" :key="i" class="avertissement">{{ a }}</li>
    </ul>

    <div class="defilement">
      <table class="liste decompte">
        <thead>
          <tr>
            <th>Lot</th><th>Locataire</th><th class="nombre">Tant.</th><th>Présence</th><th class="nombre">Jours</th>
            <th v-for="[c, nom] in colonnes" :key="c" class="nombre">{{ nom }}</th>
            <th class="nombre">Total</th><th class="nombre">Provisions</th><th class="nombre">Solde</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in decompte.sejours" :key="s.sejour_id" class="sans-clic">
            <td>{{ s.lot }}</td>
            <td>{{ s.locataire }}</td>
            <td class="nombre">{{ s.tantiemes }}</td>
            <td>{{ s.present_du ? `${dateFr(s.present_du)} → ${dateFr(s.present_au)}` : 'absent' }}</td>
            <td class="nombre">{{ s.jours }}</td>
            <td v-for="[c] in colonnes" :key="c" class="nombre">
              <button type="button" class="lien" @click="ouvrirCellule(s, c)">{{ euros(s[c]) }}</button>
            </td>
            <td class="nombre"><strong>{{ euros(s.total) }}</strong></td>
            <td class="nombre">{{ euros(s.provisions) }}</td>
            <td class="nombre" :class="{ ko: sens(s.solde) === 'à payer', ok: sens(s.solde) === 'à rembourser' }" :title="sens(s.solde)">
              <strong>{{ euros(s.solde) }}</strong>
            </td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <th colspan="5">Total locataires</th>
            <th v-for="[c] in colonnes" :key="c" class="nombre">{{ euros(totaux[c]) }}</th>
            <th class="nombre">{{ euros(totaux.total) }}</th>
            <th class="nombre">{{ euros(totaux.provisions) }}</th>
            <th class="nombre">{{ euros(totaux.solde) }}</th>
          </tr>
        </tfoot>
      </table>
    </div>
    <p class="discret">
      Solde = total des charges − provisions : <span class="ko">positif, à payer par le locataire</span> ;
      <span class="ok">négatif, à lui rembourser</span>. Cliquer un montant pour voir les lignes de facture qui le composent.
    </p>

    <h2>Synthèse par énergie</h2>
    <table class="liste synthese">
      <thead>
        <tr><th>Énergie</th><th class="nombre">Factures de l'exercice</th><th class="nombre">Part des locataires</th><th class="nombre">Part du propriétaire (vacance)</th></tr>
      </thead>
      <tbody>
        <tr v-for="e in decompte.synthese" :key="e.energie" class="sans-clic">
          <td>{{ ENERGIES[e.energie] }}</td>
          <td class="nombre">{{ euros(e.factures) }}</td>
          <td class="nombre">{{ euros(e.locataires) }}</td>
          <td class="nombre"><button type="button" class="lien" @click="ouvrirProprietaire(e.energie)">{{ euros(e.proprietaire) }}</button></td>
        </tr>
      </tbody>
    </table>

    <section v-if="detail" class="detail">
      <h2>{{ detail.titre }} <button type="button" @click="detail = null">Fermer</button></h2>
      <p class="discret">Part = TTC de la ligne × jours retenus ÷ jours de la ligne × tantièmes du lot ÷ total des tantièmes (R3).</p>
      <table class="liste">
        <thead>
          <tr>
            <th>Facture</th><th>Libellé</th><th>Période de la ligne</th><th class="nombre">TTC ligne</th>
            <th class="nombre">Jours retenus</th><th class="nombre">Part</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="l in detail.lignes" :key="`${l.ligne_id}-${l.sejour_id}`" class="sans-clic">
            <td><RouterLink :to="{ name: 'facture', params: { id: l.facture_id } }">{{ l.fournisseur }} {{ l.numero }}</RouterLink></td>
            <td>{{ l.libelle }}</td>
            <td>{{ dateFr(l.debut) }} → {{ dateFr(l.fin) }}</td>
            <td class="nombre">{{ euros(l.montant_ligne) }}</td>
            <td class="nombre">{{ l.jours }} / {{ l.jours_ligne }}</td>
            <td class="nombre">{{ euros(l.montant) }}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr><th colspan="5">Total</th><th class="nombre">{{ euros(totalDetail) }}</th></tr>
        </tfoot>
      </table>
    </section>
  </template>
</template>

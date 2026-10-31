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
const { start, end } = useExercice()
const charge_statement = ref<Decompte | null>(null)
const erreur = ref<string | null>(null)
const detail = ref<{ title: string, lines: LigneDetail[] } | null>(null)

const period = computed(() =>
  (immeubleId.value === null ? null : { building: immeubleId.value, start: start.value, end: end.value }))

async function charger() {
  if (!period.value) {
    return
  }
  try {
    charge_statement.value = await api.charge_statement(period.value)
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
watch(period, charger)

const colonnes = Object.entries(COLONNES_DECOMPTE) as [ColonneDecompte, string][]

const FILTRES: Record<ColonneDecompte, Pick<DetailFiltre, 'energy' | 'group'>> = {
  gas_consumption: { energy: 'gas', group: 'consumption' },
  gas_other: { energy: 'gas', group: 'other' },
  electricity_consumption: { energy: 'electricity', group: 'consumption' },
  electricity_other: { energy: 'electricity', group: 'other' },
  water: { energy: 'water' },
  household_waste: { energy: 'household_waste' },
}

const somme = (cle: keyof LigneDecompte) =>
  (charge_statement.value?.tenancies ?? []).reduce((total, s) => total.plus(String(s[cle])), new Big(0)).toString()

const totaux = computed(() => Object.fromEntries(
  [...colonnes.map(([c]) => c), 'total', 'advances', 'balance'].map((c) => [c, somme(c as keyof LigneDecompte)]),
))

const sens = (balance: string) => {
  const arrondi = new Big(balance).round(2, Big.roundHalfUp)
  return arrondi.gt(0) ? 'à payer' : arrondi.lt(0) ? 'à rembourser' : ''
}

async function ouvrir(title: string, filtre: DetailFiltre) {
  if (!period.value) {
    return
  }
  try {
    detail.value = { title, lines: await api.detail(period.value, filtre) }
  } catch (e) {
    erreur.value = (e as Error).message
  }
}

const ouvrirCellule = (s: LigneDecompte, c: ColonneDecompte) =>
  ouvrir(`${s.tenant} (${s.unit}) – ${COLONNES_DECOMPTE[c]}`, { tenancy: s.tenancy_id, ...FILTRES[c] })

const ouvrirProprietaire = (energy: Energie) =>
  ouvrir(`Part du propriétaire (vacance) – ${ENERGIES[energy]}`, { tenancy: 'owner', energy })

const totalDetail = computed(() =>
  (detail.value?.lines ?? []).reduce((t, l) => t.plus(l.amount), new Big(0)).toString())
</script>

<template>
  <section class="entete-page">
    <h1>Décompte</h1>
    <ChoixExercice />
  </section>
  <p class="actions-page">
    <a v-if="period" class="bouton" :href="api.exportUrl(period)">Exporter en Excel</a>
    <RouterLink class="bouton" :to="{ name: 'nouvelle-regularisation' }">Préparer les régularisations →</RouterLink>
  </p>

  <p v-if="erreur" class="message erreur">{{ erreur }}</p>

  <template v-if="charge_statement">
    <ul v-if="charge_statement.avertissements.length" class="constats">
      <li v-for="(a, i) in charge_statement.avertissements" :key="i" class="avertissement">{{ a }}</li>
    </ul>

    <div class="defilement">
      <table class="liste decompte">
        <thead>
          <tr>
            <th>Lot</th><th>Locataire</th><th class="nombre">Tant.</th><th>Présence</th><th class="nombre">Jours</th>
            <th v-for="[c, name] in colonnes" :key="c" class="nombre">{{ name }}</th>
            <th class="nombre">Total</th><th class="nombre">Provisions</th><th class="nombre">Solde</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in charge_statement.tenancies" :key="s.tenancy_id" class="sans-clic">
            <td>{{ s.unit }}</td>
            <td>{{ s.tenant }}</td>
            <td class="nombre">{{ s.charge_shares }}</td>
            <td>{{ s.present_from ? `${dateFr(s.present_from)} → ${dateFr(s.present_to)}` : 'absent' }}</td>
            <td class="nombre">{{ s.days }}</td>
            <td v-for="[c] in colonnes" :key="c" class="nombre">
              <button type="button" class="lien" @click="ouvrirCellule(s, c)">{{ euros(s[c]) }}</button>
            </td>
            <td class="nombre"><strong>{{ euros(s.total) }}</strong></td>
            <td class="nombre">{{ euros(s.advances) }}</td>
            <td class="nombre" :class="{ ko: sens(s.balance) === 'à payer', ok: sens(s.balance) === 'à rembourser' }" :title="sens(s.balance)">
              <strong>{{ euros(s.balance) }}</strong>
            </td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <th colspan="5">Total locataires</th>
            <th v-for="[c] in colonnes" :key="c" class="nombre">{{ euros(totaux[c]) }}</th>
            <th class="nombre">{{ euros(totaux.total) }}</th>
            <th class="nombre">{{ euros(totaux.advances) }}</th>
            <th class="nombre">{{ euros(totaux.balance) }}</th>
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
        <tr v-for="e in charge_statement.summary" :key="e.energy" class="sans-clic">
          <td>{{ ENERGIES[e.energy] }}</td>
          <td class="nombre">{{ euros(e.invoices) }}</td>
          <td class="nombre">{{ euros(e.tenants) }}</td>
          <td class="nombre"><button type="button" class="lien" @click="ouvrirProprietaire(e.energy)">{{ euros(e.owner) }}</button></td>
        </tr>
      </tbody>
    </table>

    <section v-if="detail" class="detail">
      <h2>{{ detail.title }} <button type="button" @click="detail = null">Fermer</button></h2>
      <p class="discret">Part = TTC de la ligne × jours retenus ÷ jours de la ligne × tantièmes du lot ÷ total des tantièmes (R3).</p>
      <table class="liste">
        <thead>
          <tr>
            <th>Facture</th><th>Libellé</th><th>Période de la ligne</th><th class="nombre">TTC ligne</th>
            <th class="nombre">Jours retenus</th><th class="nombre">Part</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="l in detail.lines" :key="`${l.invoice_line_id}-${l.tenancy_id}`" class="sans-clic">
            <td><RouterLink :to="{ name: 'invoice', params: { id: l.invoice_id } }">{{ l.supplier }} {{ l.number }}</RouterLink></td>
            <td>{{ l.label }}</td>
            <td>{{ dateFr(l.start) }} → {{ dateFr(l.end) }}</td>
            <td class="nombre">{{ euros(l.line_amount) }}</td>
            <td class="nombre">{{ l.days }} / {{ l.line_days }}</td>
            <td class="nombre">{{ euros(l.amount) }}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr><th colspan="5">Total</th><th class="nombre">{{ euros(totalDetail) }}</th></tr>
        </tfoot>
      </table>
    </section>
  </template>
</template>

<script setup lang="ts">
import Big from 'big.js'
import { computed, onMounted, ref, watch } from 'vue'

import { api, NATURES_TRAVAUX, type Lot, type NatureTravaux, type Travaux } from '../api'
import { dateFr, euros, nombreApi, nombreFr } from '../format'
import { useImmeuble } from '../immeuble'

// Works paid by the owner (ADR 0015): for the tax return only, never allocated to the tenants. Deductible (2044,
// line 224) according to their nature, in the tax year of their payment.

type Saisie = {
  id: number | null
  lot_id: number | null
  fournisseur: string
  description: string
  nature: NatureTravaux
  date_facture: string
  date_paiement: string
  montant_ttc: string
  note: string
}

const { immeubleId: immeuble, pret } = useImmeuble()
const travaux = ref<Travaux[]>([])
const lots = ref<Lot[]>([])
const annee = ref<string>('')
const nature = ref<NatureTravaux | ''>('')
const saisie = ref<Saisie | null>(null)
const message = ref<{ texte: string, type: 'info' | 'erreur' } | null>(null)

onMounted(async () => {
  await pret
  await charger()
})
watch(immeuble, charger)

async function charger() {
  if (immeuble.value === null) {
    return
  }
  try {
    ;[travaux.value, lots.value] = await Promise.all([
      api.travaux(immeuble.value), api.immeuble(immeuble.value).then((i) => i.lots),
    ])
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}

// The year of a works invoice is that of its payment, else of the invoice (to pay)
const anneeDe = (t: Travaux) => (t.date_paiement ?? t.date_facture).slice(0, 4)
const annees = computed(() => [...new Set(travaux.value.map(anneeDe))].sort().reverse())
const affiches = computed(() => travaux.value.filter((t) =>
  (!annee.value || anneeDe(t) === annee.value) && (!nature.value || t.nature === nature.value)))
const total = (liste: Travaux[]) => liste.reduce((s, t) => s.plus(t.montant_ttc), new Big(0)).toString()
const deductibles = computed(() => total(affiches.value.filter((t) => t.date_paiement && t.deductible)))

function nouveau() {
  saisie.value = {
    id: null, lot_id: null, fournisseur: '', description: '', nature: 'entretien',
    date_facture: '', date_paiement: '', montant_ttc: '', note: '',
  }
  message.value = null
}

function modifier(t: Travaux) {
  saisie.value = {
    id: t.id, lot_id: t.lot_id, fournisseur: t.fournisseur, description: t.description, nature: t.nature,
    date_facture: t.date_facture, date_paiement: t.date_paiement ?? '', montant_ttc: nombreFr(t.montant_ttc),
    note: t.note ?? '',
  }
  message.value = null
}

async function enregistrer() {
  if (!saisie.value || immeuble.value === null) {
    return
  }
  const { id, ...s } = saisie.value
  const donnees = {
    ...s, immeuble_id: immeuble.value, date_paiement: s.date_paiement || null,
    montant_ttc: nombreApi(s.montant_ttc) ?? s.montant_ttc, note: s.note.trim() || null,
  }
  try {
    const t = id === null ? await api.creerTravaux(donnees) : await api.modifierTravaux(id, donnees)
    message.value = { texte: `${t.description} : enregistré`, type: 'info' }
    saisie.value = null
    await charger()
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}

async function supprimer(t: Travaux) {
  if (!confirm(`Supprimer « ${t.description} » (${euros(t.montant_ttc)}) ?`)) {
    return
  }
  await api.supprimerTravaux(t.id)
  saisie.value = null
  await charger()
}

async function joindre(t: Travaux, event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) {
    return
  }
  try {
    await api.joindrePdfTravaux(t.id, file)
    message.value = { texte: `PDF joint à « ${t.description} »`, type: 'info' }
    await charger()
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}
</script>

<template>
  <section class="entete-page">
    <h1>Travaux</h1>
  </section>
  <p class="discret">
    Les factures de travaux payées par le propriétaire, pour la déclaration des revenus fonciers : jamais réparties entre
    les locataires. Entretien, réparation et amélioration sont déductibles (2044, ligne 224) ; construction et
    agrandissement non. L'année retenue est celle du paiement.
  </p>

  <p v-if="message" class="message" :class="message.type">{{ message.texte }}</p>

  <div class="actions-page">
    <button type="button" @click="nouveau">+ Ajouter des travaux</button>
  </div>

  <form v-if="saisie" class="formulaire" @submit.prevent="enregistrer">
    <strong>{{ saisie.id ? 'Modifier les travaux' : 'Nouveaux travaux' }}</strong>
    <label>Fournisseur <input v-model="saisie.fournisseur" required size="18"></label>
    <label>Description <input v-model="saisie.description" required size="28"></label>
    <label>Nature
      <select v-model="saisie.nature">
        <option v-for="(nom, code) in NATURES_TRAVAUX" :key="code" :value="code">{{ nom }}</option>
      </select>
    </label>
    <label>Logement
      <select v-model="saisie.lot_id">
        <option :value="null">Immeuble, parties communes</option>
        <option v-for="l in lots" :key="l.id" :value="l.id">{{ l.code }}{{ l.designation ? ` – ${l.designation}` : '' }}</option>
      </select>
    </label>
    <label>Date de la facture <input v-model="saisie.date_facture" type="date" required></label>
    <label>Payée le <input v-model="saisie.date_paiement" type="date"></label>
    <label>Montant TTC <input v-model="saisie.montant_ttc" class="nombre" size="9" required></label>
    <label class="note">Note <input v-model="saisie.note" size="30"></label>
    <button type="submit" class="principal">Enregistrer</button>
    <button type="button" @click="saisie = null">Annuler</button>
  </form>

  <section class="filtres">
    <select v-model="annee" aria-label="Année">
      <option value="">Toutes les années</option>
      <option v-for="a in annees" :key="a" :value="a">{{ a }}</option>
    </select>
    <select v-model="nature" aria-label="Nature">
      <option value="">Toutes les natures</option>
      <option v-for="(nom, code) in NATURES_TRAVAUX" :key="code" :value="code">{{ nom }}</option>
    </select>
    <span class="discret">
      {{ affiches.length }} facture(s), {{ euros(total(affiches)) }} ; payées et déductibles : <strong>{{ euros(deductibles) }}</strong>
    </span>
  </section>

  <table v-if="affiches.length" class="liste">
    <thead>
      <tr>
        <th>Payée le</th><th>Facture du</th><th>Fournisseur</th><th>Description</th><th>Logement</th><th>Nature</th>
        <th class="nombre">Montant TTC</th><th>PDF</th><th />
      </tr>
    </thead>
    <tbody>
      <tr v-for="t in affiches" :key="t.id" @click="modifier(t)">
        <td>{{ t.date_paiement ? dateFr(t.date_paiement) : 'à payer' }}</td>
        <td>{{ dateFr(t.date_facture) }}</td>
        <td>{{ t.fournisseur }}</td>
        <td>{{ t.description }}</td>
        <td>{{ t.lot ?? '' }}</td>
        <td :class="t.deductible ? '' : 'discret'">{{ NATURES_TRAVAUX[t.nature] }}{{ t.deductible ? '' : ' (non déductible)' }}</td>
        <td class="nombre">{{ euros(t.montant_ttc) }}</td>
        <td @click.stop>
          <a v-if="t.pdf" :href="api.travauxPdfUrl(t.id)" target="_blank">ouvrir</a>
          <label class="lien">{{ t.pdf ? 'remplacer' : 'joindre' }}
            <input type="file" accept="application/pdf" hidden @change="joindre(t, $event)">
          </label>
        </td>
        <td @click.stop><button type="button" class="danger" @click="supprimer(t)">Supprimer</button></td>
      </tr>
    </tbody>
  </table>
  <p v-else class="discret">Aucune facture de travaux.</p>
</template>

<style scoped>
.liste tbody tr {
  cursor: pointer;
}

.lien {
  color: var(--accent);
  cursor: pointer;
  margin-left: 0.4rem;
}
</style>

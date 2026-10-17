<script setup lang="ts">
import Big from 'big.js'
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'

import { aEncaisser, api, libelleRegularisation, type Decompte, type Regularisation } from '../api'
import { dateFr, euros } from '../format'
import { useImmeuble } from '../immeuble'
import { comparer, decomptesDesPeriodes, SEUIL_RECTIFICATION } from '../rectification'

// All the regularisations of the building, whatever their period (a year, 2024-2025, a stay that ended…): one row
// each, a corrective one in place of the one it replaces (the replaced one stays in the history of its record), and
// whether it still matches the statement of its period recomputed today (« à rectifier »).

const router = useRouter()
const { immeubleId, pret } = useImmeuble()
const regularisations = ref<Regularisation[]>([])
const erreur = ref<string | null>(null)

const decomptes = ref(new Map<string, Decompte>())
const filtreStatut = ref<'en_cours' | 'soldees' | 'a_rectifier' | 'toutes'>('toutes')
const filtreSejour = ref<number | ''>('')
// 'debut/fin' of the regularisations (inclusive ISO dates), '' for all
const filtrePeriode = ref('')

async function charger() {
  if (immeubleId.value === null) {
    return
  }
  try {
    regularisations.value = await api.regularisations(immeubleId.value)
    erreur.value = null
    decomptes.value = await decomptesDesPeriodes(immeubleId.value, actuelles.value)
  } catch (e) {
    erreur.value = (e as Error).message
  }
}

onMounted(async () => {
  await pret
  await charger()
})
watch(immeubleId, charger)

// In progress: drafts, and sent ones still waiting for a payment (no decision of the owner)
const enCours = (r: Regularisation) => r.etat === 'brouillon' || aEncaisser(r)

const actuelles = computed(() => regularisations.value.filter((r) => !r.remplacee_par))

const comparaisons = computed(() => new Map(actuelles.value.map((r) => [r.id, comparer(r, decomptes.value)])))
const aCorriger = (r: Regularisation) => ['a_rectifier', 'a_recreer'].includes(comparaisons.value.get(r.id)?.etat ?? '')

const affichees = computed(() =>
  actuelles.value
    .filter((r) => filtreStatut.value === 'toutes'
      || (filtreStatut.value === 'a_rectifier' ? aCorriger(r)
        : (filtreStatut.value === 'en_cours') === enCours(r)))
    .filter((r) => filtreSejour.value === '' || r.sejour_id === filtreSejour.value)
    .filter((r) => filtrePeriode.value === '' || `${r.debut}/${r.fin}` === filtrePeriode.value)
    .sort((a, b) => b.fin.localeCompare(a.fin) || b.debut.localeCompare(a.debut) || a.lot.localeCompare(b.lot)),
)

// Periods of the existing regularisations (one per exercise regularised), latest first, for the filter
const periodes = computed(() =>
  [...new Set(actuelles.value.map((r) => `${r.debut}/${r.fin}`))]
    .sort((a, b) => b.slice(11).localeCompare(a.slice(11)) || b.localeCompare(a))
    .map((cle) => ({ cle, libelle: `${dateFr(cle.slice(0, 10))} → ${dateFr(cle.slice(11))}` })))

// Tenants who have a regularisation, for the filter
const locataires = computed(() => {
  const vus = new Map<number, string>()
  for (const r of actuelles.value) {
    vus.set(r.sejour_id, `${r.lot} – ${r.locataire}`)
  }
  return [...vus].sort((a, b) => a[1].localeCompare(b[1]))
})

const pastille = (r: Regularisation) => (r.etat === 'brouillon' ? 'a_verifier' : r.decision ? 'decision' : r.etat)

const reste = (r: Regularisation) => new Big(r.solde).minus(r.montant_recu).toString()
</script>

<template>
  <section class="entete-page">
    <h1>Régularisations</h1>
    <RouterLink class="bouton principal" :to="{ name: 'nouvelle-regularisation' }">+ Nouvelle régularisation</RouterLink>
  </section>
  <p class="discret">
    Une régularisation porte sur la période choisie à sa création (une année, deux années, un séjour…). Cliquer une ligne
    pour l'ouvrir : état, versements reçus, mail, justificatif, rectificatif. Les versements se saisissent dans
    <RouterLink to="/paiements">Paiements</RouterLink>.
  </p>
  <p v-if="erreur" class="message erreur">{{ erreur }}</p>

  <section class="filtres">
    <select v-model="filtrePeriode" aria-label="Période">
      <option value="">Toutes les périodes</option>
      <option v-for="p in periodes" :key="p.cle" :value="p.cle">{{ p.libelle }}</option>
    </select>
    <select v-model="filtreStatut" aria-label="Statut">
      <option value="toutes">Tous les états</option>
      <option value="en_cours">En cours (brouillons, en attente de paiement)</option>
      <option value="soldees">Closes (soldées, abandonnées, irrécouvrables)</option>
      <option value="a_rectifier">À rectifier (le décompte a changé)</option>
    </select>
    <select v-model="filtreSejour" aria-label="Locataire">
      <option value="">Tous les locataires</option>
      <option v-for="[id, nom] in locataires" :key="id" :value="id">{{ nom }}</option>
    </select>
    <span class="discret">{{ affichees.length }} régularisation(s)</span>
  </section>

  <table v-if="affichees.length" class="liste">
    <thead>
      <tr>
        <th>Période</th><th>Lot</th><th>Locataire</th><th class="nombre">Solde</th><th class="nombre">Reçu</th>
        <th class="nombre">Reste</th><th>Statut</th><th>Écart avec le décompte</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="r in affichees" :key="r.id" @click="router.push({ name: 'regularisation', params: { id: r.id } })">
        <td>{{ dateFr(r.debut) }} → {{ dateFr(r.fin) }}</td>
        <td>{{ r.lot }}</td>
        <td>
          {{ r.locataire }}
          <span v-if="r.remplace_id" class="discret"> · rectificatif</span>
        </td>
        <td class="nombre"><strong>{{ euros(r.solde) }}</strong></td>
        <td class="nombre">{{ r.etat === 'brouillon' ? '' : euros(r.montant_recu) }}</td>
        <td class="nombre">
          <strong v-if="r.etat !== 'brouillon'" :class="{ ok: r.etat === 'soldee' }">{{ euros(reste(r)) }}</strong>
        </td>
        <td>
          <span class="pastille" :class="pastille(r)">{{ libelleRegularisation(r) }}</span>
          <span v-if="r.date_envoi" class="discret"> envoyée le {{ dateFr(r.date_envoi) }}</span>
        </td>
        <td>
          <template v-if="comparaisons.get(r.id)">
            <span v-if="comparaisons.get(r.id)!.etat === 'juste'" class="ok" title="Le décompte actuel donne le même solde">✓</span>
            <span
              v-else-if="comparaisons.get(r.id)!.etat === 'arrondi'"
              class="discret"
              title="Écart faible, sans rectificatif"
            >{{ euros(comparaisons.get(r.id)!.ecart) }}</span>
            <span v-else class="a-rectifier" :title="`Décompte actuel : ${euros(comparaisons.get(r.id)!.actuel.solde)}`">
              {{ comparaisons.get(r.id)!.etat === 'a_recreer' ? 'À recréer' : 'À rectifier' }}
              {{ euros(comparaisons.get(r.id)!.ecart) }}
            </span>
          </template>
        </td>
      </tr>
    </tbody>
  </table>
  <p v-if="affichees.length" class="discret">
    Solde = charges − provisions de la période, figé à la création : <span class="ko">positif, à payer par le
    locataire</span> ; <span class="ok">négatif, à lui rembourser</span>. Reste = solde − versements reçus (saisis dans
    Paiements). Écart avec le décompte = solde du décompte refait aujourd'hui − solde figé :
    <strong>négatif, trop demandé</strong> ; <strong>positif, pas assez demandé</strong> ; « À rectifier » à partir de
    {{ euros(SEUIL_RECTIFICATION.toString()) }}. Cliquer une ligne pour ouvrir la régularisation.
  </p>
  <p v-else class="discret">
    Aucune régularisation {{ { en_cours: 'en cours', soldees: 'close', a_rectifier: 'à rectifier', toutes: '' }[filtreStatut] }}.
  </p>
</template>

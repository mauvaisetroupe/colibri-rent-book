<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

import { api, type Decompte, type Regularisation } from '../api'
import ChoixExercice from '../components/ChoixExercice.vue'
import { useExercice } from '../exercice'
import { dateFr, euros, nombreApi } from '../format'
import { useImmeuble } from '../immeuble'

// New regularisations over a period chosen freely (ADR 0007): the statement of each stay, then « Créer » freezes its
// amounts. A regularisation already sent outside the application is entered by hand, to prepare its corrective one.

const { immeubleId, pret } = useImmeuble()
const { debut, fin } = useExercice()
const decompte = ref<Decompte | null>(null)
const regularisations = ref<Regularisation[]>([])
const message = ref<{ texte: string, type: 'info' | 'erreur' } | null>(null)
const occupe = ref(false)
const saisie = ref<null | { sejour_id: number | null, solde: string, provisions: string, date_envoi: string, montant_recu: string, note: string }>(null)

const exercice = computed(() =>
  (immeubleId.value === null ? null : { immeuble: immeubleId.value, debut: debut.value, fin: fin.value }))

async function charger() {
  if (!exercice.value) {
    return
  }
  try {
    ;[decompte.value, regularisations.value] = await Promise.all([
      api.decompte(exercice.value), api.regularisations(exercice.value.immeuble),
    ])
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}

onMounted(async () => {
  await pret
  await charger()
})
watch(exercice, charger)

// Current regularisation of the stay over exactly this period, if any
const existante = (sejourId: number) => regularisations.value.find((r) =>
  r.sejour_id === sejourId && r.debut === debut.value && r.fin === fin.value && !r.remplacee_par)

const sejours = computed(() => (decompte.value?.sejours ?? []).filter((s) => s.jours > 0))
const aCreer = computed(() => sejours.value.filter((s) => !existante(s.sejour_id)))

async function action(f: () => Promise<unknown>, succes: string) {
  occupe.value = true
  try {
    await f()
    message.value = { texte: succes, type: 'info' }
    await charger()
    return true
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
    return false
  } finally {
    occupe.value = false
  }
}

const creer = (sejour: number, locataire: string) =>
  action(() => api.creerRegularisation(sejour, debut.value, fin.value), `Régularisation de ${locataire} créée (montants figés)`)

const creerTout = () => action(async () => {
  for (const s of aCreer.value) {
    await api.creerRegularisation(s.sejour_id, debut.value, fin.value)
  }
}, 'Régularisations créées (montants figés)')

function nouvelleSaisie() {
  saisie.value = { sejour_id: null, solde: '', provisions: '', date_envoi: '', montant_recu: '', note: '' }
}

async function enregistrerSaisie() {
  const s = saisie.value!
  const ok = await action(() => api.saisirRegularisation({
    sejour_id: s.sejour_id!, debut: debut.value, fin: fin.value,
    solde: nombreApi(s.solde) ?? '', provisions: nombreApi(s.provisions), date_envoi: s.date_envoi,
    montant_recu: nombreApi(s.montant_recu), note: s.note || null,
  }), 'Régularisation déjà envoyée enregistrée')
  if (ok) {
    saisie.value = null
  }
}
</script>

<template>
  <p><RouterLink :to="{ name: 'regularisations' }">← Régularisations</RouterLink></p>
  <section class="entete-page">
    <h1>Nouvelle régularisation</h1>
    <ChoixExercice />
  </section>
  <p class="discret">
    Choisir la période à régulariser, vérifier le décompte de chaque locataire (et les avertissements), puis
    « Créer » : les montants sont figés, le justificatif et les mails ne changeront plus.
  </p>
  <p v-if="message" class="message" :class="message.type">{{ message.texte }}</p>

  <template v-if="exercice && decompte">
    <ul v-if="decompte.avertissements.length" class="constats">
      <li v-for="(a, i) in decompte.avertissements" :key="i" class="avertissement">{{ a }}</li>
    </ul>

    <table v-if="sejours.length" class="liste">
      <thead>
        <tr>
          <th>Lot</th><th>Locataire</th><th>Présence</th><th class="nombre">Charges</th><th class="nombre">Provisions</th>
          <th class="nombre">Solde</th><th />
        </tr>
      </thead>
      <tbody>
        <tr v-for="s in sejours" :key="s.sejour_id" class="sans-clic">
          <td>{{ s.lot }}</td>
          <td>{{ s.locataire }}</td>
          <td>{{ dateFr(s.present_du) }} → {{ dateFr(s.present_au) }}</td>
          <td class="nombre">{{ euros(s.total) }}</td>
          <td class="nombre">{{ euros(s.provisions) }}</td>
          <td class="nombre"><strong>{{ euros(s.solde) }}</strong></td>
          <td class="boutons">
            <template v-if="existante(s.sejour_id)">
              <RouterLink :to="{ name: 'regularisation', params: { id: existante(s.sejour_id)!.id } }">
                déjà créée : ouvrir
              </RouterLink>
            </template>
            <template v-else>
              <a class="bouton" :href="api.apercuUrl(exercice, s.sejour_id)" target="_blank">Aperçu PDF</a>
              <button type="button" :disabled="occupe" @click="creer(s.sejour_id, s.locataire)">Créer</button>
            </template>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else class="discret">Aucun locataire présent sur cette période.</p>
    <p v-if="aCreer.length > 1">
      <button type="button" class="principal" :disabled="occupe" @click="creerTout">Créer les {{ aCreer.length }} régularisations</button>
    </p>

    <h2>Régularisation déjà envoyée</h2>
    <form v-if="saisie" class="formulaire" @submit.prevent="enregistrerSaisie">
      <strong>Envoyée hors de l'application, pour la période du {{ dateFr(debut) }} au {{ dateFr(fin) }}</strong>
      <label>Séjour
        <select v-model="saisie.sejour_id" required>
          <option v-for="s in decompte.sejours" :key="s.sejour_id" :value="s.sejour_id">{{ s.lot }} – {{ s.locataire }}</option>
        </select>
      </label>
      <label>Montant demandé <input v-model="saisie.solde" class="nombre" size="9" required></label>
      <label>Provisions déduites <input v-model="saisie.provisions" class="nombre" size="9"></label>
      <label>Envoyée le <input v-model="saisie.date_envoi" type="date" required></label>
      <label>Déjà reçu <input v-model="saisie.montant_recu" class="nombre" size="9"></label>
      <label>Note <input v-model="saisie.note" size="26"></label>
      <button type="submit" class="principal" :disabled="occupe">Enregistrer</button>
      <button type="button" @click="saisie = null">Annuler</button>
    </form>
    <p v-else>
      <button type="button" @click="nouvelleSaisie">+ Saisir une régularisation déjà envoyée</button>
      <span class="discret"> (par mail, avant Colibri) : pour en garder la trace et préparer son rectificatif</span>
    </p>
  </template>
</template>

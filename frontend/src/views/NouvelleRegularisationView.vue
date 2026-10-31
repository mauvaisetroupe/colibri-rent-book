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
const { start, end } = useExercice()
const charge_statement = ref<Decompte | null>(null)
const charge_adjustments = ref<Regularisation[]>([])
const message = ref<{ text: string, type: 'info' | 'erreur' } | null>(null)
const occupe = ref(false)
const saisie = ref<null | { tenancy_id: number | null, balance: string, advances: string, sent_on: string, amount_received: string, note: string }>(null)

const period = computed(() =>
  (immeubleId.value === null ? null : { building: immeubleId.value, start: start.value, end: end.value }))

async function charger() {
  if (!period.value) {
    return
  }
  try {
    ;[charge_statement.value, charge_adjustments.value] = await Promise.all([
      api.charge_statement(period.value), api.charge_adjustments(period.value.building),
    ])
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
  }
}

onMounted(async () => {
  await pret
  await charger()
})
watch(period, charger)

// Current regularisation of the stay over exactly this period, if any
const existante = (sejourId: number) => charge_adjustments.value.find((r) =>
  r.tenancy_id === sejourId && r.start === start.value && r.end === end.value && !r.replaced_by)

const tenancies = computed(() => (charge_statement.value?.tenancies ?? []).filter((s) => s.days > 0))
const aCreer = computed(() => tenancies.value.filter((s) => !existante(s.tenancy_id)))

async function action(f: () => Promise<unknown>, succes: string) {
  occupe.value = true
  try {
    await f()
    message.value = { text: succes, type: 'info' }
    await charger()
    return true
  } catch (e) {
    message.value = { text: (e as Error).message, type: 'erreur' }
    return false
  } finally {
    occupe.value = false
  }
}

const creer = (tenancy: number, tenant: string) =>
  action(() => api.creerRegularisation(tenancy, start.value, end.value), `Régularisation de ${tenant} créée (montants figés)`)

const creerTout = () => action(async () => {
  for (const s of aCreer.value) {
    await api.creerRegularisation(s.tenancy_id, start.value, end.value)
  }
}, 'Régularisations créées (montants figés)')

function nouvelleSaisie() {
  saisie.value = { tenancy_id: null, balance: '', advances: '', sent_on: '', amount_received: '', note: '' }
}

async function enregistrerSaisie() {
  const s = saisie.value!
  const ok = await action(() => api.saisirRegularisation({
    tenancy_id: s.tenancy_id!, start: start.value, end: end.value,
    balance: nombreApi(s.balance) ?? '', advances: nombreApi(s.advances), sent_on: s.sent_on,
    amount_received: nombreApi(s.amount_received), note: s.note || null,
  }), 'Régularisation déjà envoyée enregistrée')
  if (ok) {
    saisie.value = null
  }
}
</script>

<template>
  <p><RouterLink :to="{ name: 'charge_adjustments' }">← Régularisations</RouterLink></p>
  <section class="entete-page">
    <h1>Nouvelle régularisation</h1>
    <ChoixExercice />
  </section>
  <p class="discret">
    Choisir la période à régulariser, vérifier le décompte de chaque locataire (et les avertissements), puis
    « Créer » : les montants sont figés, le justificatif et les mails ne changeront plus.
  </p>
  <p v-if="message" class="message" :class="message.type">{{ message.text }}</p>

  <template v-if="period && charge_statement">
    <ul v-if="charge_statement.avertissements.length" class="constats">
      <li v-for="(a, i) in charge_statement.avertissements" :key="i" class="avertissement">{{ a }}</li>
    </ul>

    <table v-if="tenancies.length" class="liste">
      <thead>
        <tr>
          <th>Lot</th><th>Locataire</th><th>Présence</th><th class="nombre">Charges</th><th class="nombre">Provisions</th>
          <th class="nombre">Solde</th><th />
        </tr>
      </thead>
      <tbody>
        <tr v-for="s in tenancies" :key="s.tenancy_id" class="sans-clic">
          <td>{{ s.unit }}</td>
          <td>{{ s.tenant }}</td>
          <td>{{ dateFr(s.present_from) }} → {{ dateFr(s.present_to) }}</td>
          <td class="nombre">{{ euros(s.total) }}</td>
          <td class="nombre">{{ euros(s.advances) }}</td>
          <td class="nombre"><strong>{{ euros(s.balance) }}</strong></td>
          <td class="boutons">
            <template v-if="existante(s.tenancy_id)">
              <RouterLink :to="{ name: 'charge_adjustment', params: { id: existante(s.tenancy_id)!.id } }">
                déjà créée : ouvrir
              </RouterLink>
            </template>
            <template v-else>
              <a class="bouton" :href="api.apercuUrl(period, s.tenancy_id)" target="_blank">Aperçu PDF</a>
              <button type="button" :disabled="occupe" @click="creer(s.tenancy_id, s.tenant)">Créer</button>
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
      <strong>Envoyée hors de l'application, pour la période du {{ dateFr(start) }} au {{ dateFr(end) }}</strong>
      <label>Séjour
        <select v-model="saisie.tenancy_id" required>
          <option v-for="s in charge_statement.tenancies" :key="s.tenancy_id" :value="s.tenancy_id">{{ s.unit }} – {{ s.tenant }}</option>
        </select>
      </label>
      <label>Montant demandé <input v-model="saisie.balance" class="nombre" size="9" required></label>
      <label>Provisions déduites <input v-model="saisie.advances" class="nombre" size="9"></label>
      <label>Envoyée le <input v-model="saisie.sent_on" type="date" required></label>
      <label>Déjà reçu <input v-model="saisie.amount_received" class="nombre" size="9"></label>
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

<script setup lang="ts">
import Big from 'big.js'
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

import {
  api, MODES_PAIEMENT, type Echeance, type Paiement, type PaiementSaisi, type Regularisation, type Sejour,
} from '../api'
import FormulairePaiement, { type Brouillon } from '../components/FormulairePaiement.vue'
import { dateFr, euros, exerciceCourt, nombreApi, nombreFr } from '../format'
import { useImmeuble } from '../immeuble'

// Payments received (ADR 0008), one row per payment (a bank transfer, a cheque), entered in a modal form: amount
// received split into rent, provision and regularisation. The provisions of a year are the sum of its
// monthly payments; a regularisation is settled when its payments reach its balance (computed, ADR 0010).

const { immeubleId, pret } = useImmeuble()
const message = ref<{ texte: string, type: 'info' | 'erreur' } | null>(null)
const occupe = ref(false)
const aujourdhui = new Date().toISOString().slice(0, 10)

// null: every year (the year of a payment is that of the month it pays)
const annee = ref<number | null>(new Date().getFullYear())
const paiements = ref<Paiement[]>([])
const sejours = ref<Sejour[]>([])
const regularisations = ref<Regularisation[]>([])
const echeances = ref<Echeance[]>([])

const filtreSejour = ref<number | ''>('')
const filtreType = ref<'' | 'loyers' | 'regularisations'>('')
// Seen on a bank statement or not (ADR 0018)
const filtreBanque = ref<'' | 'rapproches' | 'non_rapproches'>('')

async function charger() {
  if (immeubleId.value === null) {
    return
  }
  try {
    ;[paiements.value, sejours.value, regularisations.value, echeances.value] = await Promise.all([
      api.paiements(immeubleId.value, annee.value), api.sejours(immeubleId.value), api.regularisations(immeubleId.value),
      api.echeances(immeubleId.value),
    ])
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}

onMounted(async () => {
  await pret
  await charger()
})
watch([immeubleId, annee], charger)

const annees = computed(() => {
  const choisie = annee.value ?? new Date().getFullYear()
  const premiere = Math.min(...sejours.value.map((s) => Number(s.entree.slice(0, 4))), choisie)
  const derniere = Math.max(new Date().getFullYear(), choisie)
  return Array.from({ length: derniere - premiere + 1 }, (_, i) => derniere - i)
})

// ---------------------------------------------------------------- list

const total = (p: Paiement) => new Big(p.loyer).plus(p.provision).plus(p.regularisation).toString()
const exercice = (id: number | null) => {
  const r = regularisations.value.find((x) => x.id === id)
  return r ? exerciceCourt(r.debut, r.fin) : ''
}

const affiches = computed(() =>
  paiements.value
    .filter((p) => filtreSejour.value === '' || p.sejour_id === filtreSejour.value)
    .filter((p) => filtreType.value === ''
      || (filtreType.value === 'loyers' ? p.mois !== null : p.regularisation_id !== null))
    .filter((p) => filtreBanque.value === '' || (filtreBanque.value === 'rapproches') === Boolean(p.mouvement_id))
    .sort((x, y) => y.date_paiement.localeCompare(x.date_paiement) || y.id - x.id),
)

const totaux = computed(() => {
  const somme = (champ: (p: Paiement) => string) =>
    affiches.value.reduce((t, p) => t.plus(champ(p)), new Big(0)).toString()
  return { montant: somme(total), loyer: somme((p) => p.loyer), provision: somme((p) => p.provision),
    regularisation: somme((p) => p.regularisation) }
})

const moisFr = (m: string | null) => (m ? `${MOIS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}` : '')
const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']

// ---------------------------------------------------------------- entry and editing

const vide = (date = aujourdhui, mode: Brouillon['mode'] = 'virement'): Brouillon => ({
  id: null, date, sejour_id: null, mois: date.slice(0, 7), montant: '', loyer: '', provision: '',
  regularisation_id: null, regularisation: '', mode, note: '',
})

// Payment open in the modal form (new or edited), and the error the API gave for it
const formulaire = ref<Brouillon | null>(null)
const erreurFormulaire = ref<string | null>(null)

function ouvrir(b: Brouillon) {
  formulaire.value = b
  erreurFormulaire.value = null
}

function modifier(p: Paiement) {
  ouvrir({
    id: p.id, date: p.date_paiement, sejour_id: p.sejour_id, mois: p.mois?.slice(0, 7) ?? '',
    montant: nombreFr(new Big(total(p)).toFixed(2)), loyer: nombreFr(p.loyer), provision: nombreFr(p.provision),
    regularisation_id: p.regularisation_id, regularisation: p.regularisation_id ? nombreFr(p.regularisation) : '',
    mode: p.mode ?? '', note: p.note ?? '',
  })
}

const zero = (texte: string) => (nombreApi(texte) ?? '0') === '0'

const versApi = (b: Brouillon): PaiementSaisi => ({
  sejour_id: b.sejour_id!,
  date_paiement: b.date,
  // A regularisation payment alone covers no month of rent
  mois: zero(b.loyer) && zero(b.provision) ? null : b.mois || null,
  loyer: nombreApi(b.loyer) ?? '0',
  provision: nombreApi(b.provision) ?? '0',
  regularisation_id: b.regularisation_id,
  regularisation: b.regularisation_id ? nombreApi(b.regularisation) ?? '0' : '0',
  mode: b.mode || null,
  note: b.note.trim() || null,
  montant: nombreApi(b.montant),
})

async function enregistrer(suivant: boolean) {
  const b = formulaire.value!
  occupe.value = true
  try {
    if (b.id === null) {
      await api.creerPaiement(versApi(b))
    } else {
      await api.modifierPaiement(b.id, versApi(b))
    }
    // « Ajouter et en saisir un autre » keeps the date and the mode: several payments of one bank statement
    formulaire.value = suivant ? vide(b.date, b.mode) : null
    erreurFormulaire.value = null
    message.value = { texte: 'Paiement enregistré', type: 'info' }
    await charger()
  } catch (e) {
    erreurFormulaire.value = (e as Error).message
  } finally {
    occupe.value = false
  }
}

async function supprimer(id: number) {
  if (!confirm('Supprimer ce paiement ?')) {
    return
  }
  try {
    await api.supprimerPaiement(id)
    formulaire.value = null
    message.value = { texte: 'Paiement supprimé', type: 'info' }
    await charger()
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}

</script>

<template>
  <section class="entete-page">
    <h1>Paiements</h1>
    <button type="button" class="principal" @click="ouvrir(vide())">+ Ajouter un paiement</button>
  </section>
  <p class="discret">
    Une ligne par paiement reçu (virement, chèque…) : le montant du relevé, réparti entre loyer, provision et
    régularisation. Cliquer une ligne pour la modifier ; les mois sans paiement se contrôlent dans
    <RouterLink to="/controles">Contrôles</RouterLink>. Pour les années sans paiements saisis, voir les
    <RouterLink to="/provisions">totaux annuels (historique)</RouterLink>.
  </p>
  <p v-if="message" class="message" :class="message.type">{{ message.texte }}</p>

  <section class="filtres">
    <select v-model="annee" aria-label="Année">
      <option :value="null">Toutes les années</option>
      <option v-for="a in annees" :key="a" :value="a">{{ a }}</option>
    </select>
    <select v-model="filtreSejour" aria-label="Locataire">
      <option value="">Tous les locataires</option>
      <option v-for="s in sejours" :key="s.id" :value="s.id">{{ s.lot }} – {{ s.locataire }}</option>
    </select>
    <select v-model="filtreType" aria-label="Type">
      <option value="">Tous les paiements</option>
      <option value="loyers">Loyers et provisions</option>
      <option value="regularisations">Régularisations</option>
    </select>
    <select v-model="filtreBanque" aria-label="Banque">
      <option value="">Rapprochés ou non</option>
      <option value="rapproches">Rapprochés avec la banque</option>
      <option value="non_rapproches">Non rapprochés</option>
    </select>
    <span class="discret">{{ affiches.length }} paiement(s)</span>
  </section>

  <div class="defilement">
    <table class="liste paiements">
      <thead>
        <tr>
          <th>Date</th><th>Locataire</th><th>Mois couvert</th><th class="nombre">Montant reçu</th><th title="Vu sur un relevé de la banque">Banque</th>
          <th class="nombre">Loyer</th><th class="nombre">Provision</th><th>Régularisation</th><th>Mode</th>
          <th>Note</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="p in affiches" :key="p.id" @click="modifier(p)">
          <td>{{ dateFr(p.date_paiement) }}</td>
          <td>{{ p.lot }} – {{ p.locataire }}</td>
          <td>{{ moisFr(p.mois) }}</td>
          <td class="nombre"><strong>{{ euros(total(p)) }}</strong></td>
          <td @click.stop>
            <RouterLink v-if="p.mouvement_id" :to="{ name: 'banque', query: { mouvement: p.mouvement_id } }" class="ok"
              title="Vu sur un relevé de la banque : ouvrir le mouvement">✓</RouterLink>
          </td>
          <td class="nombre">{{ p.mois ? euros(p.loyer) : '' }}</td>
          <td class="nombre">{{ p.mois ? euros(p.provision) : '' }}</td>
          <td>
            <template v-if="p.regularisation_id">
              {{ euros(p.regularisation) }} <span class="discret">({{ exercice(p.regularisation_id) }})</span>
            </template>
          </td>
          <td>{{ p.mode ? MODES_PAIEMENT[p.mode] : '' }}</td>
          <td class="discret note" :title="p.note ?? ''">{{ p.note }}</td>
        </tr>
      </tbody>
      <tfoot v-if="affiches.length">
        <tr>
          <td colspan="3"><strong>Total</strong></td>
          <td class="nombre"><strong>{{ euros(totaux.montant) }}</strong></td>
          <td />
          <td class="nombre">{{ euros(totaux.loyer) }}</td>
          <td class="nombre">{{ euros(totaux.provision) }}</td>
          <td>{{ euros(totaux.regularisation) }}</td>
          <td colspan="2" />
        </tr>
      </tfoot>
    </table>
  </div>

  <FormulairePaiement
    v-if="formulaire && immeubleId !== null"
    :key="formulaire.id ?? 'nouveau'"
    v-model="formulaire"
    :immeuble="immeubleId"
    :sejours="sejours"
    :regularisations="regularisations"
    :echeances="echeances"
    :paiements="paiements"
    :occupe="occupe"
    :erreur="erreurFormulaire"
    @enregistrer="enregistrer"
    @fermer="formulaire = null"
    @supprimer="supprimer(formulaire.id!)"
  />

</template>

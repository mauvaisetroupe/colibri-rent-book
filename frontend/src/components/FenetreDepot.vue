<script lang="ts">
// The deposit of a stay (ADR 0021), in a modal window: what was paid and refunded (linked to their bank transfer, or to
// none: paid to an agency, before the statements), and the retention, what is kept to cover unpaid months or
// regularisations (payments « depot », never seen at the bank, made again as a whole here). Each action is saved at
// once. Opened from the bank (« Dépôt de garantie… » on a transfer), a deposit received or a refund comes prefilled
// with the transfer.

export type DepotPrerempli = { sens: 'recu' | 'restitution', date: string, montant: string, mouvement_id: number }
</script>

<script setup lang="ts">
import Big from 'big.js'
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'

import {
  api, estRetenue, type Echeance, type Mouvement, type Paiement, type Regularisation, type Sejour, type VersementDepot,
} from '../api'
import { dusDuSejour, partageMois, type Du } from '../depot'
import { dateFr, euros, nombreApi, nombreFr } from '../format'

const props = defineProps<{ sejour: Sejour, immeuble: number, echeances: Echeance[], prerempli: DepotPrerempli | null }>()
const emit = defineEmits<{ modifie: [], fermer: [] }>()

const fenetre = ref<HTMLDialogElement | null>(null)
const versements = ref<VersementDepot[]>([])
const paiements = ref<Paiement[]>([])
const regularisations = ref<Regularisation[]>([])
const mouvements = ref<Mouvement[]>([])
const erreur = ref<string | null>(null)
const occupe = ref(false)

async function charger() {
  const [v, p, r, m] = await Promise.all([api.depots(props.immeuble), api.paiements(props.immeuble, null),
    api.regularisations(props.immeuble), api.mouvements('tous')])
  versements.value = v.filter((x) => x.sejour_id === props.sejour.id)
  paiements.value = p
  regularisations.value = r
  mouvements.value = m
}

onMounted(async () => {
  fenetre.value?.showModal()
  try {
    await charger()
    if (props.prerempli) {
      const p = props.prerempli
      versement.value = { id: null, sens: p.sens, date: p.date, montant: nombreFr(p.montant), mouvement_id: p.mouvement_id, note: '' }
    }
  } catch (e) {
    erreur.value = (e as Error).message
  }
})

const retenue = computed(() => paiements.value.filter((p) => p.sejour_id === props.sejour.id && estRetenue(p)))
const somme = (valeurs: string[]) => valeurs.reduce((t, v) => t.plus(v), new Big(0))
const verse = computed(() => somme(versements.value.map((v) => v.montant)))
const retenu = computed(() => somme(retenue.value.map((p) => new Big(p.loyer).plus(p.provision).plus(p.regularisation).toString())))
const detenu = computed(() => verse.value.minus(retenu.value))

const mouvementDe = (id: number | null) => mouvements.value.find((m) => m.id === id)
const libelleRetenue = (p: Paiement) => {
  if (p.mois) {
    return `Loyer ${p.mois.slice(5, 7)}/${p.mois.slice(0, 4)}`
  }
  const r = regularisations.value.find((x) => x.id === p.regularisation_id)
  return r ? `Régularisation ${r.debut.slice(0, 4)}${r.fin.slice(0, 4) !== r.debut.slice(0, 4) ? `-${r.fin.slice(0, 4)}` : ''}` : 'Régularisation'
}

async function agir(action: () => Promise<unknown>) {
  occupe.value = true
  erreur.value = null
  try {
    await action()
    await charger()
    emit('modifie')
    return true
  } catch (e) {
    erreur.value = (e as Error).message
    return false
  } finally {
    occupe.value = false
  }
}

// ---------------------------------------------------------------- deposit received, refund

type SaisieVersement = { id: number | null, sens: 'recu' | 'restitution', date: string, montant: string, mouvement_id: number | null, note: string }
const versement = ref<SaisieVersement | null>(null)

function nouveauVersement(sens: 'recu' | 'restitution') {
  const montant = sens === 'recu' ? props.sejour.depot_garantie : (detenu.value.gt(0) ? detenu.value.toString() : null)
  versement.value = {
    id: null, sens, date: sens === 'recu' ? props.sejour.entree : (props.sejour.sortie ?? new Date().toISOString().slice(0, 10)),
    montant: nombreFr(montant), mouvement_id: null, note: '',
  }
}

function modifierVersement(v: VersementDepot) {
  versement.value = {
    id: v.id, sens: new Big(v.montant).gt(0) ? 'recu' : 'restitution', date: v.date_versement,
    montant: nombreFr(new Big(v.montant).abs().toString()), mouvement_id: v.mouvement_id, note: v.note ?? '',
  }
}

// Transfers it may be: of its sense, a tenant payment, a deposit or not categorised, with a rest (or the one linked);
// the same amount first, then the nearest in time
const candidats = computed(() => {
  const v = versement.value
  if (!v) {
    return []
  }
  const montant = new Big(nombreApi(v.montant) ?? '0')
  const ecart = (m: Mouvement) => Math.abs(new Date(m.date_operation).getTime() - new Date(v.date || props.sejour.entree).getTime())
  return mouvements.value
    .filter((m) => (new Big(m.montant).gt(0) === (v.sens === 'recu'))
      && (m.categorie === null || m.categorie === 'locataire' || m.categorie === 'depot_garantie')
      && (m.id === v.mouvement_id || new Big(m.montant).abs().minus(m.couvert).gt(0)))
    .map((m) => ({ m, egal: new Big(m.montant).abs().minus(m.couvert).eq(montant) }))
    .sort((a, b) => Number(b.egal) - Number(a.egal) || ecart(a.m) - ecart(b.m))
    .slice(0, 30)
})

async function enregistrerVersement() {
  const v = versement.value!
  const montant = nombreApi(v.montant)
  if (!montant || !new Big(montant).gt(0)) {
    erreur.value = 'Montant : un nombre positif (le sens vient du bouton)'
    return
  }
  const donnees = {
    sejour_id: props.sejour.id, date_versement: v.date, montant: v.sens === 'recu' ? montant : `-${montant}`,
    mouvement_id: v.mouvement_id, note: v.note.trim() || null,
  }
  if (await agir(() => (v.id === null ? api.creerDepot(donnees) : api.modifierDepot(v.id, donnees)))) {
    versement.value = null
  }
}

function supprimerVersement(v: VersementDepot) {
  if (confirm(`Supprimer ce ${new Big(v.montant).gt(0) ? 'dépôt' : 'remboursement'} de ${euros(new Big(v.montant).abs().toString())} ?`)) {
    return agir(() => api.supprimerDepot(v.id))
  }
}

// ---------------------------------------------------------------- retention

type LigneSaisie = Du & { pris: boolean, montant: string }
const saisieRetenue = ref<{ date: string, lignes: LigneSaisie[] } | null>(null)

function ouvrirRetenue() {
  const dus = dusDuSejour(props.sejour, props.echeances, paiements.value, regularisations.value, verse.value.toString())
  // A retention already made: its amounts; else the proposal, the oldest first up to the deposit
  const actuel = (d: Du) => retenue.value.filter((p) => (d.mois ? p.mois?.startsWith(d.mois) : p.regularisation_id === d.regularisation_id))
    .reduce((t, p) => t.plus(p.loyer).plus(p.provision).plus(p.regularisation), new Big(0))
  saisieRetenue.value = {
    date: retenue.value[0]?.date_paiement ?? props.sejour.sortie ?? new Date().toISOString().slice(0, 10),
    lignes: dus.map((d) => {
      const montant = retenue.value.length ? actuel(d).toString() : d.propose
      return { ...d, pris: new Big(montant).gt(0), montant: nombreFr(montant) }
    }),
  }
}

const totalRetenue = computed(() => somme((saisieRetenue.value?.lignes ?? []).filter((l) => l.pris).map((l) => nombreApi(l.montant) ?? '0')))
const aRendre = computed(() => verse.value.minus(totalRetenue.value))

async function enregistrerRetenue() {
  const s = saisieRetenue.value!
  const lignes = s.lignes.filter((l) => l.pris && Number(nombreApi(l.montant) ?? 0) > 0).map((l) => {
    const montant = nombreApi(l.montant)!
    return l.mois ? { mois: l.mois, ...partageMois(l, montant) } : { regularisation_id: l.regularisation_id!, regularisation: montant }
  })
  if (await agir(() => api.retenue(props.sejour.id, { date: s.date, lignes }))) {
    saisieRetenue.value = null
  }
}

function annulerRetenue() {
  if (confirm('Annuler la retenue ? Les mois et régularisations qu\'elle couvrait redeviennent dus.')) {
    return agir(() => api.retenue(props.sejour.id, { date: props.sejour.sortie ?? new Date().toISOString().slice(0, 10), lignes: [] }))
  }
}
</script>

<template>
  <dialog ref="fenetre" class="fenetre large" @cancel.prevent="emit('fermer')">
    <h2>Dépôt de garantie · {{ sejour.locataire }} ({{ sejour.lot }})</h2>
    <p class="resume">
      Prévu au bail {{ sejour.depot_garantie ? euros(sejour.depot_garantie) : '—' }} · versé {{ euros(verse.toString()) }}
      <template v-if="retenu.gt(0)"> · retenu {{ euros(retenu.toString()) }}</template>
      · <strong>détenu {{ euros(detenu.toString()) }}</strong>
    </p>

    <table v-if="versements.length || retenue.length" class="liste">
      <thead><tr><th>Date</th><th>Mouvement</th><th class="nombre">Montant</th><th>Virement</th><th>Note</th><th /></tr></thead>
      <tbody>
        <tr v-for="v in versements" :key="`v${v.id}`" class="sans-clic">
          <td>{{ dateFr(v.date_versement) }}</td>
          <td>{{ new Big(v.montant).gt(0) ? 'Dépôt reçu' : 'Restitution' }}</td>
          <td class="nombre">{{ euros(v.montant) }}</td>
          <td>
            <template v-if="mouvementDe(v.mouvement_id)">{{ dateFr(mouvementDe(v.mouvement_id)!.date_operation) }} {{ mouvementDe(v.mouvement_id)!.libelle }}</template>
            <span v-else class="discret">sans virement</span>
          </td>
          <td class="discret">{{ v.note }}</td>
          <td class="actions-ligne">
            <button type="button" title="Modifier" :disabled="occupe" @click="modifierVersement(v)">✎</button>
            <button type="button" class="danger" title="Supprimer" :disabled="occupe" @click="supprimerVersement(v)">✕</button>
          </td>
        </tr>
        <tr v-for="(p, i) in retenue" :key="`r${p.id}`" class="sans-clic">
          <td>{{ dateFr(p.date_paiement) }}</td>
          <td>Retenue : {{ libelleRetenue(p) }}</td>
          <td class="nombre">{{ euros(new Big(p.loyer).plus(p.provision).plus(p.regularisation).neg().toString()) }}</td>
          <td><span class="discret">sans virement</span></td>
          <td />
          <td class="actions-ligne">
            <template v-if="i === 0">
              <button type="button" title="Refaire la retenue" :disabled="occupe" @click="ouvrirRetenue">✎</button>
              <button type="button" class="danger" title="Annuler la retenue" :disabled="occupe" @click="annulerRetenue">✕</button>
            </template>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else class="discret">Aucun dépôt enregistré.</p>

    <div v-if="!versement && !saisieRetenue" class="actions">
      <button type="button" :disabled="occupe" @click="nouveauVersement('recu')">Dépôt reçu…</button>
      <button type="button" :disabled="occupe || !detenu.gt(0)" @click="nouveauVersement('restitution')">Restitution…</button>
      <button type="button" :disabled="occupe || !verse.gt(0)" @click="ouvrirRetenue">Retenue…</button>
    </div>

    <!-- Deposit received or refunded -->
    <form v-if="versement" class="formulaire" @submit.prevent="enregistrerVersement">
      <h3>{{ versement.sens === 'recu' ? 'Dépôt reçu' : 'Restitution' }}</h3>
      <div class="rangee">
        <label>Date <input v-model="versement.date" type="date" required></label>
        <label>Montant <input v-model="versement.montant" class="nombre" size="9" required></label>
      </div>
      <label class="large">Virement
        <select v-model="versement.mouvement_id">
          <option :value="null">Aucun (agence, espèces, avant les relevés…)</option>
          <option v-for="c in candidats" :key="c.m.id" :value="c.m.id">
            {{ c.egal ? '✓ ' : '' }}{{ dateFr(c.m.date_operation) }} · {{ c.m.libelle }} · {{ euros(c.m.montant) }}
            <template v-if="Number(c.m.couvert) > 0"> (reste {{ euros(new Big(c.m.montant).abs().minus(c.m.couvert).toString()) }})</template>
          </option>
        </select>
      </label>
      <label class="large">Note <input v-model="versement.note"></label>
      <div class="actions">
        <button type="submit" class="principal" :disabled="occupe">Enregistrer</button>
        <button type="button" @click="versement = null">Annuler</button>
      </div>
    </form>

    <!-- Retention: what the deposit covers -->
    <form v-if="saisieRetenue" class="formulaire" @submit.prevent="enregistrerRetenue">
      <h3>Retenue sur le dépôt de {{ euros(verse.toString()) }}</h3>
      <p class="discret">
        Ce que le locataire doit encore, les plus anciens d'abord : les mois impayés et les régularisations envoyées non
        soldées. Les montants sont proposés jusqu'au dépôt versé ; ils se modifient.
      </p>
      <label>Date <input v-model="saisieRetenue.date" type="date" required></label>
      <table v-if="saisieRetenue.lignes.length" class="liste">
        <thead><tr><th /><th>Dû</th><th class="nombre">Reste dû</th><th class="nombre">Retenu</th></tr></thead>
        <tbody>
          <tr v-for="l in saisieRetenue.lignes" :key="l.cle" class="sans-clic">
            <td><input v-model="l.pris" type="checkbox" :aria-label="l.libelle"></td>
            <td>{{ l.libelle }}</td>
            <td class="nombre">{{ euros(l.du) }}</td>
            <td class="nombre"><input v-model="l.montant" class="nombre" size="9" :disabled="!l.pris" :aria-label="`Retenu sur ${l.libelle}`"></td>
          </tr>
        </tbody>
      </table>
      <p v-else class="discret">Rien n'est dû : ni mois impayé, ni régularisation envoyée non soldée.</p>
      <p class="controle" :class="aRendre.lt(0) ? 'ko' : 'ok'">
        Retenu {{ euros(totalRetenue.toString()) }} ·
        <template v-if="aRendre.lt(0)">dépasse le dépôt de {{ euros(aRendre.neg().toString()) }}</template>
        <template v-else-if="aRendre.gt(0)">reste {{ euros(aRendre.toString()) }} à restituer (Restitution…)</template>
        <template v-else>rien à restituer</template>
      </p>
      <div class="actions">
        <button type="submit" class="principal" :disabled="occupe || aRendre.lt(0)">Enregistrer la retenue</button>
        <button type="button" @click="saisieRetenue = null">Annuler</button>
      </div>
    </form>

    <p v-if="erreur" class="message erreur">{{ erreur }}</p>

    <div class="actions">
      <RouterLink v-if="prerempli" to="/banque">Retour à la banque</RouterLink>
      <button type="button" @click="emit('fermer')">Fermer</button>
    </div>
  </dialog>
</template>

<style scoped>
.formulaire {
  margin-top: 1rem;
  padding: 0.6rem 0.8rem;
  border-radius: 6px;
  background: var(--fond-avertissement);
}

.actions-ligne {
  white-space: nowrap;
}

.controle {
  margin: 0.5rem 0;
  padding: 0.5rem 0.8rem;
  border-radius: 6px;
  background: var(--surface);
  font-weight: 600;
}
</style>

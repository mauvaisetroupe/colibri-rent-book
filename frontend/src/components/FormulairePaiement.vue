<script lang="ts">
import Big from 'big.js'

import { api, type ModePaiement, type PaiementSaisi } from '../api'
import { nombreApi } from '../format'

// One payment received (new or edited), in a modal form: the amount of the bank statement, split into rent,
// provision and regularisations; the split must add up to the amount (checked again by the API). Opened from a bank
// movement, a rest may be left, justified by a note (a deposit paid with the rent…) that goes on the movement.

// Toward one regularisation; negative: refund paid by the owner
export type Versement = { regularisation_id: number, montant: string }

export type Brouillon = {
  id: number | null
  date: string
  sejour_id: number | null
  // 'AAAA-MM', empty for a regularisation payment alone
  mois: string
  montant: string
  loyer: string
  provision: string
  // A payment carries one regularisation: the first goes with the rent, each other one is a payment of its own
  versements: Versement[]
  mode: ModePaiement | ''
  note: string
  // Opened from a bank movement: the rest of the transfer not split here is a deposit (recorded as such, ADR 0019),
  // or is justified by this note on the movement
  resteDepot?: boolean
  justification?: string
}

const zero = (texte: string) => (nombreApi(texte) ?? '0') === '0'

/** The payments a draft makes: rent, provision and the first regularisation, then one per other regularisation. */
export function saisies(b: Brouillon, mouvement_id: number | null = null): PaiementSaisi[] {
  const commun = { sejour_id: b.sejour_id!, date_paiement: b.date, mode: b.mode || null, note: b.note.trim() || null }
  const avecMouvement = mouvement_id === null ? {} : { mouvement_id }
  const loyerSeul = !zero(b.loyer) || !zero(b.provision)
  const [premier, ...autres] = loyerSeul || !b.versements.length ? [null, ...b.versements] : b.versements
  const ligne = (loyer: string, provision: string, v: Versement | null, mois: string | null): PaiementSaisi => {
    const regularisation = v ? nombreApi(v.montant) ?? '0' : '0'
    return {
      ...commun, ...avecMouvement, mois, loyer, provision, regularisation_id: v?.regularisation_id ?? null, regularisation,
      // Checked again by the API: this payment's own split
      montant: new Big(loyer).plus(provision).plus(regularisation).toString(),
    }
  }
  return [
    // A regularisation payment alone covers no month of rent
    ligne(nombreApi(b.loyer) ?? '0', nombreApi(b.provision) ?? '0', premier ?? null, loyerSeul ? b.mois || null : null),
    ...autres.map((v) => ligne('0', '0', v, null)),
  ]
}

/** Saves a draft: the payment itself (created or changed), then those of the other regularisations. */
export async function enregistrerBrouillon(b: Brouillon, mouvement_id: number | null = null) {
  const [premier, ...autres] = saisies(b, mouvement_id)
  if (b.id === null) {
    await api.creerPaiement(premier!)
  } else {
    await api.modifierPaiement(b.id, premier!)
  }
  for (const s of autres) {
    await api.creerPaiement(s)
  }
}
</script>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import { aEncaisser, MODES_PAIEMENT, type Echeance, type Paiement, type Regularisation, type Sejour } from '../api'
import { attendu } from '../echeances'
import { dateFr, euros, exerciceCourt, nombreFr } from '../format'
import ChoixMois from './ChoixMois.vue'

const props = defineProps<{
  immeuble: number
  sejours: Sejour[]
  regularisations: Regularisation[]
  // Rent and provision called (ADR 0009): the amounts proposed for the month
  echeances: Echeance[]
  // Payments already loaded: last payment toward a regularisation, as a suggestion
  paiements: Paiement[]
  occupe: boolean
  erreur: string | null
  // Opened from a bank movement (ADR 0018): what it is, recalled above the form
  mouvement?: { libelle: string, date: string, montant: string, couvert: string } | null
}>()
const b = defineModel<Brouillon>({ required: true })
// « suivant »: save, then start another payment (same date and mode), e.g. several lines of one bank statement
const emit = defineEmits<{ enregistrer: [suivant: boolean], fermer: [], supprimer: [] }>()

const fenetre = ref<HTMLDialogElement | null>(null)
onMounted(() => fenetre.value?.showModal())

const nouveau = computed(() => b.value.id === null)
const aujourdhui = new Date().toISOString().slice(0, 10)
const parti = (s: Sejour) => Boolean(s.sortie && s.sortie < aujourdhui)

// Present tenants first, then those who left (a regularisation may still be due)
const sejoursTries = computed(() =>
  [...props.sejours].sort((x, y) =>
    Number(parti(x)) - Number(parti(y)) || x.lot.localeCompare(y.lot) || y.entree.localeCompare(x.entree)),
)

const reste = (r: Regularisation) => new Big(r.solde).minus(r.montant_recu)

// Regularisations still to be paid (or refunded) by this tenant, and the one already chosen when editing
const regulsOuvertes = computed(() =>
  props.regularisations.filter((r) => r.sejour_id === b.value.sejour_id && !r.remplacee_par
    && (aEncaisser(r) || b.value.versements.some((v) => v.regularisation_id === r.id))),
)

const parse = (texte: string) => nombreApi(texte) ?? (texte.trim() === '' ? '0' : null)

const repartition = computed(() => {
  const parts = [b.value.loyer, b.value.provision, ...b.value.versements.map((v) => v.montant)].map(parse)
  const montant = nombreApi(b.value.montant)
  if (parts.some((p) => p === null) || (b.value.montant.trim() && montant === null)) {
    return { ok: false, texte: 'Un montant est illisible' }
  }
  const total = parts.reduce((t, p) => t.plus(p!), new Big(0))
  if (montant === null) {
    return { ok: false, texte: `Réparti : ${euros(total.toString())} · indiquer le montant reçu` }
  }
  // What is not split, positive: less received (or refunded, for a negative amount) than split is a rest
  const ecart = new Big(montant).minus(total).times(new Big(montant).lt(0) ? -1 : 1)
  if (ecart.eq(0)) {
    return { ok: true, texte: `✓ ${euros(total.toString())} répartis sur ${euros(montant)} reçus` }
  }
  // From a bank movement, less than received: the rest is a deposit, or justified on the movement
  if (props.mouvement && ecart.gt(0) && !total.eq(0)) {
    const texte = b.value.resteDepot ? 'enregistré comme dépôt de garantie' : 'justifié sur le mouvement'
    return b.value.resteDepot || (b.value.justification ?? '').trim()
      ? { ok: true, texte: `✓ ${euros(total.toString())} répartis, reste de ${euros(ecart.toString())} ${texte}`, reste: ecart }
      : { ok: false, texte: `Reste ${euros(ecart.toString())} non réparti : dire ce qu'il est ci-dessous, ou le répartir`, reste: ecart }
  }
  return { ok: false, texte: `✗ Réparti ${euros(total.toString())} sur ${euros(montant)} reçus : écart de ${euros(ecart.toString())}` }
})
const resteAJustifier = computed(() => ('reste' in repartition.value ? repartition.value.reste : null))

const pret = computed(() => repartition.value.ok && b.value.sejour_id !== null && Boolean(b.value.date))

async function choisirSejour() {
  b.value.versements = []
  await montantsAppeles()
}

// The rent and provision of a new payment follow the stay and the month chosen
watch(() => b.value.mois, montantsAppeles)

async function montantsAppeles() {
  if (!nouveau.value || b.value.sejour_id === null) {
    return
  }
  // Amounts called for the month (pro rata of a month of entry or exit), else those of the last paid month
  const mois = b.value.mois || b.value.date.slice(0, 7)
  const sejour = props.sejours.find((s) => s.id === b.value.sejour_id)
  const appel = sejour ? attendu(props.echeances, sejour, mois) : null
  if (appel) {
    b.value.loyer = nombreFr(new Big(appel.loyer).toFixed(2))
    b.value.provision = nombreFr(new Big(appel.provision).toFixed(2))
    return
  }
  const lignes = await api.paiementsDuMois(props.immeuble, mois)
  const precedent = lignes.find((l) => l.sejour_id === b.value.sejour_id)?.precedent
  if (precedent) {
    b.value.loyer = nombreFr(precedent.loyer)
    b.value.provision = nombreFr(precedent.provision)
    b.value.mode = precedent.mode ?? b.value.mode
  }
}

const versement = (r: Regularisation) => b.value.versements.find((v) => v.regularisation_id === r.id)

function basculerRegul(r: Regularisation, coche: boolean) {
  if (!coche) {
    b.value.versements = b.value.versements.filter((v) => v.regularisation_id !== r.id)
    return
  }
  // What the transfer still leaves unsplit (no more than its rest), else the last payment toward it (the instalment of
  // a spread one), else its rest
  const recu = parse(b.value.montant)
  const reparti = [b.value.loyer, b.value.provision, ...b.value.versements.map((v) => v.montant)]
    .reduce((t, x) => t.plus(parse(x) ?? '0'), new Big(0))
  const libre = recu === null ? null : new Big(recu).minus(reparti)
  const dernier = props.paiements.filter((p) => p.regularisation_id === r.id).at(-1)
  const montant = libre?.gt(0) ? (libre.gt(reste(r)) ? reste(r) : libre).toString() : dernier?.regularisation ?? reste(r).toString()
  b.value.versements = [...b.value.versements, { regularisation_id: r.id, montant: nombreFr(montant) }]
}

// A new payment follows its date for the month of rent, until the month is chosen by hand
function changerDate(event: Event) {
  const date = (event.target as HTMLInputElement).value
  if (nouveau.value && b.value.mois === b.value.date.slice(0, 7)) {
    b.value.mois = date.slice(0, 7)
  }
  b.value.date = date
}
</script>

<template>
  <dialog ref="fenetre" class="fenetre" @cancel.prevent="emit('fermer')">
    <form @submit.prevent="pret && emit('enregistrer', false)">
      <h2>{{ nouveau ? 'Nouveau paiement du locataire' : 'Modifier le paiement du locataire' }}</h2>
      <p v-if="mouvement" class="mouvement">
        <strong>{{ mouvement.libelle }}</strong> du {{ dateFr(mouvement.date) }} : {{ euros(mouvement.montant) }}
        · déjà rapproché {{ euros(mouvement.couvert) }}
        · <strong>reste {{ euros(new Big(mouvement.montant).abs().minus(mouvement.couvert).toString()) }}</strong>
      </p>

      <div class="rangee">
        <label>Reçu le <input :value="b.date" type="date" required @change="changerDate"></label>
        <label class="large">Locataire
          <select v-model="b.sejour_id" required @change="choisirSejour">
            <option :value="null" disabled>Choisir…</option>
            <option v-for="s in sejoursTries" :key="s.id" :value="s.id">
              {{ s.lot }} – {{ s.locataire }}{{ parti(s) ? ` (parti le ${dateFr(s.sortie)})` : '' }}
            </option>
          </select>
        </label>
        <label>Mode
          <select v-model="b.mode">
            <option value="">—</option>
            <option v-for="(nom, code) in MODES_PAIEMENT" :key="code" :value="code">{{ nom }}</option>
          </select>
        </label>
      </div>

      <div class="rangee">
        <label>Montant reçu (relevé) <input v-model="b.montant" class="nombre montant" size="10" required></label>
      </div>

      <fieldset>
        <legend>Loyer et provision</legend>
        <div class="rangee">
          <label>Loyer <input v-model="b.loyer" class="nombre" size="9"></label>
          <label>Provision sur charges <input v-model="b.provision" class="nombre" size="9"></label>
          <span class="champ">Mois couvert <ChoixMois v-model="b.mois" facultatif /></span>
        </div>
        <p class="discret">Laisser vides pour un versement de régularisation seul.</p>
      </fieldset>

      <fieldset>
        <legend>Régularisation</legend>
        <p v-if="b.sejour_id === null" class="discret">Choisir d'abord le locataire.</p>
        <p v-else-if="!regulsOuvertes.length" class="discret">Aucune régularisation en attente pour ce locataire.</p>
        <template v-else>
          <p class="discret">Cocher la ou les régularisations payées ; un paiement est enregistré pour chacune.</p>
          <div v-for="r in regulsOuvertes" :key="r.id" class="regul">
            <label class="choix">
              <input type="checkbox" :checked="Boolean(versement(r))" @change="basculerRegul(r, ($event.target as HTMLInputElement).checked)">
              <span>
                <strong>Exercice {{ exerciceCourt(r.debut, r.fin) }}</strong>
                · envoyée le {{ dateFr(r.date_envoi) }}
                · solde {{ euros(r.solde) }} · déjà reçu {{ euros(r.montant_recu) }}
                · <strong>reste {{ euros(reste(r).toString()) }}</strong>
              </span>
            </label>
            <label v-if="versement(r)" class="versement">Versement (négatif : remboursement au locataire)
              <input v-model="versement(r)!.montant" class="nombre" size="9">
            </label>
          </div>
        </template>
      </fieldset>

      <label class="large">Note du paiement <input v-model="b.note"></label>

      <div v-if="mouvement && resteAJustifier" class="justification">
        <strong>Reste de {{ euros(resteAJustifier.toString()) }}</strong>
        <label class="choix">
          <input v-model="b.resteDepot" type="checkbox">
          C'est le dépôt de garantie {{ Number(b.montant.replace(',', '.')) < 0 ? 'remboursé au' : 'versé par le' }} locataire
          (enregistré comme tel, visible dans sa fiche)
        </label>
        <label v-if="!b.resteDepot" class="large">Sinon, ce qui le justifie (note portée sur le mouvement)
          <input v-model="b.justification" placeholder="ex. avance sur le mois suivant">
        </label>
      </div>

      <p class="controle" :class="repartition.ok ? 'ok' : 'ko'">{{ repartition.texte }}</p>
      <p v-if="erreur" class="message erreur">{{ erreur }}</p>

      <div class="actions">
        <button type="submit" class="principal" :disabled="occupe || !pret">
          {{ nouveau ? 'Ajouter' : 'Enregistrer' }}
        </button>
        <button v-if="nouveau" type="button" :disabled="occupe || !pret" @click="emit('enregistrer', true)">
          Ajouter et en saisir un autre
        </button>
        <button type="button" @click="emit('fermer')">Annuler</button>
        <button v-if="!nouveau" type="button" class="danger" :disabled="occupe" @click="emit('supprimer')">Supprimer</button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
/* Modal frame and fields: dialog.fenetre in style.css */
label.choix {
  flex-direction: row;
  align-items: baseline;
  gap: 0.5rem;
  font-size: 0.95rem;
  color: var(--texte);
  cursor: pointer;
}

.mouvement {
  margin: 0;
  padding: 0.5rem 0.8rem;
  border-radius: 6px;
  background: var(--fond-avertissement);
}

.regul {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.versement {
  margin-left: 1.6rem;
}

.justification {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.5rem 0.8rem;
  border-radius: 6px;
  background: var(--fond-avertissement);
}

.montant {
  font-size: 1.1rem;
  font-weight: 600;
}

.controle {
  margin: 0;
  padding: 0.5rem 0.8rem;
  border-radius: 6px;
  background: var(--surface);
  font-weight: 600;
}
</style>

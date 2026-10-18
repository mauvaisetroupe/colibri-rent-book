<script setup lang="ts">
import Big from 'big.js'
import { computed, onMounted, ref, watch } from 'vue'

import { api, NATURES_TRAVAUX, type Immeuble, type Lot, type NatureTravaux, type Travaux } from '../api'
import FormulaireTravaux, { type BrouillonTravaux, travauxVersApi } from '../components/FormulaireTravaux.vue'
import { dateFr, euros, nombreFr } from '../format'
import { useImmeuble } from '../immeuble'

// Works paid by the owner (ADR 0015): for the tax return only, never allocated to the tenants. Deductible (2044,
// line 224) according to their nature. The invoice is typed first, with its PDF; it is paid by bank movements only (ADR
// 0019), linked from the invoice or from « Catégorisation », each in the tax year of its movement.

const { immeubleId: immeuble, pret } = useImmeuble()
const travaux = ref<Travaux[]>([])
const immeubleCourant = ref<Immeuble | null>(null)
const lots = ref<Lot[]>([])
const annee = ref<string>('')
const nature = ref<NatureTravaux | ''>('')
const saisie = ref<BrouillonTravaux | null>(null)
const erreurSaisie = ref<string | null>(null)
const occupe = ref(false)
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
    const [t, i] = await Promise.all([api.travaux(immeuble.value), api.immeuble(immeuble.value)])
    travaux.value = t
    immeubleCourant.value = { ...i, nb_lots: i.lots.length }
    lots.value = i.lots
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}

// The years of a works invoice: those of its payments, else of the invoice (to pay)
const anneesDe = (t: Travaux) => (t.reglements.length ? t.reglements.map((r) => r.date_paiement.slice(0, 4)) : [t.date_facture.slice(0, 4)])
const annees = computed(() => [...new Set(travaux.value.flatMap(anneesDe))].sort().reverse())
const affiches = computed(() => travaux.value.filter((t) =>
  (!annee.value || anneesDe(t).includes(annee.value)) && (!nature.value || t.nature === nature.value)))
const total = (liste: Travaux[]) => liste.reduce((s, t) => s.plus(t.montant_ttc), new Big(0)).toString()
// Paid during the year chosen (every year: all), deductible
const deductibles = computed(() => affiches.value.filter((t) => t.deductible)
  .flatMap((t) => t.reglements).filter((r) => !annee.value || r.date_paiement.startsWith(annee.value))
  .reduce((s, r) => s.plus(r.montant), new Big(0)).toString())
const lotsParImmeuble = computed(() => new Map(immeuble.value === null ? [] : [[immeuble.value, lots.value]]))

function nouveau() {
  saisie.value = {
    id: null, immeuble_id: immeuble.value, lot_id: null, fournisseur: '', description: '', nature: 'entretien',
    date_facture: '', montant_ttc: '', note: '', pdf: null,
  }
  erreurSaisie.value = null
}

function modifier(t: Travaux) {
  saisie.value = {
    id: t.id, immeuble_id: t.immeuble_id, lot_id: t.lot_id, fournisseur: t.fournisseur, description: t.description,
    nature: t.nature, date_facture: t.date_facture, montant_ttc: nombreFr(t.montant_ttc), note: t.note ?? '', pdf: null,
  }
  erreurSaisie.value = null
}

// The invoice as recorded: its payments and its PDF, shown in the form
const enregistree = computed(() => travaux.value.find((t) => t.id === saisie.value?.id) ?? null)

// Saved, then its PDF; a new invoice stays open to link its transfers (or a blank one follows: « en saisir une autre »)
async function enregistrer(suivant: boolean) {
  const b = saisie.value
  if (!b) {
    return
  }
  occupe.value = true
  try {
    const donnees = travauxVersApi(b)
    let t = b.id === null ? await api.creerTravaux(donnees) : await api.modifierTravaux(b.id, donnees)
    if (b.pdf) {
      t = await api.joindrePdfTravaux(t.id, b.pdf)
    }
    message.value = { texte: `${t.description} : enregistrée`, type: 'info' }
    await charger()
    if (suivant) {
      nouveau()
    } else if (b.id === null) {
      modifier(t)
    } else {
      saisie.value = null
    }
  } catch (e) {
    erreurSaisie.value = (e as Error).message
  } finally {
    occupe.value = false
  }
}

async function supprimer(t: Travaux | undefined) {
  if (!t || !confirm(`Supprimer « ${t.description} » (${euros(t.montant_ttc)}) et ses règlements ?`)) {
    return
  }
  await api.supprimerTravaux(t.id)
  saisie.value = null
  await charger()
}

/** « 05/12/2025 », or « 15/02/2027, 10/01/2028 » for an invoice paid in several times. */
const datesReglements = (t: Travaux) => t.reglements.map((r) => dateFr(r.date_paiement)).join(', ')

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
    agrandissement non. Une facture est payée par les virements de la banque qu'on lui rattache (ouvrir la facture, ou
    « Catégorisation des mouvements ») ; chacun compte dans l'année du virement : une facture payée en deux fois
    (acompte, solde) peut se partager entre deux déclarations.
  </p>

  <p v-if="message" class="message" :class="message.type">{{ message.texte }}</p>

  <div class="actions-page">
    <button type="button" @click="nouveau">+ Ajouter une facture de travaux</button>
  </div>

  <FormulaireTravaux
    v-if="saisie && immeubleCourant"
    v-model="saisie"
    :immeubles="[immeubleCourant]"
    :lots="lotsParImmeuble"
    :occupe="occupe"
    :erreur="erreurSaisie"
    :travaux="enregistree"
    @change="charger"
    @enregistrer="enregistrer"
    @fermer="saisie = null"
    @supprimer="supprimer(travaux.find((t) => t.id === saisie?.id))"
  />

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
      {{ affiches.length }} facture(s), {{ euros(total(affiches)) }} ; payé{{ annee ? ` en ${annee}` : '' }} et déductible : <strong>{{ euros(deductibles) }}</strong>
    </span>
  </section>

  <table v-if="affiches.length" class="liste">
    <thead>
      <tr>
        <th>Payée le</th><th>Facture du</th><th>Fournisseur</th><th>Description</th><th>Logement</th><th>Nature</th>
        <th class="nombre">Montant TTC</th><th class="nombre">Reste à payer</th><th>PDF</th><th />
      </tr>
    </thead>
    <tbody>
      <tr v-for="t in affiches" :key="t.id" @click="modifier(t)">
        <td>{{ t.reglements.length ? datesReglements(t) : 'à payer' }}</td>
        <td>{{ dateFr(t.date_facture) }}</td>
        <td>{{ t.fournisseur }}</td>
        <td>{{ t.description }}</td>
        <td>{{ t.lot ?? '' }}</td>
        <td :class="t.deductible ? '' : 'discret'">{{ NATURES_TRAVAUX[t.nature] }}{{ t.deductible ? '' : ' (non déductible)' }}</td>
        <td class="nombre">{{ euros(t.montant_ttc) }}</td>
        <td class="nombre"><span v-if="Number(t.reste) > 0" class="ko">{{ euros(t.reste) }}</span><span v-else class="discret">—</span></td>
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

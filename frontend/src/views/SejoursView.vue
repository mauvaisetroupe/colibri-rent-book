<script setup lang="ts">
import Big from 'big.js'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { api, type Echeance, type ImmeubleDetail, type Locataire, type Sejour } from '../api'
import type { DepotPrerempli } from '../components/BlocDepot.vue'
import FormulaireLocataire, { type FicheSaisie, type LigneEcheance } from '../components/FormulaireLocataire.vue'
import Frise, { type Piste } from '../components/Frise.vue'
import { dateFr, euros, nombreApi, nombreFr } from '../format'
import { useImmeuble } from '../immeuble'

// Tenants (SPEC § 7): one row per stay with its tenant's details, edited together in a modal form. A timeline per lot
// shows the vacancy as gaps; overlapping stays on a lot are refused by the database constraint. The deposit of a stay
// (paid, refunded, kept) is a block of its form (ADR 0021); the bank opens the form of the stay
// (?depot=recu|restitution&sejour=…&mouvement=…&montant=…&date=…, the transfer prefilled, the stay chosen here when the
// label named nobody; ?depot=voir&sejour=…).

const { immeubleId, pret } = useImmeuble()
const immeuble = ref<ImmeubleDetail | null>(null)
const sejours = ref<Sejour[]>([])
const locataires = ref<Locataire[]>([])
const echeances = ref<Echeance[]>([])
const message = ref<{ texte: string, type: 'info' | 'erreur' } | null>(null)

async function charger() {
  if (immeubleId.value === null) {
    return
  }
  ;[immeuble.value, sejours.value, locataires.value, echeances.value] = await Promise.all([
    api.immeuble(immeubleId.value), api.sejours(immeubleId.value), api.locataires(), api.echeances(immeubleId.value),
  ])
}

const route = useRoute()
const router = useRouter()

onMounted(async () => {
  await pret
  await charger().catch((e) => { message.value = { texte: e.message, type: 'erreur' } })
  // From the bank: the form of the stay, its deposit with the transfer prefilled
  const q = route.query
  const s = sejours.value.find((x) => x.id === Number(q.sejour))
  if (q.depot === 'recu' || q.depot === 'restitution') {
    const prerempli: DepotPrerempli = { sens: q.depot, date: String(q.date), montant: String(q.montant), mouvement_id: Number(q.mouvement) }
    enAttente.value = prerempli
    if (s) {
      modifier(s)
    } else {
      // Nobody named in the label: the stay is chosen by clicking its row
      avecAnciens.value = true
    }
  } else if (q.depot === 'voir' && s) {
    modifier(s)
  }
  if (q.depot) {
    router.replace({ query: {} })
  }
})
watch(immeubleId, charger)

const aujourdhui = new Date().toISOString().slice(0, 10)

// Window: from the first entry to six months after today (or the last exit, if later)
const fenetre = computed(() => {
  const entrees = sejours.value.map((s) => s.entree).sort()
  const sorties = sejours.value.map((s) => s.sortie ?? aujourdhui).sort()
  const horizon = new Date()
  horizon.setMonth(horizon.getMonth() + 6)
  const fin = [horizon.toISOString().slice(0, 10), sorties.at(-1) ?? ''].sort().at(-1)!
  return { debut: `${(entrees[0] ?? aujourdhui).slice(0, 4)}-01-01`, fin }
})

const pistes = computed<Piste[]>(() =>
  (immeuble.value?.lots ?? []).map((lot) => ({
    libelle: `${lot.code} (${lot.tantiemes})`,
    segments: sejours.value
      .filter((s) => s.lot_id === lot.id)
      .map((s) => ({
        debut: s.entree,
        fin: s.sortie,
        libelle: s.locataire.split(' (')[0]!,
        classe: s.sortie === null ? 'en-cours' : 'termine',
      })),
  })),
)

// The list shows the current and coming stays; the past ones on demand (the timeline always shows them all)
const avecAnciens = ref(false)
const termine = (s: Sejour) => s.sortie !== null && s.sortie < aujourdhui
const nbAnciens = computed(() => sejours.value.filter(termine).length)
const affiches = computed(() => (avecAnciens.value ? sejours.value : sejours.value.filter((s) => !termine(s))))

// A stay going on whose deposit held differs from that of the lease
const depotEcart = (s: Sejour) => s.sortie === null && s.depot_detenu !== null && s.depot_garantie !== null
  && !new Big(s.depot_detenu).eq(s.depot_garantie)

const locataireDe = (s: Sejour) => locataires.value.find((l) => l.id === s.locataire_id)

// A transfer from the bank to enter as a deposit: given to the next form opened, the stay's (or the one clicked)
const enAttente = ref<DepotPrerempli | null>(null)
const prerempli = ref<DepotPrerempli | null>(null)
// The stay of the form, as saved (its deposit block follows the list once reloaded)
const sejourFiche = computed(() => sejours.value.find((s) => s.id === fiche.value?.sejour_id) ?? null)

// ---------------------------------------------------------------- modal form

const fiche = ref<FicheSaisie | null>(null)
const erreurFiche = ref<string | null>(null)
const occupe = ref(false)

function ouvrir(f: FicheSaisie) {
  fiche.value = f
  erreurFiche.value = null
  prerempli.value = f.sejour_id === null ? null : enAttente.value
  enAttente.value = null
}

const nouvelleFiche = () => ouvrir({
  sejour_id: null, locataire_id: null, nom: '', email: '', telephone: '', note_locataire: '', lot_id: null, entree: '',
  sortie: '', depot_garantie: '', note_sejour: '',
  echeances: [{ id: null, mois: '', loyer: '', provision: '', note: '' }],
})

const echeancesDe = (s: Sejour): LigneEcheance[] => echeances.value
  .filter((e) => e.sejour_id === s.id)
  .map((e) => ({ id: e.id, mois: e.a_partir_du.slice(0, 7), loyer: nombreFr(e.loyer), provision: nombreFr(e.provision),
    note: e.note ?? '' }))

// Current amount called, for the table
const appelActuel = (s: Sejour) => echeances.value.filter((e) => e.sejour_id === s.id).at(-1)

function modifier(s: Sejour) {
  const l = locataireDe(s)
  ouvrir({
    sejour_id: s.id, locataire_id: s.locataire_id, nom: s.locataire, email: l?.email ?? '', telephone: l?.telephone ?? '',
    note_locataire: l?.note ?? '', lot_id: s.lot_id, entree: s.entree, sortie: s.sortie ?? '',
    depot_garantie: nombreFr(s.depot_garantie),
    note_sejour: s.note ?? '',
    echeances: echeancesDe(s),
  })
}

// Rows of the amounts called: deleted, then changed or added (one row per month and stay)
async function enregistrerEcheances(sejourId: number, f: FicheSaisie) {
  const gardees = new Set(f.echeances.map((e) => e.id))
  for (const e of echeances.value.filter((x) => x.sejour_id === sejourId && !gardees.has(x.id))) {
    await api.supprimerEcheance(e.id)
  }
  for (const e of f.echeances) {
    const saisie = {
      sejour_id: sejourId, a_partir_du: e.mois || f.entree.slice(0, 7), loyer: nombreApi(e.loyer) ?? '',
      provision: nombreApi(e.provision) ?? '', note: e.note.trim() || null,
    }
    if (e.id === null) {
      await api.creerEcheance(saisie)
    } else {
      const avant = echeances.value.find((x) => x.id === e.id)
      if (avant && (avant.a_partir_du.slice(0, 7) !== saisie.a_partir_du.slice(0, 7) || nombreFr(avant.loyer) !== e.loyer
        || nombreFr(avant.provision) !== e.provision || (avant.note ?? '') !== e.note)) {
        await api.modifierEcheance(e.id, saisie)
      }
    }
  }
}

// Tenant first (created or updated), then the stay; a new tenant whose stay is refused (overlap…) is deleted again
async function enregistrer() {
  const f = fiche.value!
  const locataire = { nom: f.nom.trim(), email: f.email.trim() || null, telephone: f.telephone.trim() || null,
    note: f.note_locataire.trim() || null }
  const sejour = {
    lot_id: f.lot_id!, entree: f.entree, sortie: f.sortie || null, note: f.note_sejour.trim() || null,
    depot_garantie: nombreApi(f.depot_garantie),
  }
  occupe.value = true
  let cree: number | null = null
  try {
    let locataireId = f.locataire_id
    if (locataireId === null) {
      locataireId = cree = (await api.creerLocataire(locataire)).id
    } else {
      await api.modifierLocataire({ ...locataire, id: locataireId })
    }
    let sejourId = f.sejour_id
    if (sejourId === null) {
      sejourId = (await api.creerSejour({ ...sejour, locataire_id: locataireId })).id
      // The stay exists from here: a new tenant is kept even if an amount called is refused, and saving again edits it
      cree = null
      Object.assign(f, { sejour_id: sejourId, locataire_id: locataireId })
    } else {
      await api.modifierSejour({ ...sejour, locataire_id: locataireId, id: sejourId })
    }
    // Rows left empty in the form are not saved
    f.echeances = f.echeances.filter((e) => e.loyer.trim() || e.provision.trim())
    await enregistrerEcheances(sejourId, f)
    fiche.value = null
    message.value = { texte: `${locataire.nom} enregistré`, type: 'info' }
  } catch (e) {
    if (cree !== null) {
      await api.supprimerLocataire(cree).catch(() => undefined)
    }
    erreurFiche.value = (e as Error).message
  } finally {
    occupe.value = false
    await charger().catch(() => undefined)
  }
}

// The tenant goes with its only stay: no tenant left without a stay
async function supprimer() {
  const f = fiche.value!
  if (!confirm(`Supprimer le séjour de ${f.nom} ?`)) {
    return
  }
  occupe.value = true
  try {
    await api.supprimerSejour(f.sejour_id!)
    const l = locataires.value.find((x) => x.id === f.locataire_id)
    if (l && l.nb_sejours <= 1) {
      await api.supprimerLocataire(l.id)
    }
    fiche.value = null
    message.value = { texte: `Séjour de ${f.nom} supprimé`, type: 'info' }
  } catch (e) {
    erreurFiche.value = (e as Error).message
  } finally {
    occupe.value = false
    await charger().catch(() => undefined)
  }
}
</script>

<template>
  <section class="entete-page">
    <h1>Locataires</h1>
    <button type="button" class="principal" @click="nouvelleFiche">+ Nouveau locataire</button>
  </section>
  <p v-if="message" class="message" :class="message.type">{{ message.texte }}</p>
  <p v-if="enAttente" class="message avertissement">
    Virement du {{ dateFr(enAttente.date) }} de {{ euros(enAttente.montant) }} : cliquer le séjour concerné pour y
    saisir le dépôt {{ enAttente.sens === 'recu' ? 'reçu' : 'restitué' }}.
    <button type="button" @click="enAttente = null">Abandonner</button>
  </p>

  <Frise v-if="immeuble" :debut="fenetre.debut" :fin="fenetre.fin" :pistes="pistes" />
  <p class="discret">
    Les trous entre deux séjours sont de la vacance : ces jours restent au propriétaire (R4). Cliquer une ligne pour
    modifier le locataire et son séjour.
  </p>

  <label v-if="nbAnciens" class="filtre-anciens">
    <input v-model="avecAnciens" type="checkbox"> Afficher aussi les anciens locataires ({{ nbAnciens }})
  </label>

  <table class="liste">
    <thead>
      <tr>
        <th>Lot</th><th>Locataire</th><th>Entrée</th><th>Sortie</th><th class="nombre">Dépôt</th>
        <th class="nombre">Appelé / mois</th><th>E-mail</th><th>Téléphone</th><th>Note</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="s in affiches" :key="s.id" :class="{ ancien: termine(s) }" @click="modifier(s)">
        <td>{{ s.lot }}</td>
        <td>{{ s.locataire }}</td>
        <td>{{ dateFr(s.entree) }}</td>
        <td>{{ s.sortie ? dateFr(s.sortie) : 'en cours' }}</td>
        <td class="nombre">
          {{ euros(s.depot_garantie) }}
          <!-- Held (ADR 0019, 0021): paid minus refunded minus kept -->
          <div v-if="s.depot_detenu !== null" :class="depotEcart(s) ? 'alerte' : 'discret'">
            {{ Number(s.depot_detenu) === 0 ? (s.depot_retenu ? 'soldé' : 'remboursé') : `détenu ${euros(s.depot_detenu)}` }}
          </div>
          <div v-if="s.depot_retenu" class="discret">dont {{ euros(s.depot_retenu) }} retenus</div>
        </td>
        <td class="nombre">
          <template v-if="appelActuel(s)">
            {{ euros(new Big(appelActuel(s)!.loyer).plus(appelActuel(s)!.provision).toString()) }}
            <div class="discret">dont provision {{ euros(appelActuel(s)!.provision) }}</div>
          </template>
          <span v-else class="discret">—</span>
        </td>
        <td>{{ locataireDe(s)?.email }}</td>
        <td>{{ locataireDe(s)?.telephone }}</td>
        <td class="discret">{{ [s.note, locataireDe(s)?.note].filter(Boolean).join(' · ') }}</td>
      </tr>
    </tbody>
  </table>

  <FormulaireLocataire
    v-if="fiche && immeuble"
    v-model="fiche"
    :lots="immeuble.lots"
    :locataires="locataires"
    :occupe="occupe"
    :erreur="erreurFiche"
    :sejour="sejourFiche"
    :immeuble="immeubleId!"
    :echeances="echeances"
    :prerempli="prerempli"
    @enregistrer="enregistrer"
    @fermer="fiche = null"
    @supprimer="supprimer"
    @depot-modifie="charger"
  />
</template>

<style scoped>
.filtre-anciens {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0.3rem 0 0.5rem;
}

.ancien td {
  color: var(--discret);
}

</style>

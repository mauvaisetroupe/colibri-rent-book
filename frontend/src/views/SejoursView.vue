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
// (?depot=recu|restitution&tenancy=…&bank_transaction=…&amount=…&date=…, the transfer prefilled, the stay chosen here when the
// label named nobody; ?depot=voir&tenancy=…).

const { immeubleId, pret } = useImmeuble()
const building = ref<ImmeubleDetail | null>(null)
const tenancies = ref<Sejour[]>([])
const tenants = ref<Locataire[]>([])
const rent_schedules = ref<Echeance[]>([])
const message = ref<{ text: string, type: 'info' | 'erreur' } | null>(null)

async function charger() {
  if (immeubleId.value === null) {
    return
  }
  ;[building.value, tenancies.value, tenants.value, rent_schedules.value] = await Promise.all([
    api.building(immeubleId.value), api.tenancies(immeubleId.value), api.tenants(), api.rent_schedules(immeubleId.value),
  ])
}

const route = useRoute()
const router = useRouter()

onMounted(async () => {
  await pret
  await charger().catch((e) => { message.value = { text: e.message, type: 'erreur' } })
  // From the bank: the form of the stay, its deposit with the transfer prefilled
  const q = route.query
  const s = tenancies.value.find((x) => x.id === Number(q.tenancy))
  if (q.depot === 'recu' || q.depot === 'restitution') {
    const prerempli: DepotPrerempli = { sens: q.depot, date: String(q.date), amount: String(q.amount), bank_transaction_id: Number(q.bank_transaction) }
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
  const entrees = tenancies.value.map((s) => s.move_in).sort()
  const sorties = tenancies.value.map((s) => s.move_out ?? aujourdhui).sort()
  const horizon = new Date()
  horizon.setMonth(horizon.getMonth() + 6)
  const end = [horizon.toISOString().slice(0, 10), sorties.at(-1) ?? ''].sort().at(-1)!
  return { start: `${(entrees[0] ?? aujourdhui).slice(0, 4)}-01-01`, end }
})

const pistes = computed<Piste[]>(() =>
  (building.value?.units ?? []).map((unit) => ({
    label: `${unit.code} (${unit.charge_shares})`,
    segments: tenancies.value
      .filter((s) => s.unit_id === unit.id)
      .map((s) => ({
        start: s.move_in,
        end: s.move_out,
        label: s.tenant.split(' (')[0]!,
        classe: s.move_out === null ? 'en-cours' : 'termine',
      })),
  })),
)

// The list shows the current and coming stays; the past ones on demand (the timeline always shows them all)
const avecAnciens = ref(false)
const termine = (s: Sejour) => s.move_out !== null && s.move_out < aujourdhui
const nbAnciens = computed(() => tenancies.value.filter(termine).length)
const affiches = computed(() => (avecAnciens.value ? tenancies.value : tenancies.value.filter((s) => !termine(s))))

// A stay going on whose deposit held differs from that of the lease
const depotEcart = (s: Sejour) => s.move_out === null && s.deposit_held !== null && s.security_deposit !== null
  && !new Big(s.deposit_held).eq(s.security_deposit)

const locataireDe = (s: Sejour) => tenants.value.find((l) => l.id === s.tenant_id)

// A transfer from the bank to enter as a deposit: given to the next form opened, the stay's (or the one clicked)
const enAttente = ref<DepotPrerempli | null>(null)
const prerempli = ref<DepotPrerempli | null>(null)
// The stay of the form, as saved (its deposit block follows the list once reloaded)
const sejourFiche = computed(() => tenancies.value.find((s) => s.id === fiche.value?.tenancy_id) ?? null)

// ---------------------------------------------------------------- modal form

const fiche = ref<FicheSaisie | null>(null)
const erreurFiche = ref<string | null>(null)
const occupe = ref(false)

function ouvrir(f: FicheSaisie) {
  fiche.value = f
  erreurFiche.value = null
  prerempli.value = f.tenancy_id === null ? null : enAttente.value
  enAttente.value = null
}

const nouvelleFiche = () => ouvrir({
  tenancy_id: null, tenant_id: null, name: '', email: '', phone: '', note_locataire: '', unit_id: null, move_in: '',
  move_out: '', security_deposit: '', note_sejour: '',
  rent_schedules: [{ id: null, month: '', rent: '', charge_advance: '', note: '' }],
})

const echeancesDe = (s: Sejour): LigneEcheance[] => rent_schedules.value
  .filter((e) => e.tenancy_id === s.id)
  .map((e) => ({ id: e.id, month: e.from_month.slice(0, 7), rent: nombreFr(e.rent), charge_advance: nombreFr(e.charge_advance),
    note: e.note ?? '' }))

// Current amount called, for the table
const appelActuel = (s: Sejour) => rent_schedules.value.filter((e) => e.tenancy_id === s.id).at(-1)

function modifier(s: Sejour) {
  const l = locataireDe(s)
  ouvrir({
    tenancy_id: s.id, tenant_id: s.tenant_id, name: s.tenant, email: l?.email ?? '', phone: l?.phone ?? '',
    note_locataire: l?.note ?? '', unit_id: s.unit_id, move_in: s.move_in, move_out: s.move_out ?? '',
    security_deposit: nombreFr(s.security_deposit),
    note_sejour: s.note ?? '',
    rent_schedules: echeancesDe(s),
  })
}

// Rows of the amounts called: deleted, then changed or added (one row per month and stay)
async function enregistrerEcheances(sejourId: number, f: FicheSaisie) {
  const gardees = new Set(f.rent_schedules.map((e) => e.id))
  for (const e of rent_schedules.value.filter((x) => x.tenancy_id === sejourId && !gardees.has(x.id))) {
    await api.supprimerEcheance(e.id)
  }
  for (const e of f.rent_schedules) {
    const saisie = {
      tenancy_id: sejourId, from_month: e.month || f.move_in.slice(0, 7), rent: nombreApi(e.rent) ?? '',
      charge_advance: nombreApi(e.charge_advance) ?? '', note: e.note.trim() || null,
    }
    if (e.id === null) {
      await api.creerEcheance(saisie)
    } else {
      const avant = rent_schedules.value.find((x) => x.id === e.id)
      if (avant && (avant.from_month.slice(0, 7) !== saisie.from_month.slice(0, 7) || nombreFr(avant.rent) !== e.rent
        || nombreFr(avant.charge_advance) !== e.charge_advance || (avant.note ?? '') !== e.note)) {
        await api.modifierEcheance(e.id, saisie)
      }
    }
  }
}

// Tenant first (created or updated), then the stay; a new tenant whose stay is refused (overlap…) is deleted again
async function enregistrer() {
  const f = fiche.value!
  const tenant = { name: f.name.trim(), email: f.email.trim() || null, phone: f.phone.trim() || null,
    note: f.note_locataire.trim() || null }
  const tenancy = {
    unit_id: f.unit_id!, move_in: f.move_in, move_out: f.move_out || null, note: f.note_sejour.trim() || null,
    security_deposit: nombreApi(f.security_deposit),
  }
  occupe.value = true
  let created: number | null = null
  try {
    let locataireId = f.tenant_id
    if (locataireId === null) {
      locataireId = created = (await api.creerLocataire(tenant)).id
    } else {
      await api.modifierLocataire({ ...tenant, id: locataireId })
    }
    let sejourId = f.tenancy_id
    if (sejourId === null) {
      sejourId = (await api.creerSejour({ ...tenancy, tenant_id: locataireId })).id
      // The stay exists from here: a new tenant is kept even if an amount called is refused, and saving again edits it
      created = null
      Object.assign(f, { tenancy_id: sejourId, tenant_id: locataireId })
    } else {
      await api.modifierSejour({ ...tenancy, tenant_id: locataireId, id: sejourId })
    }
    // Rows left empty in the form are not saved
    f.rent_schedules = f.rent_schedules.filter((e) => e.rent.trim() || e.charge_advance.trim())
    await enregistrerEcheances(sejourId, f)
    fiche.value = null
    message.value = { text: `${tenant.name} enregistré`, type: 'info' }
  } catch (e) {
    if (created !== null) {
      await api.supprimerLocataire(created).catch(() => undefined)
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
  if (!confirm(`Supprimer le séjour de ${f.name} ?`)) {
    return
  }
  occupe.value = true
  try {
    await api.supprimerSejour(f.tenancy_id!)
    const l = tenants.value.find((x) => x.id === f.tenant_id)
    if (l && l.tenancy_count <= 1) {
      await api.supprimerLocataire(l.id)
    }
    fiche.value = null
    message.value = { text: `Séjour de ${f.name} supprimé`, type: 'info' }
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
  <p v-if="message" class="message" :class="message.type">{{ message.text }}</p>
  <p v-if="enAttente" class="message avertissement">
    Virement du {{ dateFr(enAttente.date) }} de {{ euros(enAttente.amount) }} : cliquer le séjour concerné pour y
    saisir le dépôt {{ enAttente.sens === 'recu' ? 'reçu' : 'restitué' }}.
    <button type="button" @click="enAttente = null">Abandonner</button>
  </p>

  <Frise v-if="building" :start="fenetre.start" :end="fenetre.end" :pistes="pistes" />
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
        <td>{{ s.unit }}</td>
        <td>{{ s.tenant }}</td>
        <td>{{ dateFr(s.move_in) }}</td>
        <td>{{ s.move_out ? dateFr(s.move_out) : 'en cours' }}</td>
        <td class="nombre">
          {{ euros(s.security_deposit) }}
          <!-- Held (ADR 0019, 0021): paid minus refunded minus kept -->
          <div v-if="s.deposit_held !== null" :class="depotEcart(s) ? 'alerte' : 'discret'">
            {{ Number(s.deposit_held) === 0 ? (s.deposit_retained ? 'soldé' : 'remboursé') : `détenu ${euros(s.deposit_held)}` }}
          </div>
          <div v-if="s.deposit_retained" class="discret">dont {{ euros(s.deposit_retained) }} retenus</div>
        </td>
        <td class="nombre">
          <template v-if="appelActuel(s)">
            {{ euros(new Big(appelActuel(s)!.rent).plus(appelActuel(s)!.charge_advance).toString()) }}
            <div class="discret">dont provision {{ euros(appelActuel(s)!.charge_advance) }}</div>
          </template>
          <span v-else class="discret">—</span>
        </td>
        <td>{{ locataireDe(s)?.email }}</td>
        <td>{{ locataireDe(s)?.phone }}</td>
        <td class="discret">{{ [s.note, locataireDe(s)?.note].filter(Boolean).join(' · ') }}</td>
      </tr>
    </tbody>
  </table>

  <FormulaireLocataire
    v-if="fiche && building"
    v-model="fiche"
    :units="building.units"
    :tenants="tenants"
    :occupe="occupe"
    :erreur="erreurFiche"
    :tenancy="sejourFiche"
    :building="immeubleId!"
    :rent_schedules="rent_schedules"
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

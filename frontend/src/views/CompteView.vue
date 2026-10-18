<script setup lang="ts">
import QRCode from 'qrcode'
import { onMounted, onUnmounted, ref } from 'vue'

import { api, type JetonApi, type Passkey, type Utilisateur } from '../api'
import { enregistrer, nomAppareil } from '../auth/passkey'
import { dateFr } from '../format'

// The account (ADR 0020): its passkeys (one per device, or synced by the phone or computer's keychain), a passkey
// added on this device, or on another one by a single-use link shown as a QR code (a phone scans it and registers its
// own passkey); the API tokens of scripts; logging out.

const utilisateur = ref<Utilisateur | null>(null)
const passkeys = ref<Passkey[]>([])
const jetons = ref<JetonApi[]>([])
const message = ref<{ texte: string, type: 'info' | 'erreur' } | null>(null)
const occupe = ref(false)

async function charger() {
  try {
    ;[utilisateur.value, passkeys.value, jetons.value] = await Promise.all([
      api.session().then((s) => s.utilisateur), api.passkeys(), api.jetons(),
    ])
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}
onMounted(charger)

async function agir(action: () => Promise<unknown>, succes: string) {
  occupe.value = true
  try {
    await action()
    message.value = { texte: succes, type: 'info' }
    await charger()
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  } finally {
    occupe.value = false
  }
}

// ---------------------------------------------------------------- passkeys

const appareil = ref(nomAppareil())
const ajouterIci = () => agir(() => enregistrer(null, appareil.value.trim() || nomAppareil()), 'Passkey ajoutée sur cet appareil')

function supprimer(p: Passkey) {
  if (confirm(`Supprimer la passkey « ${p.appareil} » ? Cet appareil ne pourra plus se connecter avec.`)) {
    return agir(() => api.supprimerPasskey(p.id), 'Passkey supprimée')
  }
}

// Another device: a single-use link, 15 minutes, as a QR code (and the link itself, to send)
const lien = ref<{ url: string, expire_le: string, qr: string } | null>(null)
const restant = ref('')
let minuterie: ReturnType<typeof setInterval> | undefined

async function autreAppareil() {
  try {
    const l = await api.lienAppareil()
    lien.value = { ...l, qr: await QRCode.toDataURL(l.url, { width: 240, margin: 1 }) }
    clearInterval(minuterie)
    minuterie = setInterval(() => {
      const s = Math.max(0, Math.round((new Date(l.expire_le).getTime() - Date.now()) / 1000))
      restant.value = s ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s` : 'expiré'
      if (!s) {
        clearInterval(minuterie)
      }
    }, 1000)
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  }
}
onUnmounted(() => clearInterval(minuterie))

async function copier() {
  try {
    await navigator.clipboard.writeText(lien.value!.url)
    message.value = { texte: 'Lien copié', type: 'info' }
  } catch {
    message.value = { texte: 'Copie impossible : sélectionner le lien à la main', type: 'erreur' }
  }
}

// ---------------------------------------------------------------- API tokens

const nomJeton = ref('')
const nouveauJeton = ref<string | null>(null)
async function creerJeton() {
  occupe.value = true
  try {
    nouveauJeton.value = (await api.creerJeton(nomJeton.value.trim())).jeton
    nomJeton.value = ''
    await charger()
  } catch (e) {
    message.value = { texte: (e as Error).message, type: 'erreur' }
  } finally {
    occupe.value = false
  }
}
function revoquer(j: JetonApi) {
  if (confirm(`Révoquer le jeton « ${j.nom} » ? Les scripts qui l'utilisent ne pourront plus se connecter.`)) {
    return agir(() => api.revoquerJeton(j.id), 'Jeton révoqué')
  }
}

async function deconnecter() {
  await api.deconnexion()
  window.location.assign('/connexion')
}
</script>

<template>
  <section class="entete-page">
    <h1>Mon compte</h1>
    <span v-if="utilisateur" class="discret">{{ utilisateur.nom }} · {{ utilisateur.email }}</span>
    <button type="button" class="deconnexion" @click="deconnecter"><span class="oi oi-sign-out" /> Se déconnecter</button>
  </section>
  <p v-if="message" class="message" :class="message.type">{{ message.texte }}</p>

  <section class="bloc">
    <h2>Mes passkeys</h2>
    <p class="discret">
      Une passkey par appareil (ou partagée par le trousseau iCloud, Google…) : on se connecte avec l'empreinte, le visage
      ou le code de l'appareil. Garder au moins deux appareils, pour ne pas perdre l'accès.
    </p>
    <table v-if="passkeys.length" class="liste">
      <thead><tr><th>Appareil</th><th>Créée le</th><th>Dernière connexion</th><th /></tr></thead>
      <tbody>
        <tr v-for="p in passkeys" :key="p.id" class="sans-clic">
          <td>{{ p.appareil }}</td>
          <td>{{ dateFr(p.cree_le.slice(0, 10)) }}</td>
          <td>{{ p.utilisee_le ? dateFr(p.utilisee_le.slice(0, 10)) : 'jamais' }}</td>
          <td><button type="button" class="danger" :disabled="occupe || passkeys.length <= 1" @click="supprimer(p)">Supprimer</button></td>
        </tr>
      </tbody>
    </table>

    <div class="ajouts">
      <div class="ajout">
        <h3>Sur cet appareil</h3>
        <label>Nom <input v-model="appareil" maxlength="60"></label>
        <button type="button" :disabled="occupe" @click="ajouterIci"><span class="oi oi-plus" /> Ajouter une passkey ici</button>
      </div>
      <div class="ajout">
        <h3>Sur un autre appareil (smartphone…)</h3>
        <template v-if="lien && restant !== 'expiré'">
          <img :src="lien.qr" alt="QR code du lien d'enregistrement" width="240" height="240">
          <p class="discret">
            Scanner avec l'appareil photo du téléphone : il ouvre Colibri et y crée sa passkey. Lien à usage unique,
            expire dans {{ restant }}.
          </p>
          <p><button type="button" @click="copier">Copier le lien</button></p>
        </template>
        <template v-else>
          <p class="discret">Un QR code à scanner avec l'autre appareil, valable 15 minutes et une seule fois.</p>
          <button type="button" :disabled="occupe" @click="autreAppareil"><span class="oi oi-mobile" /> Ajouter un autre appareil</button>
        </template>
      </div>
    </div>
  </section>

  <section class="bloc">
    <h2>Jetons d'API</h2>
    <p class="discret">
      Pour les scripts (imports, rapprochement) : un jeton remplace la passkey, dans l'en-tête
      <code>Authorization: Bearer …</code>. Il n'est affiché qu'à sa création ; le révoquer s'il fuit ou ne sert plus.
    </p>
    <p v-if="nouveauJeton" class="message info jeton">
      Nouveau jeton, à copier maintenant (il ne sera plus affiché) : <code>{{ nouveauJeton }}</code>
    </p>
    <table v-if="jetons.length" class="liste">
      <thead><tr><th>Nom</th><th>Créé le</th><th>Dernier usage</th><th /></tr></thead>
      <tbody>
        <tr v-for="j in jetons" :key="j.id" class="sans-clic" :class="{ revoque: j.revoque_le }">
          <td>{{ j.nom }}</td>
          <td>{{ dateFr(j.cree_le.slice(0, 10)) }}</td>
          <td>{{ j.utilise_le ? dateFr(j.utilise_le.slice(0, 10)) : 'jamais' }}</td>
          <td>
            <span v-if="j.revoque_le" class="discret">révoqué le {{ dateFr(j.revoque_le.slice(0, 10)) }}</span>
            <button v-else type="button" class="danger" :disabled="occupe" @click="revoquer(j)">Révoquer</button>
          </td>
        </tr>
      </tbody>
    </table>
    <form class="formulaire" @submit.prevent="creerJeton">
      <label>Nom du jeton <input v-model="nomJeton" required placeholder="ex. rapprochement depuis le Mac" size="30"></label>
      <button type="submit" :disabled="occupe">Créer un jeton</button>
    </form>
  </section>
</template>

<style scoped>
.deconnexion {
  margin-left: auto;
}

.ajouts {
  display: flex;
  flex-wrap: wrap;
  gap: 1.5rem;
  margin-top: 0.8rem;
}

.ajout {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  align-items: flex-start;
  min-width: 16rem;
}

.ajout h3 {
  margin: 0;
}

.jeton code {
  word-break: break-all;
  user-select: all;
}

.revoque td {
  color: var(--discret);
}
</style>

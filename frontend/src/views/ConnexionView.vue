<script setup lang="ts">
import { browserSupportsWebAuthn } from '@simplewebauthn/browser'
import { ref } from 'vue'
import { useRoute } from 'vue-router'

import { seConnecter } from '../auth/passkey'

// Login (ADR 0020): by passkey only. No password: a passkey is registered from a link (made on the server for a new
// account, or from « Mon compte » for another device).

const route = useRoute()
const occupe = ref(false)
const erreur = ref<string | null>(null)
const compatible = browserSupportsWebAuthn()

async function connecter() {
  occupe.value = true
  erreur.value = null
  try {
    await seConnecter()
    // A full load: every screen starts again with the session
    const retour = typeof route.query.retour === 'string' && route.query.retour.startsWith('/') ? route.query.retour : '/'
    window.location.assign(retour)
  } catch (e) {
    erreur.value = (e as Error).message
    occupe.value = false
  }
}
</script>

<template>
  <section class="carte-auth">
    <h1>Colibri <small>rent book</small></h1>
    <p>Connexion par passkey : l'empreinte, le visage ou le code de cet appareil, ou un téléphone qui en a une.</p>
    <p v-if="!compatible" class="message erreur">Ce navigateur ne gère pas les passkeys.</p>
    <button type="button" class="principal" :disabled="occupe || !compatible" @click="connecter">
      <span class="oi oi-key" /> Se connecter avec une passkey
    </button>
    <p v-if="erreur" class="message erreur">{{ erreur }}</p>
    <p class="discret">
      Pas encore de passkey, ou appareil perdu ? Demander un lien d'enregistrement à l'administrateur, ou l'ouvrir depuis
      « Mon compte » sur un appareil déjà connecté.
    </p>
  </section>
</template>

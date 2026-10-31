<script setup lang="ts">
import { browserSupportsWebAuthn } from '@simplewebauthn/browser'
import { ref } from 'vue'
import { useRoute } from 'vue-router'

import { enregistrer, nomAppareil } from '../auth/passkey'

// A passkey registered on this device from a single-use link (ADR 0020): the first one of an account, another device
// (a phone that scanned the QR code of « Mon compte »), or a recovery. Registered, the device is connected.

const route = useRoute()
const jeton = typeof route.query.jeton === 'string' ? route.query.jeton : ''
const device = ref(nomAppareil())
const occupe = ref(false)
const erreur = ref<string | null>(null)
const compatible = browserSupportsWebAuthn()

async function creer() {
  occupe.value = true
  erreur.value = null
  try {
    await enregistrer(jeton, device.value.trim() || nomAppareil())
    window.location.assign('/')
  } catch (e) {
    erreur.value = (e as Error).message
    occupe.value = false
  }
}
</script>

<template>
  <section class="carte-auth">
    <h1>Colibri <small>rent book</small></h1>
    <template v-if="jeton">
      <p>Créer une passkey sur cet appareil : vous vous connecterez ensuite avec son empreinte, son visage ou son code.</p>
      <label>Nom de cet appareil <input v-model="device" maxlength="60"></label>
      <p v-if="!compatible" class="message erreur">Ce navigateur ne gère pas les passkeys.</p>
      <button type="button" class="principal" :disabled="occupe || !compatible" @click="creer">
        <span class="oi oi-key" /> Créer ma passkey
      </button>
      <p v-if="erreur" class="message erreur">{{ erreur }}</p>
      <p class="discret">Le lien ne sert qu'une fois et expire au bout de 15 minutes.</p>
    </template>
    <p v-else class="message erreur">Lien incomplet : il manque le jeton. Rouvrir le lien reçu, ou en demander un nouveau.</p>
  </section>
</template>

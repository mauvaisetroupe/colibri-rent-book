import { startAuthentication, startRegistration, WebAuthnError } from '@simplewebauthn/browser'

import { api } from '../api'

// Passkeys in the browser (ADR 0020): the ceremony is the browser's (Touch ID, Face ID, a phone by QR code), checked by
// the server; a refusal or a cancellation is said in French.

/** A name for this device, proposed at registration (« Mac », « iPhone »…), changed by the user if needed. */
export function nomAppareil() {
  const ua = navigator.userAgent
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Appareil'
  const navigateur = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : ''
  return navigateur ? `${os} (${navigateur})` : os
}

function message(e: unknown) {
  if (e instanceof WebAuthnError || (e as Error).name === 'NotAllowedError') {
    return 'Opération annulée ou refusée par l\'appareil'
  }
  if ((e as Error).name === 'InvalidStateError') {
    return 'Cet appareil a déjà une passkey pour ce compte'
  }
  return (e as Error).message
}

export async function seConnecter() {
  try {
    const { id, options } = await api.connexionOptions()
    await api.connexion(id, await startAuthentication({ optionsJSON: options }))
  } catch (e) {
    throw new Error(message(e))
  }
}

/** Registers a passkey on this device: from a link (jeton), or for the account connected. */
export async function enregistrer(jeton: string | null, device: string) {
  try {
    const { id, options } = await api.enregistrementOptions(jeton)
    await api.enregistrement(id, await startRegistration({ optionsJSON: options }), device)
  } catch (e) {
    throw new Error(message(e))
  }
}

import { ref, watch } from 'vue'

import { api, PAGES_PUBLIQUES, type Immeuble } from './api'

// Building chosen on every screen. Remembered in this browser only (a convenience: the page works without it).

const CLE = 'colibri.immeuble'

const buildings = ref<Immeuble[]>([])
const immeubleId = ref<number | null>(null)
let chargement: Promise<void> | null = null

function memorise(): number | null {
  try {
    const value = Number(localStorage.getItem(CLE))
    return Number.isInteger(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

watch(immeubleId, (id) => {
  try {
    if (id !== null) {
      localStorage.setItem(CLE, String(id))
    }
  } catch {
    // Storage blocked: the choice is simply not remembered
  }
})

export async function rechargerImmeubles() {
  buildings.value = await api.buildings()
  if (!buildings.value.some((i) => i.id === immeubleId.value)) {
    const souvenir = memorise()
    immeubleId.value = buildings.value.find((i) => i.id === souvenir)?.id ?? buildings.value[0]?.id ?? null
  }
}

export function useImmeuble() {
  // Not on the login pages (no session yet: the page loads again once connected)
  chargement ??= PAGES_PUBLIQUES.includes(window.location.pathname) ? Promise.resolve() : rechargerImmeubles()
  return { buildings, immeubleId, pret: chargement }
}

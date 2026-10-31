import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

// Exercise of the statement screens (both dates included). Kept in the address (?start=…&end=…) so that a statement
// can be reopened or shared, and remembered across screens (the menu links carry no query) and reloads (browser
// storage, a convenience only). Default: the last full calendar year.

type Periode = { start: string, end: string }

const CLE = 'colibri.exercice'
const ISO = /^\d{4}-\d\d-\d\d$/

function lire(): Periode | null {
  try {
    const p = JSON.parse(localStorage.getItem(CLE) ?? 'null') as Periode | null
    return p && ISO.test(p.start) && ISO.test(p.end) ? p : null
  } catch {
    return null
  }
}

function ecrire(p: Periode) {
  try {
    localStorage.setItem(CLE, JSON.stringify(p))
  } catch {
    // Private window, blocked storage: the exercise is only kept for this visit
  }
}

const anneePrecedente = new Date().getFullYear() - 1
const memoire = ref<Periode>(lire() ?? { start: `${anneePrecedente}-01-01`, end: `${anneePrecedente}-12-31` })

export function useExercice() {
  const route = useRoute()
  const router = useRouter()

  // A link with an exercise (shared, or from the home page) becomes the remembered one
  watch(() => [route.query.start, route.query.end], ([d, f]) => {
    if (typeof d === 'string' && typeof f === 'string' && ISO.test(d) && ISO.test(f)
      && (d !== memoire.value.start || f !== memoire.value.end)) {
      memoire.value = { start: d, end: f }
      ecrire(memoire.value)
    }
  }, { immediate: true })

  const start = computed(() => memoire.value.start)
  const end = computed(() => memoire.value.end)

  function choisir(nouveauDebut: string, nouvelleFin: string) {
    memoire.value = { start: nouveauDebut, end: nouvelleFin }
    ecrire(memoire.value)
    router.replace({ query: { ...route.query, start: nouveauDebut, end: nouvelleFin } })
  }

  const year = (a: number) => choisir(`${a}-01-01`, `${a}-12-31`)

  return { start, end, choisir, year }
}

import { definePreset } from '@openvue/themes'
import Aura from '@openvue/themes/aura'
import '@openvue/openicons/openicons.css'
import OpenVue from 'openvue/config'
import ConfirmationService from 'openvue/confirmationservice'
import ToastService from 'openvue/toastservice'
import type { App } from 'vue'

// OpenVue (MIT fork of PrimeVue 4.5.5), for the menu and the Banque screen: the Aura theme with the blue of the
// application as primary colour, light only, texts in French; confirmations (ConfirmDialog) and messages (Toast).

const Colibri = definePreset(Aura, {
  semantic: {
    primary: Object.fromEntries([50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((n) => [n, `{blue.${n}}`])),
  },
})

export function installerOpenVue(app: App) {
  app.use(OpenVue, {
    theme: { preset: Colibri, options: { darkModeSelector: false } },
    locale: {
      accept: 'Oui', reject: 'Non', cancel: 'Annuler', emptyMessage: 'Aucun résultat', emptySearchMessage: 'Aucun résultat',
      emptyFilterMessage: 'Aucun résultat',
    },
  })
  app.use(ConfirmationService)
  app.use(ToastService)
}

<script setup lang="ts">
import Menu from 'openvue/menu'
import Menubar from 'openvue/menubar'
import type { MenuItem } from 'openvue/menuitem'
import { computed, onMounted, ref } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'

import { api } from './api'
import { useImmeuble } from './immeuble'

const { buildings, immeubleId } = useImmeuble()
const route = useRoute()

// The menu follows the cycle of an exercise (OpenVue Menubar): one group per step, its screens in a sub-menu; the
// screens set once (buildings, company, providers) sit in « Réglages », at the right of the bar
type Entree = { label: string, icon: string, route?: string, items?: Entree[] }
const GROUPES: { label: string, icon: string, items: Entree[] }[] = [
  {
    label: 'Tenue des comptes', icon: 'oi oi-wallet', items: [
      { label: 'Factures', icon: 'oi oi-file', route: '/factures' },
      { label: 'Paiements', icon: 'oi oi-euro', route: '/paiements' },
      { label: 'Travaux', icon: 'oi oi-hammer', route: '/travaux' },
      {
        label: 'Banque', icon: 'oi oi-building-columns', items: [
          { label: 'Relevés bancaires', icon: 'oi oi-file-import', route: '/banque/releves' },
          { label: 'Catégorisation des mouvements', icon: 'oi oi-tags', route: '/banque' },
        ],
      },
      { label: 'Locataires', icon: 'oi oi-users', route: '/sejours' },
    ],
  },
  {
    label: 'Bilan de l\'exercice', icon: 'oi oi-chart-bar', items: [
      { label: 'Contrôles', icon: 'oi oi-check-square', route: '/controles' },
      { label: 'Décompte', icon: 'oi oi-calculator', route: '/decompte' },
      { label: 'Régularisations', icon: 'oi oi-receipt', route: '/regularisations' },
    ],
  },
  {
    label: 'Clôture', icon: 'oi oi-book', items: [
      { label: 'Synthèse fiscale', icon: 'oi oi-percentage', route: '/fiscal' },
      { label: 'Assemblées', icon: 'oi oi-briefcase', route: '/assemblees' },
    ],
  },
]
const REGLAGES: Entree[] = [
  { label: 'Immeuble', icon: 'oi oi-building', route: '/immeuble' },
  { label: 'Société et associés', icon: 'oi oi-address-book', route: '/societe' },
  { label: 'Fournisseurs', icon: 'oi oi-cog', route: '/fournisseurs' },
  { label: 'Mon compte', icon: 'oi oi-user', route: '/compte' },
]

// The current screen: the most precise route of the menu the path starts with (/banque/releves is not /banque)
const routes = (entrees: Entree[]): string[] => entrees.flatMap((e) => [...(e.route ? [e.route] : []), ...routes(e.items ?? [])])
const TOUTES = ['/', ...routes(GROUPES.flatMap((g) => g.items)), '/immeuble', '/societe', '/fournisseurs']
const current = computed(() => TOUTES
  .filter((r) => (r === '/' ? route.path === '/' : route.path === r || route.path.startsWith(`${r}/`)))
  .sort((a, b) => b.length - a.length)[0] ?? null)
const actif = (r: string) => current.value === r
const contientActif = (e: Entree): boolean => (e.route ? actif(e.route) : false) || (e.items ?? []).some(contientActif)

// The current screen and the groups that hold it are shown as active
const element = (e: Entree): MenuItem => ({
  ...e, class: { actif: contientActif(e) }, items: e.items?.map(element),
})
const menu = computed<MenuItem[]>(() => [
  { label: 'Accueil', icon: 'oi oi-home', route: '/', class: { actif: actif('/') } },
  ...GROUPES.map((g) => element({ label: g.label, icon: g.icon, items: g.items })),
])

/**
 * A sub-menu (Banque) opens when hovered: the click that follows must not close it again. Without hover (touch screen),
 * the click still opens it.
 */
function garderOuvert(event: MouseEvent, root: boolean) {
  const element = (event.currentTarget as HTMLElement).closest('li')
  if (!root && element?.getAttribute('aria-expanded') === 'true') {
    event.stopPropagation()
  }
}

// The version of colibri-rent-book running, at the bottom of « Réglages » (linked to GitHub: the release of a version
// X.Y.Z, otherwise the commit); « dev » in development
const version = ref<string | null>(null)
const versionUrl = (v: string) => /^\d+\.\d+\.\d+$/.test(v)
  ? `https://github.com/mauvaisetroupe/colibri-rent-book/releases/tag/v${v}`
  : `https://github.com/mauvaisetroupe/colibri-rent-book/commit/${v}`
onMounted(async () => {
  version.value = (await api.sante().catch(() => null))?.version ?? null
})

const settings = ref<InstanceType<typeof Menu> | null>(null)
const menuReglages = computed<MenuItem[]>(() => [
  ...REGLAGES.map((r) => ({ ...r, class: { actif: actif(r.route!) } })),
  { separator: true },
  version.value && version.value !== 'dev'
    ? { label: `version ${version.value}`, icon: 'oi oi-github', url: versionUrl(version.value), target: '_blank', class: 'version' }
    : { label: 'version de développement', disabled: true, class: 'version' },
])
const reglageActif = computed(() => REGLAGES.some((r) => actif(r.route!)))
</script>

<template>
  <header v-if="!route.meta.publique" class="barre">
    <Menubar :model="menu" class="menu">
      <template #start>
        <RouterLink to="/" class="marque" title="Accueil">
          <svg viewBox="0 0 40 32" aria-hidden="true" class="marque-logo">
            <path d="M1 10.5 L10.5 12.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            <circle cx="12.8" cy="12.2" r="2.9" fill="currentColor" />
            <path d="M11 14 C13 19.5 19.5 22.5 25.5 22.5 L33.5 30 L31 23.5 L36 25 L28.5 20 C25.5 16 20 13 15 11.2 Z" fill="currentColor" />
            <path d="M15.5 11.6 C17.5 6 23 1.8 31.5 0.8 C28.5 5 24.5 10 19.5 14.5 Z" fill="currentColor" opacity="0.5" />
          </svg>
          <span class="marque-texte">Colibri<small>rent book</small></span>
        </RouterLink>
      </template>

      <!-- Each entry is a link of the router; a group opens its sub-menu -->
      <template #item="{ item, props, hasSubmenu, root }">
        <RouterLink v-if="item.route" v-slot="{ href, navigate }" :to="item.route" custom>
          <a :href="href" v-bind="props.action" @click="navigate">
            <span :class="item.icon" />
            <span>{{ item.label }}</span>
          </a>
        </RouterLink>
        <a v-else v-bind="props.action" @click="garderOuvert($event, root)">
          <span :class="item.icon" />
          <span>{{ item.label }}</span>
          <span v-if="hasSubmenu" :class="root ? 'oi oi-angle-down' : 'oi oi-angle-right'" class="fleche" />
        </a>
      </template>

      <template #end>
        <div class="droite">
          <select v-if="buildings.length > 1" v-model="immeubleId" class="choix-immeuble" aria-label="Immeuble">
            <option v-for="i in buildings" :key="i.id" :value="i.id">{{ i.name }}</option>
          </select>
          <button
            type="button" class="reglages-bouton" :class="{ actif: reglageActif }" aria-haspopup="true"
            @click="settings?.toggle($event)"
          ><span class="oi oi-cog" /><span class="reglages-texte"> Réglages</span> <span class="oi oi-angle-down" /></button>
          <Menu ref="reglages" :model="menuReglages" :popup="true">
            <template #item="{ item, props }">
              <RouterLink v-if="item.route" v-slot="{ href, navigate }" :to="item.route" custom>
                <a :href="href" v-bind="props.action" @click="navigate">
                  <span :class="item.icon" />
                  <span>{{ item.label }}</span>
                </a>
              </RouterLink>
              <a v-else v-bind="props.action" :href="item.url" :target="item.target">
                <span :class="item.icon" />
                <span>{{ item.label }}</span>
              </a>
            </template>
          </Menu>
        </div>
      </template>
    </Menubar>
  </header>
  <main>
    <RouterView />
  </main>
</template>

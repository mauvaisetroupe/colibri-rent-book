import { createRouter, createWebHistory } from 'vue-router'

import AccueilView from './views/AccueilView.vue'
import ControlesView from './views/ControlesView.vue'
import DecompteView from './views/DecompteView.vue'
import FacturesView from './views/FacturesView.vue'
import FactureView from './views/FactureView.vue'
import FiscalView from './views/FiscalView.vue'
import ImmeubleView from './views/ImmeubleView.vue'
import NouvelleRegularisationView from './views/NouvelleRegularisationView.vue'
import PaiementsView from './views/PaiementsView.vue'
import ProvisionsView from './views/ProvisionsView.vue'
import RegularisationsView from './views/RegularisationsView.vue'
import RegularisationView from './views/RegularisationView.vue'
import SejoursView from './views/SejoursView.vue'

export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'accueil', component: AccueilView },
    { path: '/factures', name: 'factures', component: FacturesView },
    { path: '/factures/:id', name: 'facture', component: FactureView, props: (route) => ({ id: Number(route.params.id) }) },
    { path: '/controles', name: 'controles', component: ControlesView },
    // Former name of the checks screen
    { path: '/couverture', redirect: (to) => ({ path: '/controles', query: to.query }) },
    { path: '/decompte', name: 'decompte', component: DecompteView },
    { path: '/regularisations', name: 'regularisations', component: RegularisationsView },
    { path: '/regularisations/nouvelle', name: 'nouvelle-regularisation', component: NouvelleRegularisationView },
    {
      path: '/regularisations/:id(\\d+)', name: 'regularisation', component: RegularisationView,
      props: (route) => ({ id: Number(route.params.id) }),
    },
    { path: '/sejours', name: 'sejours', component: SejoursView },
    { path: '/paiements', name: 'paiements', component: PaiementsView },
    { path: '/travaux', name: 'travaux', component: () => import('./views/TravauxView.vue') },
    { path: '/societe', name: 'societe', component: () => import('./views/SocieteView.vue') },
    { path: '/assemblees', name: 'assemblees', component: () => import('./views/AssembleesView.vue') },
    {
      path: '/assemblees/:id(\\d+)', name: 'assemblee', component: () => import('./views/AssembleeView.vue'),
      props: (route) => ({ id: Number(route.params.id) }),
    },
    { path: '/fiscal', name: 'fiscal', component: FiscalView },
    { path: '/provisions', name: 'provisions', component: ProvisionsView },
    { path: '/immeuble', name: 'immeuble', component: ImmeubleView },
    // Monaco is loaded with the edit screen only
    { path: '/fournisseurs', name: 'fournisseurs', component: () => import('./views/FournisseursView.vue') },
    {
      path: '/fournisseurs/:id(\\d+)', name: 'fournisseur', component: () => import('./views/FournisseurView.vue'),
      props: (route) => ({ id: Number(route.params.id) }),
    },
    // Former list of the extractors: now on the suppliers
    { path: '/extracteurs', redirect: '/fournisseurs' },
    { path: '/banque', name: 'banque', component: () => import('./views/BanqueView.vue') },
    { path: '/banque/releves', name: 'releves', component: () => import('./views/RelevesView.vue') },
    {
      path: '/banque/releves/:id(\\d+)', name: 'releve', component: () => import('./views/ReleveView.vue'),
      props: (route) => ({ id: Number(route.params.id) }),
    },
    {
      path: '/extracteurs-releve/nouveau', name: 'nouvel-extracteur-releve',
      component: () => import('./views/ExtracteurReleveView.vue'), props: { id: null },
    },
    {
      path: '/extracteurs-releve/:id(\\d+)', name: 'extracteur-releve', component: () => import('./views/ExtracteurReleveView.vue'),
      props: (route) => ({ id: Number(route.params.id) }),
    },
    {
      path: '/extracteurs/nouveau', name: 'nouvel-extracteur', component: () => import('./views/ExtracteurView.vue'),
      props: { id: null },
    },
    {
      path: '/extracteurs/:id(\\d+)', name: 'extracteur', component: () => import('./views/ExtracteurView.vue'),
      props: (route) => ({ id: Number(route.params.id) }),
    },
  ],
})

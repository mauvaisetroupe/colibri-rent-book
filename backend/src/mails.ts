import Big from 'big.js'

import { euros, frenchDate, monthYear } from './format.js'

// Mail texts (SPEC § 8): standard regularisation and corrective one. Opened in the mail client by the screen, never
// sent automatically; the user can edit everything before sending.

export type RegulMail = {
  lot: string
  debut: string
  fin: string
  present_du: string | null
  present_au: string | null
  montant_du: string
  provisions: string
  solde: string
  date_envoi: string | null
  montant_recu: string
}

export type MailOptions = {
  // Number of monthly instalments offered for an amount due (1: no instalments)
  etalement: number
  // Proposed new monthly provision, decimal string; null: no proposal
  provision_mensuelle: string | null
  // First month of the new provision, ISO date (1st of the month)
  provision_a_partir_du: string | null
  signature: string
}

export type Mail = { objet: string, corps: string }

/** Monthly provision that would have covered the charges: charges per day × 365 ÷ 12, rounded up to 5 €. */
export function suggestionProvision(total: string, jours: number): string | null {
  if (jours <= 0 || new Big(total).lte(0)) {
    return null
  }
  return new Big(total).div(jours).times(365).div(12).div(5).round(0, Big.roundUp).times(5).toString()
}

/** « en 3 mensualités de 200,00 € (la dernière de 200,01 €) »: cents go to the last instalment. */
export function mensualites(montant: Big, nombre: number): string {
  const n = Math.max(1, Math.trunc(nombre))
  const mensualite = montant.div(n).round(2, Big.roundDown)
  const derniere = montant.minus(mensualite.times(n - 1))
  return derniere.eq(mensualite)
    ? `en ${n} mensualités de ${euros(mensualite)}`
    : `en ${n} mensualités de ${euros(mensualite)} (la dernière de ${euros(derniere)})`
}

const periode = (r: RegulMail) => {
  const base = `du ${frenchDate(r.debut)} au ${frenchDate(r.fin)}`
  const partielle = r.present_du && r.present_au && (r.present_du !== r.debut || r.present_au !== r.fin)
  return partielle ? `${base} (votre présence : du ${frenchDate(r.present_du!)} au ${frenchDate(r.present_au!)})` : base
}

function suite(reste: Big, options: MailOptions): string[] {
  const lignes: string[] = []
  if (reste.gt(0) && options.etalement > 1) {
    lignes.push(`Si cela vous arrange, vous pouvez régler ce montant ${mensualites(reste, options.etalement)}, `
      + 'en même temps que vos prochains loyers.', '')
  }
  if (options.provision_mensuelle && options.provision_a_partir_du) {
    lignes.push('Pour éviter une régularisation importante l\'an prochain, je vous propose de porter la provision '
      + `mensuelle sur charges à ${euros(options.provision_mensuelle)} à partir de ${monthYear(options.provision_a_partir_du)}.`, '')
  }
  return lignes
}

const conclusion = (reste: Big) =>
  (reste.gt(0)
    ? `Solde restant à régler : ${euros(reste)}.`
    : reste.lt(0)
      ? `Trop-perçu en votre faveur : ${euros(reste.abs())}. Je vous le rembourse par virement, ou en déduction de votre `
        + 'prochain loyer si vous le préférez.'
      : 'Vos provisions couvrent exactement vos charges : il n\'y a rien à régler.')

export function mailRegularisation(r: RegulMail, options: MailOptions): Mail {
  const solde = new Big(r.solde)
  const corps = [
    'Bonjour,',
    '',
    `Voici la régularisation des charges de votre logement (${r.lot}) pour la période ${periode(r)}.`,
    '',
    `Charges réelles (votre quote-part) : ${euros(r.montant_du)}`,
    `Provisions versées : ${euros(r.provisions)}`,
    conclusion(solde),
    '',
    'Le détail du calcul (factures, périodes, répartition au tantième) figure dans le justificatif joint.',
    '',
    ...suite(solde, options),
    'Je reste à votre disposition pour toute question.',
    '',
    'Bien cordialement,',
    options.signature,
  ]
  return { objet: `Régularisation des charges du ${frenchDate(r.debut)} au ${frenchDate(r.fin)}`, corps: corps.join('\n') }
}

export function mailRectificatif(ancienne: RegulMail, nouvelle: RegulMail, options: MailOptions): Mail {
  // Payments already received, on the previous regularisation(s) or on this one
  const recu = new Big(nouvelle.montant_recu)
  const reste = new Big(nouvelle.solde).minus(recu)
  const envoi = ancienne.date_envoi ? ` que je vous ai adressée le ${frenchDate(ancienne.date_envoi)}` : ''
  const corps = [
    'Bonjour,',
    '',
    `Je reviens vers vous au sujet de la régularisation des charges de la période ${periode(nouvelle)}${envoi}. `
      + 'En reprenant le calcul, j\'ai constaté une erreur : je vous prie de bien vouloir m\'en excuser.',
    '',
    `Montant initialement demandé : ${euros(ancienne.solde)}`,
    `Montant corrigé : ${euros(nouvelle.solde)} (charges ${euros(nouvelle.montant_du)}, provisions versées ${euros(nouvelle.provisions)})`,
    ...(recu.gt(0) ? [`Versements déjà effectués au titre de cette régularisation : ${euros(recu)}`] : []),
    conclusion(reste),
    '',
    'Le justificatif corrigé, avec le détail des factures et des périodes, est joint à ce message.',
    '',
    ...suite(reste, options),
    'Je reste à votre disposition pour en parler.',
    '',
    'Bien cordialement,',
    options.signature,
  ]
  return {
    objet: `Rectificatif – régularisation des charges du ${frenchDate(nouvelle.debut)} au ${frenchDate(nouvelle.fin)}`,
    corps: corps.join('\n'),
  }
}

import Big from 'big.js'

import { euros, frenchDate, monthYear } from './format.js'

// Mail texts (SPEC § 8): standard regularisation and corrective one. Opened in the mail client by the screen, never
// sent automatically; the user can edit everything before sending.

export type RegulMail = {
  unit: string
  start: string
  end: string
  present_from: string | null
  present_to: string | null
  amount_due: string
  advances: string
  balance: string
  sent_on: string | null
  amount_received: string
}

export type MailOptions = {
  // Number of monthly instalments offered for an amount due (1: no instalments)
  etalement: number
  // Proposed new monthly provision, decimal string; null: no proposal
  monthly_charge_advance: string | null
  // First month of the new provision, ISO date (1st of the month)
  charge_advance_from: string | null
  signature: string
}

export type Mail = { objet: string, corps: string }

/** Monthly provision that would have covered the charges: charges per day × 365 ÷ 12, rounded up to 5 €. */
export function suggestionProvision(total: string, days: number): string | null {
  if (days <= 0 || new Big(total).lte(0)) {
    return null
  }
  return new Big(total).div(days).times(365).div(12).div(5).round(0, Big.roundUp).times(5).toString()
}

/** « en 3 mensualités de 200,00 € (la dernière de 200,01 €) »: cents go to the last instalment. */
export function mensualites(amount: Big, nombre: number): string {
  const n = Math.max(1, Math.trunc(nombre))
  const mensualite = amount.div(n).round(2, Big.roundDown)
  const latest = amount.minus(mensualite.times(n - 1))
  return latest.eq(mensualite)
    ? `en ${n} mensualités de ${euros(mensualite)}`
    : `en ${n} mensualités de ${euros(mensualite)} (la dernière de ${euros(latest)})`
}

const period = (r: RegulMail) => {
  const base = `du ${frenchDate(r.start)} au ${frenchDate(r.end)}`
  const partielle = r.present_from && r.present_to && (r.present_from !== r.start || r.present_to !== r.end)
  return partielle ? `${base} (votre présence : du ${frenchDate(r.present_from!)} au ${frenchDate(r.present_to!)})` : base
}

function suite(remaining: Big, options: MailOptions): string[] {
  const lines: string[] = []
  if (remaining.gt(0) && options.etalement > 1) {
    lines.push(`Si cela vous arrange, vous pouvez régler ce montant ${mensualites(remaining, options.etalement)}, `
      + 'en même temps que vos prochains loyers.', '')
  }
  if (options.monthly_charge_advance && options.charge_advance_from) {
    lines.push('Pour éviter une régularisation importante l\'an prochain, je vous propose de porter la provision '
      + `mensuelle sur charges à ${euros(options.monthly_charge_advance)} à partir de ${monthYear(options.charge_advance_from)}.`, '')
  }
  return lines
}

const conclusion = (remaining: Big) =>
  (remaining.gt(0)
    ? `Solde restant à régler : ${euros(remaining)}.`
    : remaining.lt(0)
      ? `Trop-perçu en votre faveur : ${euros(remaining.abs())}. Je vous le rembourse par virement, ou en déduction de votre `
        + 'prochain loyer si vous le préférez.'
      : 'Vos provisions couvrent exactement vos charges : il n\'y a rien à régler.')

export function mailRegularisation(r: RegulMail, options: MailOptions): Mail {
  const balance = new Big(r.balance)
  const corps = [
    'Bonjour,',
    '',
    `Voici la régularisation des charges de votre logement (${r.unit}) pour la période ${period(r)}.`,
    '',
    `Charges réelles (votre quote-part) : ${euros(r.amount_due)}`,
    `Provisions versées : ${euros(r.advances)}`,
    conclusion(balance),
    '',
    'Le détail du calcul (factures, périodes, répartition au tantième) figure dans le justificatif joint.',
    '',
    ...suite(balance, options),
    'Je reste à votre disposition pour toute question.',
    '',
    'Bien cordialement,',
    options.signature,
  ]
  return { objet: `Régularisation des charges du ${frenchDate(r.start)} au ${frenchDate(r.end)}`, corps: corps.join('\n') }
}

export function mailRectificatif(ancienne: RegulMail, nouvelle: RegulMail, options: MailOptions): Mail {
  // Payments already received, on the previous regularisation(s) or on this one
  const recu = new Big(nouvelle.amount_received)
  const remaining = new Big(nouvelle.balance).minus(recu)
  const envoi = ancienne.sent_on ? ` que je vous ai adressée le ${frenchDate(ancienne.sent_on)}` : ''
  const corps = [
    'Bonjour,',
    '',
    `Je reviens vers vous au sujet de la régularisation des charges de la période ${period(nouvelle)}${envoi}. `
      + 'En reprenant le calcul, j\'ai constaté une erreur : je vous prie de bien vouloir m\'en excuser.',
    '',
    `Montant initialement demandé : ${euros(ancienne.balance)}`,
    `Montant corrigé : ${euros(nouvelle.balance)} (charges ${euros(nouvelle.amount_due)}, provisions versées ${euros(nouvelle.advances)})`,
    ...(recu.gt(0) ? [`Versements déjà effectués au titre de cette régularisation : ${euros(recu)}`] : []),
    conclusion(remaining),
    '',
    'Le justificatif corrigé, avec le détail des factures et des périodes, est joint à ce message.',
    '',
    ...suite(remaining, options),
    'Je reste à votre disposition pour en parler.',
    '',
    'Bien cordialement,',
    options.signature,
  ]
  return {
    objet: `Rectificatif – régularisation des charges du ${frenchDate(nouvelle.start)} au ${frenchDate(nouvelle.end)}`,
    corps: corps.join('\n'),
  }
}

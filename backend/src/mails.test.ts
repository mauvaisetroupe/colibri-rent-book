import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import Big from 'big.js'

import { mailRectificatif, mailRegularisation, mensualites, suggestionProvision, type RegulMail } from './mails.js'

const regul = (overrides: Partial<RegulMail>): RegulMail => ({
  lot: 'Lot 1', debut: '2024-01-01', fin: '2025-12-31', present_du: '2024-01-01', present_au: '2025-12-31',
  montant_du: '5533.95', provisions: '3800', solde: '1733.95', date_envoi: null, montant_recu: '0',
  ...overrides,
})

const options = { etalement: 1, provision_mensuelle: null, provision_a_partir_du: null, signature: 'La gérance' }
const flat = (text: string) => text.replace(/[  ]/g, ' ')

describe('mails', () => {
  test('instalments put the cents on the last one', () => {
    assert.equal(flat(mensualites(new Big('600'), 3)), 'en 3 mensualités de 200,00 €')
    assert.equal(flat(mensualites(new Big('1733.95'), 4)), 'en 4 mensualités de 433,48 € (la dernière de 433,51 €)')
  })

  test('the suggested monthly provision covers the charges, rounded up to 5 €', () => {
    // 5533.95 € over 731 days → 230.42 € a month → 235 €
    assert.equal(suggestionProvision('5533.95', 731), '235')
    assert.equal(suggestionProvision('0', 731), null)
  })

  test('standard mail: amounts, instalments and new provision', () => {
    const mail = mailRegularisation(regul({}), {
      ...options, etalement: 3, provision_mensuelle: '235', provision_a_partir_du: '2026-11-01',
    })
    assert.equal(mail.objet, 'Régularisation des charges du 01/01/2024 au 31/12/2025')
    const corps = flat(mail.corps)
    assert.match(corps, /Charges réelles \(votre quote-part\) : 5 533,95 €/)
    assert.match(corps, /Provisions versées : 3 800,00 €/)
    assert.match(corps, /Solde restant à régler : 1 733,95 €\./)
    assert.match(corps, /en 3 mensualités de 577,98 € \(la dernière de 577,99 €\)/)
    assert.match(corps, /provision mensuelle sur charges à 235,00 € à partir de novembre 2026/)
    assert.ok(corps.endsWith('La gérance'))
  })

  test('a negative balance is a refund, no instalments offered', () => {
    const corps = flat(mailRegularisation(regul({ solde: '-99.53', present_du: '2025-06-16', present_au: '2025-08-16' }),
      { ...options, etalement: 3 }).corps)
    assert.match(corps, /Trop-perçu en votre faveur : 99,53 €/)
    assert.match(corps, /votre présence : du 16\/06\/2025 au 16\/08\/2025/)
    assert.doesNotMatch(corps, /mensualités/)
  })

  test('corrective mail: apology, initial and corrected amounts, payments already made', () => {
    const before = regul({ solde: '2046', montant_du: '5846', date_envoi: '2026-07-01', montant_recu: '2046' })
    const mail = mailRectificatif(before, regul({ montant_recu: '2046' }), options)
    assert.equal(mail.objet, 'Rectificatif – régularisation des charges du 01/01/2024 au 31/12/2025')
    const corps = flat(mail.corps)
    assert.match(corps, /que je vous ai adressée le 01\/07\/2026/)
    assert.match(corps, /je vous prie de bien vouloir m'en excuser/)
    assert.match(corps, /Montant initialement demandé : 2 046,00 €/)
    assert.match(corps, /Montant corrigé : 1 733,95 €/)
    assert.match(corps, /Versements déjà effectués au titre de cette régularisation : 2 046,00 €/)
    assert.match(corps, /Trop-perçu en votre faveur : 312,05 €/)
  })
})

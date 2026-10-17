import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, test } from 'node:test'

import { PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import ts from 'typescript'

import { compiler } from './compilation'
import { REGLAGES_PAR_DEFAUT } from './contrat'
import { charger, documentDe, energieDe, extraire, reconnait } from './moteur'
import { morceaux } from './pdf'
import { surligner } from './surlignage'

// The extraction engine (ADR 0013) on a made-up invoice: the template of a new supplier (modeles/modele.ts), compiled
// and run as in the browser. The real invoices of an operation are tested with its own data.

/** A one-page PDF: each row is [x, text] pieces on a line, from the top. */
async function facture(lignes: [number, string][][]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([595, 842])
  const police = await pdf.embedFont(StandardFonts.Helvetica)
  lignes.forEach((ligne, i) => {
    for (const [x, texte] of ligne) {
      page.drawText(texte, { x, y: 800 - i * 16, size: 10, font: police })
    }
  })
  return pdf.save()
}

const FACTURE: [number, string][][] = [
  [[40, 'NOM DU FOURNISSEUR']],
  [[40, 'Facture n° F-2026-001']],
  [[40, 'Date de la facture : 15/03/2026']],
  [[40, 'Détail']],
  [[40, 'Consommation'], [200, 'du 01/01/2026 au 28/02/2026'], [450, '120,50 €']],
  [[40, 'Abonnement'], [200, 'du 01/01/2026 au 31/03/2026'], [450, '30,00 €']],
  [[40, 'Location compteur'], [200, 'du 01/01/2026 au 31/03/2026'], [450, 'gratuit']],
  [[40, 'Total TTC'], [450, '150,50 €']],
]

const documentDuPdf = async (pdf: Uint8Array) =>
  documentDe(await morceaux(await getDocument({ data: pdf, verbosity: 0 }).promise), REGLAGES_PAR_DEFAUT)

const modele = charger(compiler(await readFile(new URL('modeles/modele.ts', import.meta.url), 'utf8'), ts))

describe('extraction engine on a made-up invoice', () => {
  test('pieces grouped into lines, a change of column written as three spaces', async () => {
    const document = await documentDuPdf(await facture(FACTURE))
    assert.equal(document.lines[4], 'Consommation   du 01/01/2026 au 28/02/2026   120,50 €')
    assert.equal(document.pages.length, 1)
  })

  test('the template reads the header and the invoice lines, the lines add up to the total', async () => {
    const document = await documentDuPdf(await facture(FACTURE))
    assert.equal(energieDe(modele), 'eau')
    assert.ok(reconnait(modele, document))
    const lue = extraire(modele, document)
    assert.deepEqual([lue.numero.valeur, lue.date.valeur, lue.total.valeur], ['F-2026-001', '2026-03-15', '150.5'])
    assert.deepEqual(lue.lignes.valeur!.map((l) => [l.categorie, l.libelle, l.debut, l.fin, l.montant_ttc, l.affectation]), [
      ['consommation', 'Consommation', '2026-01-01', '2026-02-28', '120.5', 'recuperable'],
      ['abonnement', 'Abonnement', '2026-01-01', '2026-03-31', '30', 'recuperable'],
    ])
    // « gratuit » is no amount: the line is not an invoice line for the template
    assert.deepEqual(lue.lignesEnErreur, [])
    assert.deepEqual(lue.trouvees, [4, 5])
  })

  test('a line found but not read is marked, the others are still read', async () => {
    const document = await documentDuPdf(await facture([
      ...FACTURE.slice(0, 4),
      [[40, 'Consommation'], [200, 'du 01/01/2026 au 31/02/2026'], [450, '120,50 €']],
      ...FACTURE.slice(5),
    ]))
    const source = (await readFile(new URL('modeles/modele.ts', import.meta.url), 'utf8'))
      .replace('end: this.frenchDate(end),', 'end: end === \'31/02/2026\' ? this.frenchDate(\'\') : this.frenchDate(end),')
    const lue = extraire(charger(compiler(source, ts)), document)
    assert.equal(lue.lignesEnErreur.length, 1)
    assert.equal(lue.lignesEnErreur[0]!.position, 4)
    assert.equal(lue.lignes.valeur!.length, 1)
    assert.equal(lue.lignes.erreur, '1 ligne(s) trouvée(s) mais non lue(s)')
    assert.match(surligner(document, [], { enErreur: lue.lignesEnErreur })[4]!.erreur!, /frenchDate/)
  })

  test('a document a template does not recognise', async () => {
    const document = await documentDuPdf(await facture([[[40, 'AUTRE FOURNISSEUR']]]))
    assert.equal(reconnait(modele, document), false)
  })
})

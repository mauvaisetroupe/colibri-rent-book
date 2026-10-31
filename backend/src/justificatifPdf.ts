import Big from 'big.js'
import { PDFDocument } from 'pdf-lib'
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js'

import { euros, frenchDate } from './format.js'
import type { Justificatif } from './justificatif.js'
import pdfmake from './pdfmake.js'

// PDF of the supporting document (SPEC § 8, ADR 0007, 0014): the statement of the tenant composed with pdfmake, a page
// « Annexes » listing the invoices taken into account, then the PDFs of the invoices joined, put together with
// pdf-lib. No browser. The invoices are joined as their version in images, redacted (ADR 0024).

const ENERGIES: Record<string, string> = {
  gas: 'Gaz', electricity: 'Électricité', water: 'Eau', household_waste: 'Ordures ménagères',
}

const GRIS = '#57606a'
const BORD = '#d0d7de'

export type Entete = {
  // « Régularisation du 12/10/2026 », « Rectificatif » or nothing for a preview
  title?: string
  remarque?: string
  // Shown first and framed in red: this document does not match what was sent
  alerte?: string
}

/** An invoice of the supporting document and what becomes of it in the annexes. */
export type Annexe = {
  invoice_id: number
  // The PDF of the invoice, to join; null: not joined, for the reason given
  pdf: Uint8Array | null
  raison: Raison | null
}

type Raison = 'confidential' | 'no_pdf' | 'unreadable' | 'unchecked'

const RAISONS: Record<Raison, string> = {
  confidential: 'Non jointe : document confidentiel (données fiscales du propriétaire), consultable sur demande',
  no_pdf: 'Non jointe : facture sans PDF (reçue sur papier), consultable sur demande',
  unreadable: 'Non jointe : PDF illisible, consultable sur demande',
  unchecked: 'Non jointe, consultable sur demande',
}

const nomFacture = (f: Justificatif['invoices'][number]) =>
  f.number.startsWith(f.supplier) ? f.number : `${f.supplier} n° ${f.number}`

// Light table borders, like the former HTML page
const LIGNES = {
  hLineWidth: (i: number) => (i === 0 ? 0 : 0.5),
  vLineWidth: () => 0,
  hLineColor: () => BORD,
  paddingLeft: () => 5,
  paddingRight: () => 5,
  paddingTop: () => 3,
  paddingBottom: () => 3,
}

function encadre(text: string, couleur: string, fond: string, gras = false): Content {
  return {
    table: { widths: ['*'], body: [[{ text: text, bold: gras, fillColor: fond }]] },
    layout: { hLineColor: () => couleur, vLineColor: () => couleur, hLineWidth: () => 1, vLineWidth: () => 1 },
    margin: [0, 6, 0, 0],
  }
}

// `total`: pages of the whole PDF, invoices joined included (null: those of this document only)
function definition(j: Justificatif, entete: Entete, sorts: string[], total: number | null): TDocumentDefinitions {
  const s = j.tenancy
  const balance = new Big(j.balance).round(2, Big.roundHalfUp)
  const attendance = s.present_from && s.present_to
    ? `du ${frenchDate(s.present_from)} au ${frenchDate(s.present_to)} (${s.days} jours sur ${s.period_days})`
    : 'aucun jour sur cet exercice'
  const th = (text: string, alignment: 'left' | 'right' = 'left') => ({ text, bold: true, fillColor: '#eef2f6', alignment })
  const n = (text: string, bold = false) => ({ text, alignment: 'right' as const, bold, noWrap: true })

  return {
    pageSize: 'A4',
    pageMargins: [40, 45, 40, 45],
    defaultStyle: { font: 'Roboto', fontSize: 9.5, color: '#1f2328' },
    styles: {
      h1: { fontSize: 15, bold: true },
      h2: { fontSize: 11, bold: true, margin: [0, 14, 0, 4] },
      petit: { fontSize: 8, color: GRIS },
    },
    info: { title: `Décompte de charges – ${s.tenant}` },
    footer: (page: number, pages: number) => ({
      text: `${page} / ${total ?? pages}`, alignment: 'right', style: 'petit', margin: [0, 10, 40, 0],
    }),
    content: [
      {
        columns: [
          [
            { text: 'Décompte des charges locatives', style: 'h1' },
            { text: j.building.address ?? j.building.name, margin: [0, 3, 0, 0] },
            `Période du ${frenchDate(j.period.start)} au ${frenchDate(j.period.end)}`,
          ],
          {
            width: 'auto',
            alignment: 'right',
            stack: [
              ...(entete.title ? [{ text: entete.title, bold: true }] : []),
              { text: `Établi le ${frenchDate(j.generated_at)}`, color: GRIS },
            ],
          },
        ],
      },
      { canvas: [{ type: 'line', x1: 0, y1: 6, x2: 515, y2: 6, lineWidth: 0.7, lineColor: '#999999' }] },
      ...(entete.alerte ? [encadre(entete.alerte, '#cf222e', '#ffebe9', true)] : []),
      ...(entete.remarque ? [encadre(entete.remarque, '#d4a72c', '#fff8c5')] : []),

      { text: 'Locataire', style: 'h2' },
      {
        table: {
          widths: [150, '*'],
          body: [
            [th('Locataire'), s.tenant],
            [th('Logement'), `${s.unit}${s.unit_label ? ` – ${s.unit_label}` : ''}`],
            [th('Présence sur la période'), attendance],
            [th('Tantièmes du logement'), `${s.charge_shares} / ${j.building.total_charge_shares}`],
          ],
        },
        layout: LIGNES,
      },

      { text: 'Charges de l\'immeuble et votre quote-part', style: 'h2' },
      {
        text: 'Chaque ligne de facture est répartie selon les jours de sa période qui tombent pendant votre présence, '
          + 'puis selon vos tantièmes : quote-part = montant TTC × jours de présence sur la période de la ligne ÷ jours '
          + `de la ligne × ${s.charge_shares} ÷ ${j.building.total_charge_shares}. Les jours sans locataire restent à la charge `
          + 'du propriétaire.',
        style: 'petit',
        margin: [0, 0, 0, 4],
      },
      {
        table: {
          widths: ['*', 140, 100],
          body: [
            [th('Rubrique'), th('Dépenses de l\'immeuble sur la période', 'right'), th('Votre quote-part', 'right')],
            ...j.headings.map((r) => [r.label, n(euros(r.building_expenses)), n(euros(r.share))]),
            [{ text: 'Total de vos charges', bold: true }, '', n(euros(j.total), true)],
            ['Provisions sur charges versées', '', n(`− ${euros(j.advances)}`)],
          ],
        },
        layout: LIGNES,
      },
      {
        table: {
          widths: ['*', 'auto'],
          body: [[
            { text: balance.gt(0) ? 'Solde restant à votre charge' : balance.lt(0) ? 'Trop-perçu en votre faveur' : 'Solde', fontSize: 12 },
            { text: euros(balance.abs()), bold: true, fontSize: 12, alignment: 'right' },
          ]],
        },
        layout: { hLineColor: () => GRIS, vLineColor: () => GRIS, paddingTop: () => 6, paddingBottom: () => 6 },
        margin: [0, 10, 0, 0],
      },

      { text: 'Factures prises en compte', style: 'h2' },
      {
        table: {
          headerRows: 1,
          widths: [62, '*', 52, 105, 62, 55],
          body: [
            [th('Énergie'), th('Facture'), th('Date'), th('Période retenue'), th('Montant', 'right'), th('Votre part', 'right')],
            ...j.invoices.map((f) => [
              ENERGIES[f.energy] ?? f.energy, nomFacture(f), frenchDate(f.invoice_date),
              `${frenchDate(f.start)} – ${frenchDate(f.end)}`, n(f.invoice_amount ? euros(f.invoice_amount) : ''),
              n(euros(f.share)),
            ]),
          ],
        },
        layout: LIGNES,
        fontSize: 8,
      },
      {
        text: 'Montants arrondis au centime ; le total est calculé avant arrondi, d\'où un écart possible d\'un centime '
          + 'avec la somme des lignes. Les factures sont jointes en annexe, sauf celles signalées, tenues à votre '
          + 'disposition.',
        style: 'petit',
        margin: [0, 4, 0, 0],
      },

      { text: 'Annexes : factures', style: 'h1', pageBreak: 'before' },
      { text: `${j.building.address ?? j.building.name} – période du ${frenchDate(j.period.start)} au ${frenchDate(j.period.end)}`, margin: [0, 3, 0, 8] },
      {
        table: {
          headerRows: 1,
          widths: [62, '*', 52, 62, 160],
          body: [
            [th('Énergie'), th('Facture'), th('Date'), th('Montant', 'right'), th('Annexe')],
            ...j.invoices.map((f, i) => [
              ENERGIES[f.energy] ?? f.energy, nomFacture(f), frenchDate(f.invoice_date),
              n(f.invoice_amount ? euros(f.invoice_amount) : ''), { text: sorts[i] ?? '', fontSize: 8 },
            ]),
          ],
        },
        layout: LIGNES,
        fontSize: 8,
      },
      {
        text: 'Les factures jointes le sont en images : les données personnelles du bailleur (nom, adresse, références '
          + 'client, compte bancaire) y sont masquées. Les originaux sont consultables sur demande.',
        style: 'petit',
        margin: [0, 6, 0, 0],
      },
    ],
  }
}

const rendre = (j: Justificatif, entete: Entete, sorts: string[], total: number | null) =>
  pdfmake.createPdf(definition(j, entete, sorts, total)).getBuffer()

/**
 * The supporting document, its page « Annexes », then the PDFs of the invoices joined. `annexes`: one entry per
 * invoice of `j.factures` (by facture_id); an invoice missing from it is listed without PDF.
 */
export async function justificatifPdf(j: Justificatif, entete: Entete = {}, tenant_copies: Annexe[] = []): Promise<Buffer> {
  const parFacture = new Map(tenant_copies.map((a) => [a.invoice_id, a]))
  const jointes: { index: number, pdf: PDFDocument }[] = []
  for (const [index, f] of j.invoices.entries()) {
    const a = parFacture.get(f.invoice_id)
    if (a?.pdf) {
      try {
        jointes.push({ index, pdf: await PDFDocument.load(a.pdf, { ignoreEncryption: true }) })
      } catch {
        parFacture.set(f.invoice_id, { ...a, pdf: null, raison: 'unreadable' })
      }
    }
  }
  const raison = (index: number) => RAISONS[parFacture.get(j.invoices[index]!.invoice_id)?.raison ?? 'no_pdf']

  // First pass: the length of the document, to number the pages of the annexes; second pass with those numbers
  const sorts = (start: number) => {
    let page = start
    const pages = new Map(jointes.map(({ index, pdf }) => {
      const n = pdf.getPageCount()
      const text = n > 1 ? `Jointe, pages ${page} à ${page + n - 1}` : `Jointe, page ${page}`
      page += n
      return [index, text]
    }))
    return j.invoices.map((_, i) => pages.get(i) ?? raison(i))
  }
  const brouillon = await PDFDocument.load(await rendre(j, entete, sorts(1), null))
  const pagesJointes = jointes.reduce((n, { pdf }) => n + pdf.getPageCount(), 0)
  const document = await PDFDocument.load(await rendre(j, entete, sorts(brouillon.getPageCount() + 1),
    brouillon.getPageCount() + pagesJointes))

  for (const { pdf } of jointes) {
    for (const page of await document.copyPages(pdf, pdf.getPageIndices())) {
      document.addPage(page)
    }
  }
  return Buffer.from(await document.save())
}

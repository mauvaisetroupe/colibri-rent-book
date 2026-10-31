import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js'

import type { Assemblee, Societe } from './assemblees.js'
import { euros, frenchDate } from './format.js'
import pdfmake from './pdfmake.js'

// Minutes of a general meeting (ADR 0016), composed with pdfmake: the company, the meeting, presences and quorum,
// agenda, resolutions with the outcome of the vote, room for the signatures. A draft prints as a project.

const GRIS = '#57606a'
const TYPES = { ordinary: 'ordinaire', extraordinary: 'extraordinaire' }
const PRESENCES = { present: 'présent', represented: 'représenté', absent: 'absent' }

const pourcent = (shares: number, total: number) => (total ? `${Math.round((shares / total) * 10000) / 100} %` : '')

function vote(r: Assemblee['resolutions'][number], presentes: number): string {
  if (r.unanimite) {
    return 'Cette résolution est adoptée à l\'unanimité des associés présents ou représentés.'
  }
  const detail = `pour : ${r.votes_for} parts, contre : ${r.votes_against}, abstention : ${r.abstentions}, sur ${presentes} parts présentes ou représentées`
  return r.adoptee ? `Cette résolution est adoptée (${detail}).` : `Cette résolution est rejetée (${detail}).`
}

function definition(a: Assemblee, company: Societe | null): TDocumentDefinitions {
  const title = `Procès-verbal de l'assemblée générale ${TYPES[a.type]} du ${frenchDate(a.date)}`
  const presents = a.attendances.filter((p) => p.status !== 'absent')
  const entete: Content[] = company
    ? [
        { text: `${company.name}`, style: 'company' },
        { text: [company.legal_form, company.capital ? `au capital de ${euros(company.capital)}` : null].filter(Boolean).join(' ') },
        ...(company.registered_office ? [{ text: `Siège social : ${company.registered_office}` }] : []),
        ...(company.rcs ? [{ text: company.rcs }] : []),
      ]
    : [{ text: 'Société (fiche à compléter)', color: GRIS }]

  return {
    pageSize: 'A4',
    pageMargins: [50, 50, 50, 50],
    defaultStyle: { font: 'Roboto', fontSize: 10, color: '#1f2328', lineHeight: 1.2 },
    styles: {
      company: { fontSize: 13, bold: true },
      title: { fontSize: 14, bold: true, alignment: 'center', margin: [0, 18, 0, 4] },
      h2: { fontSize: 11, bold: true, margin: [0, 14, 0, 4] },
      petit: { fontSize: 8, color: GRIS },
    },
    info: { title: title },
    footer: (page: number, pages: number) => ({
      text: `${a.number ? `Registre n° ${a.number} – ` : ''}${page} / ${pages}`, alignment: 'right', style: 'petit', margin: [0, 15, 50, 0],
    }),
    ...(a.status === 'draft'
      ? { watermark: { text: 'PROJET', color: '#cf222e', opacity: 0.12, bold: true } }
      : {}),
    content: [
      ...entete,
      { text: title, style: 'title' },
      ...(a.status === 'draft'
        ? [{ text: 'Projet – assemblée non close', alignment: 'center' as const, color: '#cf222e', bold: true }]
        : [{ text: `Registre des décisions, procès-verbal n° ${a.number}`, alignment: 'center' as const, color: GRIS }]),
      {
        text: `Le ${frenchDate(a.date)}${a.time ? ` à ${a.time}` : ''}${a.place ? `, ${a.place}` : ''}, les associés de la société se `
          + `sont réunis en assemblée générale ${TYPES[a.type]}.`
          + (a.chair ? ` L'assemblée est présidée par ${a.chair}.` : ''),
        margin: [0, 14, 0, 0],
      },

      { text: 'Présences', style: 'h2' },
      {
        table: {
          widths: ['*', 60, 60, 150],
          body: [
            ['Associé', 'Parts', 'Part du capital', 'Présence'].map((t) => ({ text: t, bold: true })),
            ...a.attendances.map((p) => [
              `${p.name}${p.manager ? ' (gérant)' : ''}`, String(p.shares), pourcent(p.shares, a.total_shares),
              `${PRESENCES[p.status]}${p.status === 'represented' && p.represented_by ? ` par ${p.represented_by}` : ''}`,
            ]),
          ],
        },
        layout: 'lightHorizontalLines',
      },
      {
        text: `Associés présents ou représentés : ${presents.length} sur ${a.attendances.length}, détenant ${a.shares_present} parts sur `
          + `${a.total_shares} (${pourcent(a.shares_present, a.total_shares)}). L'assemblée peut valablement délibérer.`,
        margin: [0, 6, 0, 0],
      },

      { text: 'Ordre du jour', style: 'h2' },
      { text: a.agenda || '—' },

      { text: 'Résolutions', style: 'h2' },
      ...a.resolutions.flatMap((r): Content[] => [
        { text: `Résolution n° ${r.position} : ${r.title}`, bold: true, margin: [0, 8, 0, 2] },
        { text: r.text },
        { text: vote(r, a.shares_present), italics: true, margin: [0, 2, 0, 0] },
      ]),
      ...(a.remarks ? [{ text: 'Observations', style: 'h2' }, { text: a.remarks }] : []),

      // The closing words and the signatures on the same page
      {
        unbreakable: true,
        stack: [
          {
            text: 'L\'ordre du jour étant épuisé, la séance est levée. De tout ce qui précède, il a été dressé le présent '
              + 'procès-verbal, signé par le président de séance et les associés présents.',
            margin: [0, 16, 0, 0],
          },
          {
            margin: [0, 24, 0, 40],
            columns: [
              { stack: [{ text: 'Le président de séance', bold: true }, a.chair ?? ''], width: '*' },
              { stack: [{ text: 'Les associés', bold: true }, ...presents.map((p) => p.name)], width: '*' },
            ],
          },
        ],
      },
    ],
  }
}

export const pvPdf = async (a: Assemblee, company: Societe | null) =>
  Buffer.from(await pdfmake.createPdf(definition(a, company)).getBuffer())

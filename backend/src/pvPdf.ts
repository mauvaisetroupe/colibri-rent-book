import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js'

import type { Assemblee, Societe } from './assemblees.js'
import { euros, frenchDate } from './format.js'
import pdfmake from './pdfmake.js'

// Minutes of a general meeting (ADR 0016), composed with pdfmake: the company, the meeting, presences and quorum,
// agenda, resolutions with the outcome of the vote, room for the signatures. A draft prints as a project.

const GRIS = '#57606a'
const TYPES = { ordinaire: 'ordinaire', extraordinaire: 'extraordinaire' }
const PRESENCES = { present: 'présent', represente: 'représenté', absent: 'absent' }

const pourcent = (parts: number, total: number) => (total ? `${Math.round((parts / total) * 10000) / 100} %` : '')

function vote(r: Assemblee['resolutions'][number], presentes: number): string {
  if (r.unanimite) {
    return 'Cette résolution est adoptée à l\'unanimité des associés présents ou représentés.'
  }
  const detail = `pour : ${r.pour} parts, contre : ${r.contre}, abstention : ${r.abstention}, sur ${presentes} parts présentes ou représentées`
  return r.adoptee ? `Cette résolution est adoptée (${detail}).` : `Cette résolution est rejetée (${detail}).`
}

function definition(a: Assemblee, societe: Societe | null): TDocumentDefinitions {
  const titre = `Procès-verbal de l'assemblée générale ${TYPES[a.type]} du ${frenchDate(a.date)}`
  const presents = a.presences.filter((p) => p.presence !== 'absent')
  const entete: Content[] = societe
    ? [
        { text: `${societe.denomination}`, style: 'societe' },
        { text: [societe.forme, societe.capital ? `au capital de ${euros(societe.capital)}` : null].filter(Boolean).join(' ') },
        ...(societe.siege ? [{ text: `Siège social : ${societe.siege}` }] : []),
        ...(societe.rcs ? [{ text: societe.rcs }] : []),
      ]
    : [{ text: 'Société (fiche à compléter)', color: GRIS }]

  return {
    pageSize: 'A4',
    pageMargins: [50, 50, 50, 50],
    defaultStyle: { font: 'Roboto', fontSize: 10, color: '#1f2328', lineHeight: 1.2 },
    styles: {
      societe: { fontSize: 13, bold: true },
      titre: { fontSize: 14, bold: true, alignment: 'center', margin: [0, 18, 0, 4] },
      h2: { fontSize: 11, bold: true, margin: [0, 14, 0, 4] },
      petit: { fontSize: 8, color: GRIS },
    },
    info: { title: titre },
    footer: (page: number, pages: number) => ({
      text: `${a.numero ? `Registre n° ${a.numero} – ` : ''}${page} / ${pages}`, alignment: 'right', style: 'petit', margin: [0, 15, 50, 0],
    }),
    ...(a.statut === 'brouillon'
      ? { watermark: { text: 'PROJET', color: '#cf222e', opacity: 0.12, bold: true } }
      : {}),
    content: [
      ...entete,
      { text: titre, style: 'titre' },
      ...(a.statut === 'brouillon'
        ? [{ text: 'Projet – assemblée non close', alignment: 'center' as const, color: '#cf222e', bold: true }]
        : [{ text: `Registre des décisions, procès-verbal n° ${a.numero}`, alignment: 'center' as const, color: GRIS }]),
      {
        text: `Le ${frenchDate(a.date)}${a.heure ? ` à ${a.heure}` : ''}${a.lieu ? `, ${a.lieu}` : ''}, les associés de la société se `
          + `sont réunis en assemblée générale ${TYPES[a.type]}.`
          + (a.president ? ` L'assemblée est présidée par ${a.president}.` : ''),
        margin: [0, 14, 0, 0],
      },

      { text: 'Présences', style: 'h2' },
      {
        table: {
          widths: ['*', 60, 60, 150],
          body: [
            ['Associé', 'Parts', 'Part du capital', 'Présence'].map((t) => ({ text: t, bold: true })),
            ...a.presences.map((p) => [
              `${p.nom}${p.gerant ? ' (gérant)' : ''}`, String(p.parts), pourcent(p.parts, a.parts_total),
              `${PRESENCES[p.presence]}${p.presence === 'represente' && p.represente_par ? ` par ${p.represente_par}` : ''}`,
            ]),
          ],
        },
        layout: 'lightHorizontalLines',
      },
      {
        text: `Associés présents ou représentés : ${presents.length} sur ${a.presences.length}, détenant ${a.parts_presentes} parts sur `
          + `${a.parts_total} (${pourcent(a.parts_presentes, a.parts_total)}). L'assemblée peut valablement délibérer.`,
        margin: [0, 6, 0, 0],
      },

      { text: 'Ordre du jour', style: 'h2' },
      { text: a.ordre_du_jour || '—' },

      { text: 'Résolutions', style: 'h2' },
      ...a.resolutions.flatMap((r): Content[] => [
        { text: `Résolution n° ${r.ordre} : ${r.titre}`, bold: true, margin: [0, 8, 0, 2] },
        { text: r.texte },
        { text: vote(r, a.parts_presentes), italics: true, margin: [0, 2, 0, 0] },
      ]),
      ...(a.observations ? [{ text: 'Observations', style: 'h2' }, { text: a.observations }] : []),

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
              { stack: [{ text: 'Le président de séance', bold: true }, a.president ?? ''], width: '*' },
              { stack: [{ text: 'Les associés', bold: true }, ...presents.map((p) => p.nom)], width: '*' },
            ],
          },
        ],
      },
    ],
  }
}

export const pvPdf = async (a: Assemblee, societe: Societe | null) =>
  Buffer.from(await pdfmake.createPdf(definition(a, societe)).getBuffer())

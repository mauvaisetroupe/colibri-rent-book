// Engine side of the invoice extractors (ADR 0013): pieces of text of pdf.js, grouping settings, version of the
// contract. What the code of an extractor sees is in extractor.ts (module 'extractor'); the application types
// (api.ts) come from there too.

import type { Allocation, Category, Energy, ExtractedLine, ExtractionDocument, InvoiceExtractor } from './extractor'

export type Categorie = Category
export type Energie = Energy
export type Affectation = Allocation

/** A piece of text drawn on a PDF page (pdf.js), in points from the top-left corner; y is the baseline. */
export type Morceau = {
  texte: string
  x: number
  y: number
  largeur: number
  hauteur: number
}

/** How the pieces of a page become lines of text (regroupement.ts). Always stored with the extractor. */
export type Reglages = {
  // Pieces whose baselines differ by at most this many points are on the same line
  toleranceHauteur: number
  // A gap below this many points: the pieces are glued (a word split in two pieces)
  collage: number
  // A gap above this many points: a change of column, written as three spaces
  colonne: number
  // Bank statements (ADR 0018): pieces left of this abscissa are ignored (a code printed in the margin)
  marge?: number
}

// Version of the contract (pdf.js, grouping, module 'extractor'), stored with each extractor: to be raised when a
// change of the engine can change what an existing extractor reads. 2: extractors are classes (2026-10-17).
export const MOTEUR = 2

export const REGLAGES_PAR_DEFAUT: Reglages = { toleranceHauteur: 2, collage: 0.8, colonne: 15 }
export const REGLAGES_RELEVE_PAR_DEFAUT: Reglages = { ...REGLAGES_PAR_DEFAUT, marge: 40 }

export type Document = ExtractionDocument
export type LigneLue = ExtractedLine

/** The class of an extractor, as its code exports it by default. */
export type ClasseExtracteur = new (doc: ExtractionDocument) => InvoiceExtractor

// Same texts as backend/src/invoices/types.ts: the server checks recognise them
export const NOTE_PERIODE_PAR_DEFAUT = 'Période non indiquée : période de consommation de la facture'
export const NOTE_PENALITE = 'Non récupérable (pénalité de retard du bailleur)'

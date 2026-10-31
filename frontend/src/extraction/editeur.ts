import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import tsWorker from 'monaco-editor/languages/features/typescript/ts.worker?worker'

import sourceBankExtractor from './bank-extractor.ts?raw'
import sourceExtractor from './extractor.ts?raw'

// Code editor of the « Extracteurs » screen (ADR 0013): Monaco, the editor of VS Code, with its TypeScript service.
// It knows the base class and the helpers (module 'extractor'), underlines errors while typing, and produces the JavaScript
// that runs (CommonJS, as compilation.ts does for the tests). Loaded with this screen only.

self.MonacoEnvironment = {
  getWorker: (_id, label) => (label === 'typescript' || label === 'javascript' ? new tsWorker() : new editorWorker()),
}

const ts = monaco.typescript
ts.typescriptDefaults.setCompilerOptions({
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.NodeJs,
  strict: true,
  noUncheckedIndexedAccess: true,
  // The language service takes the file names of the libraries
  lib: ['lib.es2023.d.ts'],
})
// The base class as a package of the virtual file system: « import { … } from 'extractor' » resolves to it
ts.typescriptDefaults.setExtraLibs([
  { content: sourceExtractor, filePath: 'file:///node_modules/extractor/index.ts' },
  // Bank statement extractors (ADR 0018)
  { content: sourceBankExtractor, filePath: 'file:///node_modules/bank-extractor/index.ts' },
  { content: 'declare module \'big.js\' { const Big: any; export default Big }', filePath: 'file:///node_modules/big.js/index.d.ts' },
])

let sign_count = 0

// Each method of the extractor gets, in the gutter, the colour of what it highlights in the text of the PDF
const METHODES: Record<string, string> = {
  invoiceNumber: 'methode-numero',
  invoiceDate: 'methode-date',
  total: 'methode-total',
  linesZone: 'methode-zone',
  findLine: 'methode-lignes',
  readLine: 'methode-lecture',
  after: 'methode-lecture',
  // Copy joined to the supporting documents (ADR 0024)
  redactions: 'methode-masquage',
  // Bank statements
  account: 'methode-numero',
  statementDate: 'methode-date',
  openingBalance: 'methode-total',
  closingBalance: 'methode-total',
  printedTotals: 'methode-total',
  movementsZone: 'methode-zone',
  findMovement: 'methode-lignes',
  readMovement: 'methode-lecture',
  ignoreRow: 'methode-lecture',
}

/** Lines of each method: from its declaration to the closing brace at its indentation. */
function blocsDesMethodes(model: monaco.editor.ITextModel) {
  const lines = model.getLinesContent()
  const blocs: { start: number, end: number, classe: string }[] = []
  lines.forEach((ligne, i) => {
    const m = ligne.match(/^(\s*)(?:(?:public|protected|private|override)\s+)*(\w+)\s*\(/)
    const classe = m && METHODES[m[2]!]
    if (!m || !classe) {
      return
    }
    const fermeture = lines.findIndex((l, k) => k > i && l === `${m[1]}}`)
    blocs.push({ start: i + 1, end: (fermeture < 0 ? i : fermeture) + 1, classe })
  })
  return blocs
}

export type Editeur = {
  source: () => string
  remplacer: (source: string) => void
  /** JavaScript produced from the current source, and the TypeScript errors (empty when none) */
  compiler: () => Promise<{ code: string, erreurs: string[] }>
  surChangement: (rappel: () => void) => void
  lectureSeule: (oui: boolean) => void
  detruire: () => void
}

export function creerEditeur(element: HTMLElement, source: string): Editeur {
  const uri = monaco.Uri.parse(`file:///extracteur-${++sign_count}.ts`)
  const model = monaco.editor.createModel(source, 'typescript', uri)
  const editor = monaco.editor.create(element, {
    model, theme: 'vs', automaticLayout: true, minimap: { enabled: false }, fontSize: 13, tabSize: 2, scrollBeyondLastLine: false,
  })

  const decorations = editor.createDecorationsCollection()
  const colorer = () => decorations.set(blocsDesMethodes(model).map(({ start, end, classe }) => ({
    range: new monaco.Range(start, 1, end, 1),
    options: { isWholeLine: true, linesDecorationsClassName: classe },
  })))
  colorer()
  model.onDidChangeContent(colorer)

  return {
    source: () => model.getValue(),
    remplacer: (text) => model.setValue(text),
    async compiler() {
      const worker = await (await ts.getTypeScriptWorker())(uri)
      const [syntaxe, semantique, move_out] = await Promise.all([
        worker.getSyntacticDiagnostics(uri.toString()),
        worker.getSemanticDiagnostics(uri.toString()),
        worker.getEmitOutput(uri.toString()),
      ])
      const erreurs = [...syntaxe, ...semantique].map((d) => {
        const text = typeof d.messageText === 'string' ? d.messageText : d.messageText.messageText
        const ligne = d.start === undefined ? null : model.getPositionAt(d.start).lineNumber
        return ligne ? `ligne ${ligne} : ${text}` : text
      })
      const js = move_out.outputFiles.find((f) => f.name.endsWith('.js'))
      return { code: js?.text ?? '', erreurs }
    },
    surChangement: (rappel) => { model.onDidChangeContent(rappel) },
    lectureSeule: (oui) => editor.updateOptions({ readOnly: oui }),
    detruire: () => {
      editor.dispose()
      model.dispose()
    },
  }
}

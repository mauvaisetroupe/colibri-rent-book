import type * as TypeScript from 'typescript'

// TypeScript source of an extractor → the JavaScript that runs (CommonJS, its only import is 'aides'). The compiler is
// passed in, so that the application does not bundle it: the editor compiles with Monaco (editeur.ts, same options),
// the tests and the shipped models with `typescript`.

export function compiler(source: string, ts: typeof TypeScript): string {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
}

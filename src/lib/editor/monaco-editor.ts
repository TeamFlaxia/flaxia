import EditorWorker from '../../../node_modules/monaco-editor/esm/vs/editor/editor.worker?worker';
import CssWorker from '../../../node_modules/monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from '../../../node_modules/monaco-editor/esm/vs/language/html/html.worker?worker';
import JsonWorker from '../../../node_modules/monaco-editor/esm/vs/language/json/json.worker?worker';

type MonacoWorkerConstructor = new () => Worker;

let TypeScriptWorker: MonacoWorkerConstructor | null = null;

export async function loadStudioMonaco(language: string): Promise<typeof import('monaco-editor')> {
  // Monaco's package exports the standalone ESM entry at runtime but omits its declaration subpath.
  const monaco: typeof import('monaco-editor') = await import(
    // @ts-expect-error Import Monaco's standalone editor and its matching feature contributions.
    '../../../node_modules/monaco-editor/esm/vs/editor/editor.main.js'
  );
  if (language === 'typescript') {
    TypeScriptWorker = (await import('./monaco-typescript-worker.ts')).default;
  } else if (language === 'javascript') {
    const { javascriptDefaults } = await import(
      '../../../node_modules/monaco-editor/esm/vs/languages/features/typescript/register.js'
    );
    javascriptDefaults.setDiagnosticsOptions({
      ...javascriptDefaults.getDiagnosticsOptions(),
      noSemanticValidation: true,
      noSyntaxValidation: true,
    });
    javascriptDefaults.setModeConfiguration({
      ...javascriptDefaults.modeConfiguration,
      completionItems: false,
      hovers: false,
      documentSymbols: false,
      definitions: false,
      references: false,
      documentHighlights: false,
      rename: false,
      diagnostics: false,
      documentRangeFormattingEdits: false,
      signatureHelp: false,
      onTypeFormattingEdits: false,
      codeActions: false,
      inlayHints: false,
    });
  }
  const runtime = globalThis as typeof globalThis & {
    MonacoEnvironment?: { getWorker: (workerId: string, label: string) => Worker };
  };
  runtime.MonacoEnvironment = {
    getWorker: (_workerId, label) => {
      if (label === 'json') return new JsonWorker();
      if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
      if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
      if (label === 'typescript' && TypeScriptWorker) return new TypeScriptWorker();
      if (label === 'javascript') return new EditorWorker();
      return new EditorWorker();
    },
  };
  return monaco;
}

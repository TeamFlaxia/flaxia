import EditorWorker from '../../../node_modules/monaco-editor/esm/vs/editor/editor.worker?worker';
import CssWorker from '../../../node_modules/monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from '../../../node_modules/monaco-editor/esm/vs/language/html/html.worker?worker';
import JsonWorker from '../../../node_modules/monaco-editor/esm/vs/language/json/json.worker?worker';
import TypeScriptWorker from '../../../node_modules/monaco-editor/esm/vs/language/typescript/ts.worker?worker';

export async function loadStudioMonaco(_language: string): Promise<typeof import('monaco-editor')> {
  // Monaco's package exports the standalone ESM entry at runtime but omits its declaration subpath.
  const monaco: typeof import('monaco-editor') = await import(
    // @ts-expect-error Import Monaco's standalone editor and its matching feature contributions.
    '../../../node_modules/monaco-editor/esm/vs/editor/editor.main.js'
  );
  const runtime = globalThis as typeof globalThis & {
    MonacoEnvironment?: { getWorker: (workerId: string, label: string) => Worker };
  };
  runtime.MonacoEnvironment = {
    getWorker: (_workerId, label) => {
      if (label === 'json') return new JsonWorker();
      if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
      if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
      if (label === 'typescript' || label === 'javascript') return new TypeScriptWorker();
      return new EditorWorker();
    },
  };
  return monaco;
}

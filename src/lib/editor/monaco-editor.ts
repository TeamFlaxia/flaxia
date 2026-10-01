import EditorWorker from '../../../node_modules/monaco-editor/esm/vs/editor/editor.worker?worker';
import CssWorker from '../../../node_modules/monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from '../../../node_modules/monaco-editor/esm/vs/language/html/html.worker?worker';
import JsonWorker from '../../../node_modules/monaco-editor/esm/vs/language/json/json.worker?worker';
import TypeScriptWorker from '../../../node_modules/monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import '../../../node_modules/monaco-editor/esm/vs/language/css/monaco.contribution.js';
import '../../../node_modules/monaco-editor/esm/vs/language/html/monaco.contribution.js';
import '../../../node_modules/monaco-editor/esm/vs/language/json/monaco.contribution.js';
import '../../../node_modules/monaco-editor/esm/vs/language/typescript/monaco.contribution.js';
import '../../../node_modules/monaco-editor/esm/vs/languages/definitions/css/register.js';
import '../../../node_modules/monaco-editor/esm/vs/languages/definitions/cpp/register.js';
import '../../../node_modules/monaco-editor/esm/vs/languages/definitions/csharp/register.js';
import '../../../node_modules/monaco-editor/esm/vs/languages/definitions/dockerfile/register.js';
import '../../../node_modules/monaco-editor/esm/vs/languages/definitions/go/register.js';
import '../../../node_modules/monaco-editor/esm/vs/languages/definitions/graphql/register.js';
import '../../../node_modules/monaco-editor/esm/vs/languages/definitions/html/register.js';
import '../../../node_modules/monaco-editor/esm/vs/languages/definitions/ini/register.js';
import '../../../node_modules/monaco-editor/esm/vs/languages/definitions/javascript/register.js';
import '../../../node_modules/monaco-editor/esm/vs/languages/definitions/java/register.js';
import '../../../node_modules/monaco-editor/esm/vs/languages/definitions/lua/register.js';
import '../../../node_modules/monaco-editor/esm/vs/languages/definitions/markdown/register.js';
import '../../../node_modules/monaco-editor/esm/vs/languages/definitions/php/register.js';
import '../../../node_modules/monaco-editor/esm/vs/languages/definitions/python/register.js';
import '../../../node_modules/monaco-editor/esm/vs/languages/definitions/ruby/register.js';
import '../../../node_modules/monaco-editor/esm/vs/languages/definitions/rust/register.js';
import '../../../node_modules/monaco-editor/esm/vs/languages/definitions/shell/register.js';
import '../../../node_modules/monaco-editor/esm/vs/languages/definitions/sql/register.js';
import '../../../node_modules/monaco-editor/esm/vs/languages/definitions/swift/register.js';
import '../../../node_modules/monaco-editor/esm/vs/languages/definitions/typescript/register.js';
import '../../../node_modules/monaco-editor/esm/vs/languages/definitions/wgsl/register.js';
import '../../../node_modules/monaco-editor/esm/vs/languages/definitions/xml/register.js';
import '../../../node_modules/monaco-editor/esm/vs/languages/definitions/yaml/register.js';
import '../../../node_modules/monaco-editor/min/vs/editor/editor.main.css';

export async function loadStudioMonaco(): Promise<typeof import('monaco-editor')> {
  // Monaco's package exports the standalone ESM entry at runtime but omits its declaration subpath.
  // @ts-expect-error Import the standalone API to avoid registering every bundled language.
  const monaco: typeof import('monaco-editor') = await import(
    '../../../node_modules/monaco-editor/esm/vs/editor/editor.api.js'
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

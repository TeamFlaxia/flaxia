import EditorWorker from '../../../node_modules/monaco-editor/esm/vs/editor/editor.worker?worker';
import CssWorker from '../../../node_modules/monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from '../../../node_modules/monaco-editor/esm/vs/language/html/html.worker?worker';
import JsonWorker from '../../../node_modules/monaco-editor/esm/vs/language/json/json.worker?worker';
import TypeScriptWorker from '../../../node_modules/monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import '../../../node_modules/monaco-editor/min/vs/editor/editor.main.css';

type LanguageLoader = () => Promise<unknown>;

const languageLoaders: Record<string, LanguageLoader> = {
  css: () => import('../../../node_modules/monaco-editor/esm/vs/languages/definitions/css/register.js'),
  cpp: () => import('../../../node_modules/monaco-editor/esm/vs/languages/definitions/cpp/register.js'),
  csharp: () => import('../../../node_modules/monaco-editor/esm/vs/languages/definitions/csharp/register.js'),
  dockerfile: () => import('../../../node_modules/monaco-editor/esm/vs/languages/definitions/dockerfile/register.js'),
  go: () => import('../../../node_modules/monaco-editor/esm/vs/languages/definitions/go/register.js'),
  graphql: () => import('../../../node_modules/monaco-editor/esm/vs/languages/definitions/graphql/register.js'),
  html: () => import('../../../node_modules/monaco-editor/esm/vs/languages/definitions/html/register.js'),
  ini: () => import('../../../node_modules/monaco-editor/esm/vs/languages/definitions/ini/register.js'),
  javascript: () => import('../../../node_modules/monaco-editor/esm/vs/languages/definitions/javascript/register.js'),
  java: () => import('../../../node_modules/monaco-editor/esm/vs/languages/definitions/java/register.js'),
  lua: () => import('../../../node_modules/monaco-editor/esm/vs/languages/definitions/lua/register.js'),
  markdown: () => import('../../../node_modules/monaco-editor/esm/vs/languages/definitions/markdown/register.js'),
  php: () => import('../../../node_modules/monaco-editor/esm/vs/languages/definitions/php/register.js'),
  python: () => import('../../../node_modules/monaco-editor/esm/vs/languages/definitions/python/register.js'),
  ruby: () => import('../../../node_modules/monaco-editor/esm/vs/languages/definitions/ruby/register.js'),
  rust: () => import('../../../node_modules/monaco-editor/esm/vs/languages/definitions/rust/register.js'),
  shell: () => import('../../../node_modules/monaco-editor/esm/vs/languages/definitions/shell/register.js'),
  sql: () => import('../../../node_modules/monaco-editor/esm/vs/languages/definitions/sql/register.js'),
  swift: () => import('../../../node_modules/monaco-editor/esm/vs/languages/definitions/swift/register.js'),
  typescript: () => import('../../../node_modules/monaco-editor/esm/vs/languages/definitions/typescript/register.js'),
  wgsl: () => import('../../../node_modules/monaco-editor/esm/vs/languages/definitions/wgsl/register.js'),
  xml: () => import('../../../node_modules/monaco-editor/esm/vs/languages/definitions/xml/register.js'),
  yaml: () => import('../../../node_modules/monaco-editor/esm/vs/languages/definitions/yaml/register.js'),
};

const languageContributions: Record<string, LanguageLoader> = {
  // @ts-expect-error Monaco's internal registration module does not publish declarations.
  css: () => import('../../../node_modules/monaco-editor/esm/vs/language/css/monaco.contribution.js'),
  // @ts-expect-error Monaco's internal registration module does not publish declarations.
  html: () => import('../../../node_modules/monaco-editor/esm/vs/language/html/monaco.contribution.js'),
  // @ts-expect-error Monaco's internal registration module does not publish declarations.
  json: () => import('../../../node_modules/monaco-editor/esm/vs/language/json/monaco.contribution.js'),
  // @ts-expect-error Monaco's internal registration module does not publish declarations.
  javascript: () => import('../../../node_modules/monaco-editor/esm/vs/language/typescript/monaco.contribution.js'),
  // @ts-expect-error Monaco's internal registration module does not publish declarations.
  typescript: () => import('../../../node_modules/monaco-editor/esm/vs/language/typescript/monaco.contribution.js'),
};

export async function loadStudioMonaco(language: string): Promise<typeof import('monaco-editor')> {
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

  const normalizedLanguage = language === 'scss' || language === 'less' ? 'css' : language;
  if (normalizedLanguage === 'jsonc') await languageContributions.json?.();
  else await languageContributions[normalizedLanguage]?.();
  await languageLoaders[normalizedLanguage]?.();
  return monaco;
}

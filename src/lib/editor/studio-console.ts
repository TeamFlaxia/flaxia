export interface StudioConsoleEntry {
  kind: 'console';
  level: 'log' | 'info' | 'warn' | 'error';
  text: string;
}

/** Validate the structured-clone data received from a sandboxed code preview. */
export function parseStudioConsoleEntry(value: unknown): StudioConsoleEntry | null {
  if (typeof value !== 'object' || value === null || !('kind' in value) || value.kind !== 'console') return null;
  if (!('level' in value) || !['log', 'info', 'warn', 'error'].includes(String(value.level))) return null;
  if (!('text' in value) || typeof value.text !== 'string') return null;
  return {
    kind: 'console',
    level: value.level as StudioConsoleEntry['level'],
    text: value.text.slice(0, 2000),
  };
}

/** Installed before user code runs; queued entries flush after the host transfers a MessagePort. */
export const STUDIO_CONSOLE_BRIDGE_SOURCE = `(()=>{
  let port=null;
  let sent=0;
  const backlog=[];
  const stringify=value=>{
    if(value instanceof Error)return value.stack||value.message;
    if(typeof value==='string')return value;
    try{const json=JSON.stringify(value);return json===undefined?String(value):json}
    catch{return String(value)}
  };
  const publish=entry=>{
    if(sent>=100)return;
    sent++;
    const safe={kind:'console',level:entry.level,text:String(entry.text).slice(0,2000)};
    if(port){port.postMessage(safe);return}
    if(backlog.length<100)backlog.push(safe);
  };
  for(const level of ['log','info','warn','error']){
    const original=console[level].bind(console);
    console[level]=(...args)=>{
      original(...args);
      publish({level,text:args.map(stringify).join(' ')});
    };
  }
  addEventListener('error',event=>publish({
    level:'error',
    text:(event.message||'Script error')+' ('+event.filename+':'+event.lineno+':'+event.colno+')',
  }));
  addEventListener('unhandledrejection',event=>publish({
    level:'error',
    text:'Unhandled promise rejection: '+stringify(event.reason),
  }));
  addEventListener('message',event=>{
    if(event.source!==parent||event.data?.type!=='STUDIO_CONSOLE_CONNECT'||!event.ports[0])return;
    port=event.ports[0];
    for(const entry of backlog)port.postMessage(entry);
    backlog.length=0;
    port.start();
  });
  addEventListener('pagehide',()=>port?.close());
})();`;

/** Install instrumentation after a document type declaration and before page scripts execute. */
export function injectStudioConsoleBridge(source: string): string {
  const instrumentation = `<script>${STUDIO_CONSOLE_BRIDGE_SOURCE}</script>`;
  const doctype = source.match(/^\s*<!doctype\b[^>]*>/i)?.[0];
  return doctype ? source.replace(doctype, `${doctype}${instrumentation}`) : `${instrumentation}${source}`;
}

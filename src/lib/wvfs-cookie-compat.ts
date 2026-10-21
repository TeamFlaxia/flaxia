/**
 * Some game SDKs read cookies before installing their public API. Opaque-origin
 * documents throw instead of returning an empty cookie string, aborting that
 * initialization. Expose disabled-cookie behavior only when access is denied;
 * never read, write, or persist cookies on behalf of an untrusted game.
 */
export function createWvfsCookieCompatScript(): string {
  return `(function(){
    try{void document.cookie;return}catch(error){
      if(!error||error.name!=="SecurityError")return;
    }
    try{
      Object.defineProperty(document,"cookie",{
        configurable:true,
        get:function(){return ""},
        set:function(){}
      });
    }catch{}
  })();`;
}

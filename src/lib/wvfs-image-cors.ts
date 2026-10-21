/**
 * RPG Maker MV draws local image assets into canvases and reads pixels from
 * them. In an opaque-origin game iframe, a normal Image.src load is a no-CORS
 * cross-origin load and taints those canvases even though WVFS sends ACAO: *.
 * Request only this game's WVFS assets in anonymous CORS mode; unrelated and
 * external images keep their original loading behavior.
 */
export function createWvfsImageCorsCompatScript(baseUrl: string): string {
  const baseUrlLiteral = JSON.stringify(baseUrl).replace(/</g, '\\u003c');

  return `(function(){
    if(typeof HTMLImageElement==="undefined"||typeof Element==="undefined"||typeof document==="undefined")return;
    var assetBase;
    try{assetBase=new URL(${baseUrlLiteral},document.baseURI)}catch{return}
    var assetPath=assetBase.pathname.endsWith("/")?assetBase.pathname:assetBase.pathname+"/";
    function isLocalWvfsAsset(value){
      try{
        var url=new URL(value,document.baseURI);
        return url.origin===assetBase.origin&&url.pathname.indexOf(assetPath)===0;
      }catch{return false}
    }
    function enableCorsBeforeLoad(image,value){
      if(isLocalWvfsAsset(value)&&!image.hasAttribute("crossorigin"))image.crossOrigin="anonymous";
    }
    var imageSrc=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,"src");
    if(imageSrc&&imageSrc.configurable&&typeof imageSrc.get==="function"&&typeof imageSrc.set==="function"){
      try{
        Object.defineProperty(HTMLImageElement.prototype,"src",{
          configurable:imageSrc.configurable,
          enumerable:imageSrc.enumerable,
          get:imageSrc.get,
          set:function(value){enableCorsBeforeLoad(this,value);imageSrc.set.call(this,value)}
        });
      }catch{}
    }
    var setAttribute=Element.prototype.setAttribute;
    Element.prototype.setAttribute=function(name,value){
      if(this instanceof HTMLImageElement&&String(name).toLowerCase()==="src")enableCorsBeforeLoad(this,value);
      return setAttribute.call(this,name,value);
    };
  })();`;
}

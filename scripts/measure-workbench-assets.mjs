// Static import closure only, not a WAN benchmark or a user-perceived latency claim.
import {readFile,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {gzipSync} from 'node:zlib'
const [beforeDir,afterDir,output]=process.argv.slice(2)
if(!beforeDir||!afterDir||!output)throw Error('Need baseline dist, candidate dist and output')
const routes={navigation:'src/modules/navigation/Navigation.vue',notes:'src/modules/whisper/Whisper.vue',files:'src/modules/files/FilesView.vue',media:'src/modules/media/MediaLibrary.vue',assistant:'src/modules/assistant/AssistantView.vue',settings:'src/modules/settings/Settings.vue',login:'src/modules/auth/AuthView.vue'}
async function measure(root){
 const manifest=JSON.parse(await readFile(join(root,'.vite/manifest.json'),'utf8')), result={}
 for(const [route,key]of Object.entries(routes)){
  const keys=new Set(),files=new Set()
  function add(key){if(keys.has(key))return;keys.add(key);const entry=manifest[key];if(!entry)throw Error('Missing manifest entry '+key);files.add(entry.file);for(const css of entry.css||[])files.add(css);for(const dependency of entry.imports||[])add(dependency)}
  const aliases=Object.keys(manifest).filter(k=>manifest[k].isDynamicEntry && manifest[k].name===key.split('/').at(-1).replace('.vue',''))
  if(!manifest[key] && aliases.length!==1)throw Error('Ambiguous route entry '+key)
  add('index.html');add(manifest[key]?key:aliases[0])
  const totals={rawBytes:0,gzipBytes:0,jsFiles:0,cssFiles:0}
  for(const file of files){const bytes=await readFile(join(root,file));totals.rawBytes+=bytes.length;totals.gzipBytes+=gzipSync(bytes).length;totals[file.endsWith('.css')?'cssFiles':'jsFiles']++}
  result[route]={...totals,files:[...files].sort()}
 }
 return result
}
const baseline=await measure(resolve(beforeDir)),candidate=await measure(resolve(afterDir))
const delta=Object.fromEntries(Object.keys(routes).map(key=>[key,{rawBytes:candidate[key].rawBytes-baseline[key].rawBytes,gzipBytes:candidate[key].gzipBytes-baseline[key].gzipBytes,gzipPercent:Number(((candidate[key].gzipBytes/baseline[key].gzipBytes-1)*100).toFixed(1))}]))
await writeFile(output,JSON.stringify({scope:'same-lock Vite production builds; static import JS/CSS closures including shell; excludes dynamic fetches, server latency and real networks',baseline,candidate,delta},null,2))
console.log(JSON.stringify({delta}))

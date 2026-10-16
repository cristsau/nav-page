// Run existing isolated panel checks with task-local Vite caches and loopback servers.
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
const root=resolve('app'), output=process.env.NAV_PANEL_EVIDENCE
if(!output)throw Error('Explicit evidence path required')
const {createServer,preview}=await import(pathToFileURL(createRequire(join(root,'package.json')).resolve('vite')).href)
process.env.NAV_NOTE_UI_EVIDENCE=join(output,'note-ui')
const dev=await createServer({root,configFile:join(root,'vite.config.js'),cacheDir:join(output,'vite-note-cache'),server:{host:'127.0.0.1',port:4179,strictPort:true}})
let built
const run=script=>new Promise((resolveRun,reject)=>{
 const child=spawn(process.execPath,[script],{env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']})
 let log='';child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d)
 const timer=setTimeout(()=>{child.kill();reject(Error('Panel check deadline exceeded'))},180000)
 child.on('error',reject)
 child.on('close',async code=>{clearTimeout(timer);await writeFile(join(output,script.split('/').at(-1)+'.log'),log);if(code)reject(Error(script+' failed: '+log.slice(-2200)));else{console.log(log.trim().split('\n').at(-1));resolveRun()}})
})
try {
 await dev.listen()
 await run('scripts/verify-note-editor-ui.mjs')
 await run('scripts/verify-note-save-r2-ui.mjs')
 await dev.close()
 built=await preview({root,configFile:join(root,'vite.config.js'),preview:{host:'127.0.0.1',port:4178,strictPort:true}})
 await run('scripts/verify-settings-mobile-ui.mjs')
} finally {await dev.close();if(built)await new Promise(r=>built.httpServer.close(r))}

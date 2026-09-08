import test from 'node:test'
import assert from 'node:assert/strict'
import {createPwaOauthController,isHomeScreenApp} from '../../app/src/shared/services/pwaOauth.js'
function harness(request) {
 const states=[],errors=[],completions=[],timers=new Map(),listeners=new Map();let serial=0
 const browser={setTimeout:fn=>{timers.set(++serial,fn);return serial},clearTimeout:id=>timers.delete(id)}
 const documentRef={visibilityState:'visible',addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)}
 const controller=createPwaOauthController({request,browser,documentRef,onState:s=>states.push(s),onComplete:s=>completions.push(s),onError:e=>errors.push(e.message)})
 return {controller,states,errors,completions,timers,listeners,documentRef}
}
test('Home Screen capability detects standalone only',()=>{
 assert.equal(isHomeScreenApp({navigator:{standalone:true}}),true)
 assert.equal(isHomeScreenApp({navigator:{},matchMedia:()=>({matches:false})}),false)
})
test('a recreated app restores the HttpOnly flow, then completes once on foreground',async()=>{
 let state='pending',completed=0
 const h=harness(async path=>path.endsWith('/status')?{state}:(completed++,{user:{id:'synthetic'}}))
 await h.controller.restore();assert.deepEqual(h.states,['pending']);assert.equal(h.timers.size,1)
 h.documentRef.visibilityState='hidden';state='ready';await h.controller.check();assert.equal(completed,0)
 h.documentRef.visibilityState='visible';await h.controller.check();assert.equal(completed,1);assert.equal(h.completions.length,1)
 await h.controller.check();assert.equal(completed,1);assert.equal(h.timers.size,0)
 h.controller.dispose();assert.equal(h.listeners.size,0)
})
test('lost completion response recovers the actual session without replaying a consumed claim',async()=>{
 let state='ready',completed=0
 const h=harness(async path=>{
   if(path.endsWith('/status'))return {state}
   if(path.endsWith('/complete')){completed++;state='expired';throw new Error('synthetic network loss')}
   if(path==='/auth/session')return {user:{id:'synthetic'}}
 })
 await h.controller.restore();assert.equal(h.states.at(-1),'reconnecting')
 await h.controller.check();assert.equal(completed,1);assert.equal(h.completions.length,1);assert.equal(h.errors.length,0)
 h.controller.dispose()
})
test('expiry and explicit cancellation never create a session',async()=>{
 let state='pending',cancelled=0
 const h=harness(async path=>path.endsWith('/status')?{state}:(assert.ok(path.endsWith('/cancel')),cancelled++,{ok:true}))
 await h.controller.restore();state='expired';await h.controller.check();assert.equal(h.errors.length,1)
 state='pending';await h.controller.restore();await h.controller.cancel();assert.equal(cancelled,1);assert.equal(h.states.at(-1),'idle');assert.equal(h.timers.size,0)
 assert.equal(h.completions.length,0);h.controller.dispose()
})

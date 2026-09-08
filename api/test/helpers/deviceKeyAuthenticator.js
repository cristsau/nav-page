// Synthetic authenticator for cryptographic tests only. Never uses a personal keychain.
import {createHash,generateKeyPairSync,randomBytes,sign} from 'node:crypto'
import {isoCBOR} from '@simplewebauthn/server/helpers'
const originDefault='https://nav.skrskr.net',rpDefault='nav.skrskr.net'
const sha=value=>createHash('sha256').update(value).digest()
export function syntheticAuthenticator(userId='11111111-1111-4111-8111-111111111111') {
 const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=pair.publicKey.export({format:'jwk'}),id=randomBytes(32)
 const publicKey=Buffer.from(isoCBOR.encode(new Map([[1,2],[3,-7],[-1,1],[-2,Buffer.from(jwk.x,'base64url')],[-3,Buffer.from(jwk.y,'base64url')]])))
 function clientData(type,challenge,origin) {return Buffer.from(JSON.stringify({type,challenge,origin,crossOrigin:false}))}
 function authData(flags,counter=0,rp=rpDefault) {const count=Buffer.alloc(4);count.writeUInt32BE(counter);return Buffer.concat([sha(rp),Buffer.from([flags]),count])}
 return {id:id.toString('base64url'),publicKey,
   register(challenge,{flags=0x45,origin=originDefault}={}) {
     const length=Buffer.alloc(2);length.writeUInt16BE(id.length)
     const attestation=isoCBOR.encode(new Map([['fmt','none'],['attStmt',new Map()],['authData',Buffer.concat([authData(flags),Buffer.alloc(16),length,id,publicKey])]]))
     return {id:id.toString('base64url'),rawId:id.toString('base64url'),type:'public-key',response:{clientDataJSON:clientData('webauthn.create',challenge,origin).toString('base64url'),attestationObject:Buffer.from(attestation).toString('base64url'),transports:['internal']},clientExtensionResults:{credProps:{rk:true}},authenticatorAttachment:'platform'}
   },
   login(challenge,{flags=5,counter=1,origin=originDefault,rp=rpDefault,userHandle=Buffer.from(userId).toString('base64url'),tamper=false}={}) {
     const data=clientData('webauthn.get',challenge,origin),auth=authData(flags,counter,rp)
     const signature=sign('sha256',Buffer.concat([auth,sha(data)]),pair.privateKey);if(tamper)signature[signature.length-1]^=1
     return {id:id.toString('base64url'),rawId:id.toString('base64url'),type:'public-key',response:{clientDataJSON:data.toString('base64url'),authenticatorData:auth.toString('base64url'),signature:signature.toString('base64url'),userHandle},clientExtensionResults:{}}
   }
 }
}

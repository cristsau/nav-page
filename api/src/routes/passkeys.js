// Retired compatibility contract. Never imports WebAuthn or touches historical tables.
export default async function passkeyRoutes(app) {
  app.get('/auth/passkeys/config',{config:{skipSession:true}},async(_request,reply)=>{
    reply.header('Cache-Control','no-store')
    return {enabled:false,retired:true}
  })
  const gone=async(_request,reply)=>reply.header('Cache-Control','no-store').code(410).send({
    code:'PASSKEY_RETIRED',error:'Passkey 已停用，请刷新页面并使用邮箱验证码、账号密码或恢复码。'
  })
  for(const url of ['/auth/passkeys','/auth/passkeys/*']) {
    app.route({method:['GET','POST','PUT','PATCH','DELETE'],url,config:{skipSession:true},handler:gone})
  }
}

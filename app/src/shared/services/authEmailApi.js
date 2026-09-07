import { apiRequest } from './apiClient'

const messages={
 AUTH_EMAIL_CODE_INVALID:'验证码无效或已过期，请使用本次请求收到的验证码。',
 AUTH_EMAIL_RATE_LIMITED:'操作过于频繁，请稍后再试。',
 AUTH_EMAIL_UNAVAILABLE:'邮箱验证暂不可用，请稍后重试或使用账号密码。',
 AUTH_EMAIL_PASSWORD_INVALID:'新密码至少 15 个字符，两次输入须一致。',
 AUTH_EMAIL_PASSWORD_UNCHANGED:'新密码不能与当前密码相同。',
 AUTH_EMAIL_REAUTH_REQUIRED:'请重新验证当前密码后再操作。',
 AUTH_EMAIL_OLD_EMAIL_REQUIRED:'更换邮箱还需要原邮箱的授权验证码。',
 AUTH_EMAIL_BIND_REQUIRED:'请先绑定并验证邮箱。',
 AUTH_EMAIL_BIND_REJECTED:'该邮箱无法用于此操作。',
 AUTH_EMAIL_REQUEST_INVALID:'请求格式不正确，请检查输入后重试。'
}
export function authEmailError(error) {return messages[error?.code] || (error?.status===401?'登录已失效，请重新登录。':'暂时无法完成，请稍后再试。')}
export const fetchAuthCapabilities=()=>apiRequest('/auth/capabilities',{method:'GET',cache:'no-store',expectedUnauthorized:true})
export function authEmailRequest(path,payload={},method='POST') {
 return apiRequest(path,{method,cache:'no-store',expectedUnauthorized:!path.startsWith('/auth/account/'),
   ...(method==='GET'?{}:{body:JSON.stringify(payload)})})
}

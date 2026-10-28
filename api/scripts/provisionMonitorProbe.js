// Operator-run on NAV host after approval. Prints no token. Output belongs on the
// named node only and must be copied by encrypted SSH, then removed locally.
import { randomBytes } from 'node:crypto'
import { open, lstat } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { pool } from '../src/db/index.js'
import { loadMonitorConfig } from '../src/lib/monitorBridge.js'
import { config } from '../src/config.js'
import { monitorForUser,readNodes,probeTokenHash } from '../src/lib/monitorWorkspace.js'
let handle,client
try{
  const nodeId=Number(process.argv[2]), output=resolve(process.argv[3]||'')
  if(!Number.isSafeInteger(nodeId)||nodeId<1||!process.argv[3])throw new Error('arguments')
  const parent=await lstat(dirname(output));if(!parent.isDirectory()||parent.isSymbolicLink()||(process.platform!=='win32'&&(parent.mode&0o077)))throw new Error('private directory required')
  const settings=await loadMonitorConfig(config.managedIntegrationsDir)
  if(!settings)throw new Error('disabled')
  const nodes=await readNodes(await monitorForUser(settings.ownerUserId),{fresh:true})
  if(!nodes.some(n=>n.id===nodeId))throw new Error('node missing')
  const token=randomBytes(32).toString('hex')
  handle=await open(output,'wx',0o600)
  await handle.writeFile(`NAV_PROBE_NODE_ID=${nodeId}\nNAV_PROBE_ENDPOINT=https://nav.skrskr.net/api/monitor/probes/report\nNAV_PROBE_TOKEN=${token}\n`)
  await handle.sync()
  client=await pool.connect()
  // Existing credentials are never silently rotated by a repeated provisioning run.
  await client.query('INSERT INTO monitor_probe_credentials(node_id,user_id,token_hash) VALUES($1,$2,$3)',[nodeId,settings.ownerUserId,probeTokenHash(token)])
  process.stdout.write(`Node ${nodeId}: private probe configuration created.\n`)
}catch{process.stderr.write('Provisioning failed; check arguments, existing registration and private output permissions. No secret printed.\n');process.exitCode=1}
finally{await handle?.close();client?.release();await pool.end()}

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { magnetSource, torrentMetadata, selectTorrentFile, compatibleVideoArgs, verifyCompatibleVideo, MEDIA_LIMIT } from '../../scripts/offline/media-policy.mjs'
const bencode = value => Buffer.isBuffer(value) ? Buffer.concat([Buffer.from(value.length + ':'), value]) : typeof value === 'string' ? bencode(Buffer.from(value)) : typeof value === 'number' ? Buffer.from(`i${value}e`) : Array.isArray(value) ? Buffer.concat([Buffer.from('l'), ...value.map(bencode), Buffer.from('e')]) : Buffer.concat([Buffer.from('d'), ...Object.keys(value).sort().flatMap(key => [bencode(key), bencode(value[key])]), Buffer.from('e')])
const info = () => ({ name: 'synthetic.mp4', length: 12, 'piece length': 16384, pieces: Buffer.alloc(20) })
test('magnet canonicalization drops external peer/web-seed hints and rejects ambiguity', () => {
  const result = magnetSource('magnet:?xt=urn:btih:' + 'A'.repeat(40) + '&dn=PRIVATE&xs=http://127.0.0.1&x.pe=127.0.0.1:22')
  assert.equal(result.infoHash, 'a'.repeat(40)); assert.ok(!result.uri.includes('PRIVATE')); assert.ok(!result.uri.includes('127.0.0.1'))
  for (const raw of ['https://example.com', 'magnet:?xt=urn:btmh:1220aa', 'magnet:?xt=x&xt=y', 'magnet:?xt=urn:btih:' + 'a'.repeat(40) + '&tr=http://user:pass@example.com']) assert.throws(() => magnetSource(raw))
})
test('torrent hash covers original info bytes; bounded metadata produces explicit file choices', () => {
  const i = info(), result = torrentMetadata(bencode({ info: i }))
  assert.equal(result.infoHash, createHash('sha1').update(bencode(i)).digest('hex'))
  assert.equal(selectTorrentFile(result).size, 12)
  const multiple = { ...i, files: [{ length: 6, path: ['one.mp4'] }, { length: 6, path: ['two.mp4'] }] }; delete multiple.length
  const parsed = torrentMetadata(bencode({ info: multiple }))
  assert.throws(() => selectTorrentFile(parsed), { message: 'BT_FILE_SELECTION_REQUIRED' })
  assert.equal(selectTorrentFile(parsed, 2).path, 'synthetic.mp4/two.mp4')
  assert.throws(() => selectTorrentFile(parsed, 3)); assert.throws(() => selectTorrentFile(parsed, '1'))
})
test('torrent paths, sizes, pieces, duplicate dictionaries and private metadata fail closed', () => {
  for (const name of ['..', '/outside', '..\\outside', 'C:drive', 'x\n', 'name.']) assert.throws(() => torrentMetadata(bencode({ info: { ...info(), name } })))
  for (const altered of [{ private: 1 }, { length: MEDIA_LIMIT + 1 }, { pieces: Buffer.alloc(0) }, { 'piece length': 0 }, { 'meta version': 2 }]) assert.throws(() => torrentMetadata(bencode({ info: { ...info(), ...altered } })))
  for (const raw of ['d1:ai1e1:ai2ee', 'd4:infod4:name99:xe', 'i01e', 'd4:infoi2ee', 'deTRAILING']) assert.throws(() => torrentMetadata(Buffer.from(raw)))
})
test('transcode is bounded to generated paths, one thread, non-overwriting output, no network protocols', () => {
  const args = compatibleVideoArgs('/var/lib/nav-media/' + 'a'.repeat(32), 60, 1024)
  assert.ok(args.includes('-n')); assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file')
  assert.equal(args[args.indexOf('-threads') + 1], '1'); assert.ok(args.at(-1).endsWith('/compatible.mp4'))
  assert.throws(() => compatibleVideoArgs('/etc', 60, 1024)); assert.throws(() => compatibleVideoArgs('/var/lib/nav-media/' + 'a'.repeat(32), 18000, 1024))
})
test('truncated or incompatible transcoding is never treated as a successful playable copy', () => {
  const valid = { inputDuration: 60, outputDuration: 60, outputSize: 1024, videoCodec: 'h264', pixelFormat: 'yuv420p', audioCodecs: ['aac'] }
  assert.equal(verifyCompatibleVideo(valid), true)
  for (const patch of [{ outputDuration: 10 }, { outputSize: MEDIA_LIMIT }, { videoCodec: 'hevc' }, { pixelFormat: 'yuv444p' }, { audioCodecs: ['dts'] }]) assert.throws(() => verifyCompatibleVideo({ ...valid, ...patch }))
})

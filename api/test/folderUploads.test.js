import test from 'node:test'
import assert from 'node:assert/strict'
import { planFolderUpload } from '../../app/src/modules/files/folderUploads.js'
import { FileTransferQueue } from '../../app/src/modules/files/fileTransfers.js'
const file = (path, size = 3) => ({ name: path.split('/').at(-1), webkitRelativePath: path, size })
test('folder plan preserves hierarchy and creates parents before children', () => {
  const result = planFolderUpload([file('Trip/photos/a.jpg'), file('Trip/b.txt')], '/Travel', 100)
  assert.deepEqual(result.paths, ['/Travel/Trip/photos/a.jpg', '/Travel/Trip/b.txt'])
  assert.deepEqual(result.directories, ['/Travel/Trip', '/Travel/Trip/photos'])
})
test('folder plan rejects traversal, invalid encodings, duplicates and file-directory conflicts', () => {
  for (const files of [[file('Trip/../a')], [file('Trip/%2f/a')], [file('Trip/a'), file('Trip/A')], [file('Trip/a'), file('Trip/a/b')], [file('Trip/A/a'), file('Trip/a/b')], [file('Trip/a'), file('Other/b')], [file('/a')]]) assert.throws(() => planFolderUpload(files, '', 100))
})
test('folder plan bounds file count, depth and individual size before creating anything', () => {
  for (const files of [[], Array.from({ length: 51 }, (_, n) => file('Trip/' + n)), [file('Trip/big', 101)], [file(Array(12).fill('a').join('/'))]]) assert.throws(() => planFolderUpload(files, '', 100))
})
test('directory queue preserves relative labels and rejects paths outside target before any queue change', () => {
  const queue = new FileTransferQueue({ limit: 100 }); queue.closed = true
  queue.add([file('Trip/a')], '/Travel', ['/Travel/Trip/a'])
  assert.equal(queue.jobs[0].path, '/Travel/Trip/a'); assert.equal(queue.jobs[0].name, 'Trip/a')
  assert.throws(() => queue.add([file('Trip/b')], '/Travel', ['/Elsewhere/b']))
  assert.equal(queue.jobs.length, 1)
})

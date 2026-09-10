// Owner-approved one-advisory exception. No extension without a new decision.
export const embeddingException = Object.freeze({
  advisory: 'GHSA-VWC7-R8MQ-G2X9',
  notBefore: '2026-09-10T02:45:00Z',
  expiresAt: '2026-09-17T02:45:00Z',
  versions: Object.freeze({ '@huggingface/transformers': '4.2.0', 'onnxruntime-node': '1.24.3', 'adm-zip': '0.6.0' }),
  isolation: 'cpu-no-installer-v1'
})

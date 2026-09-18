// Patched dependency pins; installer isolation remains defense in depth.
export const embeddingRuntime = Object.freeze({
  versions: Object.freeze({ '@huggingface/transformers': '4.2.0', 'onnxruntime-node': '1.24.3', 'adm-zip': '0.6.1' }),
  isolation: 'cpu-no-installer-v1'
})

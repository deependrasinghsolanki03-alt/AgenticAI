import { HuggingFaceTransformersEmbeddings } from "@langchain/community/embeddings/huggingface_transformers";

let embeddingInstance: HuggingFaceTransformersEmbeddings | null = null;
let isInitialising = false;
let initPromise: Promise<HuggingFaceTransformersEmbeddings> | null = null;

export async function getEmbeddingModel(): Promise<HuggingFaceTransformersEmbeddings> {
  if (embeddingInstance) return embeddingInstance;
  if (isInitialising && initPromise) return initPromise;
  isInitialising = true;
  initPromise = _loadModel();
  try {
    embeddingInstance = await initPromise;
    return embeddingInstance;
  } finally {
    isInitialising = false;
    initPromise = null;
  }
}

export async function initEmbeddingModel(): Promise<void> {
  console.log("[Embedding] Loading Xenova/all-MiniLM-L6-v2 into memory...");
  const start = Date.now();
  const model = await getEmbeddingModel();
  await model.embedQuery("warmup");
  console.log(`[Embedding] Model ready in ${((Date.now() - start) / 1000).toFixed(1)}s (384-dim, CPU-only)`);
}

async function _loadModel(): Promise<HuggingFaceTransformersEmbeddings> {
  return new HuggingFaceTransformersEmbeddings({ model: "Xenova/all-MiniLM-L6-v2", stripNewLines: true });
}

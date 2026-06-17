// ─── Embed Controller (Internal API) ────────────
// POST /api/embed — Returns 384-dim vectors for Worker Server.
// Protected by X-Internal-Key shared secret.

import { Request, Response } from "express";
import { getEmbeddingModel } from "../services/embedding.js";

export async function handleEmbed(req: Request, res: Response): Promise<void> {
  if (req.headers["x-internal-key"] !== process.env.INTERNAL_SECRET) {
    res.status(403).json({ error: "Forbidden: invalid internal key" });
    return;
  }

  const { text, texts } = req.body;
  try {
    const embeddings = await getEmbeddingModel();

    if (text && typeof text === "string") {
      const vector = await embeddings.embedQuery(text);
      res.json({ vector });
    } else if (texts && Array.isArray(texts)) {
      const vectors = await embeddings.embedDocuments(texts);
      res.json({ vectors });
    } else {
      res.status(400).json({ error: "Provide 'text' (string) or 'texts' (string[])." });
    }
  } catch (err: any) {
    console.error("[Embed] Error:", err.message);
    res.status(500).json({ error: "Embedding failed." });
  }
}

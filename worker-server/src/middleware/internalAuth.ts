import { Request, Response, NextFunction } from "express";

/**
 * Validates that requests come from the Manager Server
 * using a shared secret in the X-Internal-Key header.
 */
export function internalAuth(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers["x-internal-key"];

  if (!key || key !== process.env.INTERNAL_SECRET) {
    console.warn("[Auth] Rejected request — invalid or missing internal key");
    res.status(403).json({ error: "Forbidden: invalid internal key" });
    return;
  }

  next();
}

import { Request, Response, NextFunction } from "express";
import { supabaseAdmin } from "../config/supabase.js";

declare global {
  namespace Express {
    interface Request {
      user_id?: string;
      user_email?: string;
    }
  }
}

export async function verifyAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or malformed Authorization header." });
      return;
    }
    const token = authHeader.split(" ")[1];
    if (!token) { res.status(401).json({ error: "Empty token." }); return; }

    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !user) {
      console.error("[Auth] Verification failed:", error?.message);
      res.status(401).json({ error: "Invalid or expired token." });
      return;
    }
    req.user_id = user.id;
    req.user_email = user.email;
    next();
  } catch (err: any) {
    console.error("[Auth] Unexpected error:", err.message);
    res.status(500).json({ error: "Authentication service error." });
  }
}

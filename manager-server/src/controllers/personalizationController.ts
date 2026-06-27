// ─── Personalization Controller ─────────────────
// CRUD for email style profiles — users can save personalized
// email styles for specific contacts
// Data is AES-256-GCM encrypted at rest

import { Request, Response } from "express";
import { supabaseAdmin } from "../config/supabase.js";
import { encrypt, decrypt } from "../utils/crypto.js";

// GET /api/personalization — list all profiles for user
export async function listStyleProfiles(req: Request, res: Response) {
  const userId = req.user_id!;
  const { data, error } = await supabaseAdmin
    .from("email_style_profiles")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  
  // Decrypt style_text before sending to client
  const decrypted = (data || []).map(p => ({
    ...p,
    style_text: decrypt(p.style_text),
    contact_email: p.contact_email ? decrypt(p.contact_email) : null,
  }));
  res.json({ profiles: decrypted });
}

// POST /api/personalization — save a new style profile
export async function saveStyleProfile(req: Request, res: Response) {
  const userId = req.user_id!;
  const { relationship, contact_name, contact_email, style_text } = req.body;
  if (!relationship || !contact_name || !style_text) {
    return res.status(400).json({ error: "relationship, contact_name, and style_text are required." });
  }
  if (!contact_email) {
    return res.status(400).json({ error: "contact_email is required — style applies when emailing this address." });
  }

  // Encrypt sensitive data before storing
  const encryptedStyle = encrypt(style_text);
  const encryptedEmail = encrypt(contact_email.toLowerCase().trim());

  // Upsert — if same contact exists, update it
  const { data: existing } = await supabaseAdmin
    .from("email_style_profiles")
    .select("id, contact_email")
    .eq("user_id", userId)
    .eq("contact_name", contact_name)
    .single();

  if (existing) {
    const { data, error } = await supabaseAdmin
      .from("email_style_profiles")
      .update({ relationship, contact_email: encryptedEmail, style_text: encryptedStyle, updated_at: new Date().toISOString() })
      .eq("id", existing.id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    // Return decrypted for UI
    return res.json({ profile: { ...data, style_text, contact_email }, updated: true });
  }

  const { data, error } = await supabaseAdmin
    .from("email_style_profiles")
    .insert({ user_id: userId, relationship, contact_name, contact_email: encryptedEmail, style_text: encryptedStyle })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ profile: { ...data, style_text, contact_email }, created: true });
}

// DELETE /api/personalization/:id — delete a profile
export async function deleteStyleProfile(req: Request, res: Response) {
  const userId = req.user_id!;
  const { id } = req.params;
  const { error } = await supabaseAdmin
    .from("email_style_profiles")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ deleted: true });
}

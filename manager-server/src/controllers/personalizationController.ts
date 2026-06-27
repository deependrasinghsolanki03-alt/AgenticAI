import { Request, Response } from "express";
import { supabaseAdmin } from "../config/supabase.js";

// GET /api/personalization — list all profiles for user
export async function listStyleProfiles(req: Request, res: Response) {
  const userId = req.user_id!;
  const { data, error } = await supabaseAdmin
    .from("email_style_profiles")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ profiles: data });
}

// POST /api/personalization — save a new style profile
export async function saveStyleProfile(req: Request, res: Response) {
  const userId = req.user_id!;
  const { relationship, contact_name, contact_email, style_text } = req.body;
  if (!relationship || !contact_name || !style_text) {
    return res.status(400).json({ error: "relationship, contact_name, and style_text are required." });
  }
  
  // Upsert — if same relationship+contact exists, update it
  const { data: existing } = await supabaseAdmin
    .from("email_style_profiles")
    .select("id")
    .eq("user_id", userId)
    .eq("contact_name", contact_name)
    .single();
  
  if (existing) {
    const { data, error } = await supabaseAdmin
      .from("email_style_profiles")
      .update({ relationship, contact_email, style_text, updated_at: new Date().toISOString() })
      .eq("id", existing.id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ profile: data, updated: true });
  }
  
  const { data, error } = await supabaseAdmin
    .from("email_style_profiles")
    .insert({ user_id: userId, relationship, contact_name, contact_email, style_text })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ profile: data, created: true });
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

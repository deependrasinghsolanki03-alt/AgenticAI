import { google } from "googleapis";
import { supabaseAdmin } from "./supabase.js";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

export async function saveGoogleTokens(userId: string, refreshToken: string): Promise<void> {
  const { error } = await supabaseAdmin.from("user_tokens").upsert(
    { user_id: userId, google_refresh_token: refreshToken, updated_at: new Date().toISOString() },
    { onConflict: "user_id" }
  );
  if (error) {
    console.error("[GoogleAuth] Failed to save refresh token:", error.message);
    throw new Error("Failed to save Google credentials.");
  }
  console.log(`[GoogleAuth] Refresh token saved for user: ${userId}`);
}

export async function getGoogleAuthClient(userId: string): Promise<InstanceType<typeof google.auth.OAuth2> | null> {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    console.warn("[GoogleAuth] GOOGLE_CLIENT_ID/SECRET not set.");
    return null;
  }
  const { data, error } = await supabaseAdmin
    .from("user_tokens").select("google_refresh_token").eq("user_id", userId).single();
  if (error || !data?.google_refresh_token) {
    console.warn(`[GoogleAuth] No refresh token for user: ${userId}`);
    return null;
  }
  const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: data.google_refresh_token });
  return oauth2Client;
}

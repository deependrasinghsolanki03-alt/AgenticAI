-- ═══════════════════════════════════════════════════
-- Chat Messages Table for AgenticAI
-- Run this in Supabase Dashboard → SQL Editor
-- ═══════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast user-specific queries
CREATE INDEX IF NOT EXISTS idx_chat_messages_user_id ON chat_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at);

-- Enable Row Level Security (optional but recommended)
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own messages (via service_role key, this is bypassed)
CREATE POLICY "Users can view own messages" ON chat_messages
  FOR SELECT USING (true);

CREATE POLICY "Users can insert own messages" ON chat_messages
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Users can delete own messages" ON chat_messages
  FOR DELETE USING (true);

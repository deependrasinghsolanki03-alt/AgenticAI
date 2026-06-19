import { useState, useRef, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import MinionCharacter from '../components/MinionCharacter';

export default function Chat() {
  const { user, signOut } = useAuth();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [agentStatus, setAgentStatus] = useState('');
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, agentStatus]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Load chat history from Supabase on mount
  useEffect(() => {
    if (!user || historyLoaded) return;
    const loadHistory = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        if (!token) return;
        const res = await fetch('http://localhost:5000/api/chats', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const { messages: history } = await res.json();
          if (history && history.length > 0) {
            const loaded = history.map((m) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              timestamp: new Date(m.created_at),
            }));
            setMessages(loaded);
          } else {
            // No history — show welcome message
            setMessages([{
              id: 'welcome',
              role: 'assistant',
              content: 'Hello! I\'m your AI assistant. How can I help you today?',
              timestamp: new Date(),
            }]);
          }
        }
      } catch (err) {
        console.error('Failed to load chat history:', err);
      } finally {
        setHistoryLoaded(true);
      }
    };
    loadHistory();
  }, [user, historyLoaded]);

  // Helper: save a message to Supabase (fire-and-forget)
  const saveMessageToDB = async (role, content) => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) return;
      await fetch('http://localhost:5000/api/chats/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ role, content }),
      });
    } catch (err) {
      console.error('Failed to save message:', err);
    }
  };

  const sendMessage = async () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    const userMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    saveMessageToDB('user', trimmed);
    setIsLoading(true);
    setAgentStatus('Thinking...');

    try {
      // Get the current JWT token
      const {
        data: { session },
      } = await supabase.auth.getSession();

      const token = session?.access_token;
      const providerToken = session?.provider_token;
      if (!token) throw new Error('No valid session. Please sign in again.');

      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      };

      if (providerToken) {
        headers['X-Google-Token'] = providerToken;
      }

      const response = await fetch('http://localhost:5000/api/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify({ message: trimmed }),
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.error || `Server error: ${response.status}`);
      }

      // --- SSE streaming reader ---
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by double newlines
        const parts = buffer.split('\n\n');
        // Keep the last (possibly incomplete) chunk in the buffer
        buffer = parts.pop() || '';

        for (const part of parts) {
          const trimmedPart = part.trim();
          if (!trimmedPart) continue;

          // Parse event type and data from SSE lines
          let eventType = 'message';
          let dataStr = '';

          for (const line of trimmedPart.split('\n')) {
            if (line.startsWith('event:')) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              dataStr = line.slice(5).trim();
            }
          }

          if (!dataStr) continue;

          let payload;
          try {
            payload = JSON.parse(dataStr);
          } catch {
            continue; // skip malformed JSON
          }

          // Handle each SSE event type
          if (eventType === 'status') {
            const stage = payload.stage || '';
            const detail = payload.detail || 'Processing...';
            // Show stage-specific icons via status prefix
            if (stage === 'memory' || stage === 'planning' || stage === 'researching') {
              setAgentStatus(detail);
            } else {
              setAgentStatus(detail);
            }
          } else if (eventType === 'tool') {
            setAgentStatus(`Running Tool: ${payload.name || 'unknown'}`);
          } else if (eventType === 'done') {
            const assistantMessage = {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: payload.response || 'No response received.',
              timestamp: new Date(),
            };
            setMessages((prev) => [...prev, assistantMessage]);
            saveMessageToDB('assistant', assistantMessage.content);
            setIsLoading(false);
            setAgentStatus('');
          } else if (eventType === 'error') {
            const errorMessage = {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: `⚠️ Error: ${payload.message || 'Something went wrong'}`,
              timestamp: new Date(),
              isError: true,
            };
            setMessages((prev) => [...prev, errorMessage]);
            setIsLoading(false);
            setAgentStatus('');
          }
        }
      }
    } catch (err) {
      const errorMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `⚠️ Error: ${err.message}`,
        timestamp: new Date(),
        isError: true,
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
      setAgentStatus('');
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const formatTime = (date) => {
    return new Date(date).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="chat-layout">
      {/* Sidebar */}
      <aside className="chat-sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-logo">
            <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M16 2L28 8V24L16 30L4 24V8L16 2Z"
                fill="url(#sidebar-grad)"
                stroke="rgba(255,255,255,0.15)"
                strokeWidth="1"
              />
              <path
                d="M16 10C18.2091 10 20 11.7909 20 14C20 15.5977 19.0892 16.9744 17.7455 17.6153L20 24H12L14.2545 17.6153C12.9108 16.9744 12 15.5977 12 14C12 11.7909 13.7909 10 16 10Z"
                fill="rgba(255,255,255,0.9)"
              />
              <defs>
                <linearGradient id="sidebar-grad" x1="4" y1="2" x2="28" y2="30">
                  <stop stopColor="#6366f1" />
                  <stop offset="1" stopColor="#a855f7" />
                </linearGradient>
              </defs>
            </svg>
          </div>
          <span>AgenticAI</span>
        </div>

        <button className="new-chat-btn" onClick={() => setMessages([{
          id: 'welcome',
          role: 'assistant',
          content: 'Starting a new conversation. How can I help?',
          timestamp: new Date(),
        }])}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M8 3V13M3 8H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          New Chat
        </button>

        <div className="sidebar-spacer" />

        {/* User info & sign out */}
        <div className="sidebar-user">
          <div className="user-avatar">
            {user?.email?.charAt(0).toUpperCase() || 'U'}
          </div>
          <div className="user-info">
            <span className="user-email" title={user?.email}>
              {user?.email}
            </span>
            <span className="user-tenant">Tenant</span>
          </div>
          <button className="btn-signout" onClick={signOut} title="Sign out">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path
                d="M6.75 15.75H3.75C3.35218 15.75 2.97064 15.592 2.68934 15.3107C2.40804 15.0294 2.25 14.6478 2.25 14.25V3.75C2.25 3.35218 2.40804 2.97064 2.68934 2.68934C2.97064 2.40804 3.35218 2.25 3.75 2.25H6.75"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M12 12.75L15.75 9L12 5.25"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M15.75 9H6.75"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </aside>

      {/* Main Chat Area */}
      <main className="chat-main">
        {/* Header */}
        <header className="chat-header">
          <div>
            <h1>AI Assistant</h1>
            <span className="chat-header-status">
              <span className="status-dot" />
              Online
            </span>
          </div>
        </header>

        {/* Messages */}
        <div className="chat-messages">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`message ${msg.role === 'user' ? 'message-user' : 'message-assistant'} ${msg.isError ? 'message-error' : ''}`}
            >
              {msg.role === 'assistant' && (
                <div className="message-avatar assistant-avatar">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M12 2L20 7V17L12 22L4 17V7L12 2Z"
                      fill="currentColor"
                      opacity="0.8"
                    />
                  </svg>
                </div>
              )}
              <div className="message-body">
                <div className="message-content">{msg.content}</div>
                <span className="message-time">{formatTime(msg.timestamp)}</span>
              </div>
              {msg.role === 'user' && (
                <div className="message-avatar user-avatar">
                  {user?.email?.charAt(0).toUpperCase() || 'U'}
                </div>
              )}
            </div>
          ))}

          {/* Minion Loading Character */}
          {isLoading && (
            <div className="message message-assistant">
              <div className="message-body" style={{ display: 'flex', alignItems: 'center', gap: '0' }}>
                <MinionCharacter status={agentStatus} isActive={isLoading} />
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div className="chat-input-area">
          <div className="chat-input-wrapper">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type your message..."
              rows={1}
              disabled={isLoading}
              id="chat-input"
            />
            <button
              className="btn-send"
              onClick={sendMessage}
              disabled={!input.trim() || isLoading}
              title="Send message"
              id="send-button"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path
                  d="M15.75 2.25L8.25 9.75"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M15.75 2.25L10.5 15.75L8.25 9.75L2.25 7.5L15.75 2.25Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
          <p className="chat-disclaimer">
            AgenticAI may produce inaccurate information. Verify important details.
          </p>
        </div>
      </main>
    </div>
  );
}

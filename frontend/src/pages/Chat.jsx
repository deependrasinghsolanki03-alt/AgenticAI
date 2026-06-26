import { useState, useRef, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import MinionCharacter from '../components/MinionCharacter';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

// Enhanced markdown renderer for chat messages
function renderMarkdown(text) {
  if (!text) return '';
  // Process line by line for block elements
  const lines = text.split('\n');
  let html = '';
  let inList = false;
  let listType = '';

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    // Escape HTML
    line = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Headers
    if (line.match(/^### /)) { line = '<h4 class="md-h4">' + line.slice(4) + '</h4>'; }
    else if (line.match(/^## /)) { line = '<h3 class="md-h3">' + line.slice(3) + '</h3>'; }
    else if (line.match(/^# /)) { line = '<h2 class="md-h2">' + line.slice(2) + '</h2>'; }
    // Horizontal rule
    else if (line.match(/^---+$/)) { line = '<hr class="md-hr"/>'; }
    // Bullet list
    else if (line.match(/^[\s]*[-*•]\s/)) {
      const content = line.replace(/^[\s]*[-*•]\s/, '');
      if (!inList || listType !== 'ul') { if (inList) html += `</${listType}>`; html += '<ul class="md-list">'; inList = true; listType = 'ul'; }
      line = '<li>' + applyInline(content) + '</li>';
      html += line; continue;
    }
    // Numbered list
    else if (line.match(/^\s*\d+[.)]\s/)) {
      const content = line.replace(/^\s*\d+[.)]\s/, '');
      if (!inList || listType !== 'ol') { if (inList) html += `</${listType}>`; html += '<ol class="md-list">'; inList = true; listType = 'ol'; }
      line = '<li>' + applyInline(content) + '</li>';
      html += line; continue;
    }
    else {
      if (inList) { html += `</${listType}>`; inList = false; listType = ''; }
      if (line.trim() === '') { line = '<br/>'; }
      else { line = '<p class="md-p">' + applyInline(line) + '</p>'; }
    }
    html += line;
  }
  if (inList) html += `</${listType}>`;
  return html;
}

// Inline formatting: bold, italic, code, links
function applyInline(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}


export default function Chat() {
  const { user, signOut } = useAuth();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [agentStatus, setAgentStatus] = useState('');
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [scheduledTasks, setScheduledTasks] = useState([]);
  const [showTasks, setShowTasks] = useState(false);
  const [memories, setMemories] = useState([]);
  const [showMemories, setShowMemories] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState(null);
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef(null);
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

  // Fetch scheduled tasks
  const fetchScheduledTasks = async () => {
    try {
      const token = await getToken();
      if (!token) return;
      const res = await fetch(`${API_URL}/api/tasks?status=pending`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const { tasks } = await res.json();
        setScheduledTasks(tasks || []);
      }
    } catch (err) {
      console.error('Failed to fetch tasks:', err);
    }
  };

  // Load tasks on mount
  useEffect(() => {
    if (user) fetchScheduledTasks();
  }, [user]);

  // Cancel a scheduled task
  const cancelTask = async (taskId) => {
    try {
      const token = await getToken();
      if (!token) return;
      const res = await fetch(`${API_URL}/api/tasks/${taskId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setScheduledTasks(prev => prev.filter(t => t.id !== taskId));
      }
    } catch (err) {
      console.error('Failed to cancel task:', err);
    }
  };

  // Fetch memories
  const fetchMemories = async () => {
    try {
      const token = await getToken();
      if (!token) return;
      const res = await fetch(`${API_URL}/api/memories?limit=30`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const { memories: mems } = await res.json();
        setMemories(mems || []);
      }
    } catch (err) {
      console.error('Failed to fetch memories:', err);
    }
  };

  // Delete a memory
  const deleteMemory = async (memId) => {
    try {
      const token = await getToken();
      if (!token) return;
      const res = await fetch(`${API_URL}/api/memories/${memId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setMemories(prev => prev.filter(m => m.id !== memId));
      }
    } catch (err) {
      console.error('Failed to delete memory:', err);
    }
  };

  // HITL: Approve a pending action
  const approveAction = async (actionId) => {
    try {
      const token = await getToken();
      if (!token) return;
      const res = await fetch(`${API_URL}/api/actions/${actionId}/approve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setPendingConfirm(null);
      const statusMsg = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `✅ **Action Approved!** ${data.result || 'Email sent successfully.'}`,
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, statusMsg]);
      saveMessageToDB('assistant', statusMsg.content);
    } catch (err) {
      console.error('Approve failed:', err);
    }
  };

  // HITL: Reject a pending action
  const rejectAction = async (actionId) => {
    try {
      const token = await getToken();
      if (!token) return;
      await fetch(`${API_URL}/api/actions/${actionId}/reject`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      setPendingConfirm(null);
      const statusMsg = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '❌ **Action Rejected.** The email was not sent.',
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, statusMsg]);
      saveMessageToDB('assistant', statusMsg.content);
    } catch (err) {
      console.error('Reject failed:', err);
    }
  };

  // Voice Input (Web Speech API)
  const toggleVoiceInput = () => {
    if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
      alert('Voice input is not supported in your browser. Try Chrome.');
      return;
    }
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.lang = 'hi-IN';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => setIsListening(true);
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map(result => result[0].transcript)
        .join('');
      setInput(transcript);
    };
    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);
    recognitionRef.current = recognition;
    recognition.start();
  };

  // Helper: get auth token
  const getToken = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token;
  };

  // Load sessions on mount
  useEffect(() => {
    if (!user || sessionsLoaded) return;
    const loadSessions = async () => {
      try {
        const token = await getToken();
        if (!token) return;
        const res = await fetch(`${API_URL}/api/sessions`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const { sessions: loadedSessions } = await res.json();
          setSessions(loadedSessions || []);
          // Auto-select the most recent session
          if (loadedSessions && loadedSessions.length > 0) {
            const latestSession = loadedSessions[0];
            setActiveSessionId(latestSession.id);
            await loadSessionMessages(latestSession.id, token);
          } else {
            // No sessions — create first one
            await createNewSession();
          }
        }
      } catch (err) {
        console.error('Failed to load sessions:', err);
      } finally {
        setSessionsLoaded(true);
      }
    };
    loadSessions();
  }, [user, sessionsLoaded]);

  // Load messages for a session
  const loadSessionMessages = async (sessionId, tokenOverride) => {
    try {
      const token = tokenOverride || await getToken();
      if (!token) return;
      const res = await fetch(`${API_URL}/api/chats?session_id=${sessionId}`, {
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
          setMessages([{
            id: 'welcome',
            role: 'assistant',
            content: 'Hello! I\'m your AI assistant. How can I help you today?',
            timestamp: new Date(),
          }]);
        }
      }
    } catch (err) {
      console.error('Failed to load session messages:', err);
    }
  };

  // Switch to a session
  const switchSession = async (sessionId) => {
    if (sessionId === activeSessionId) return;
    setActiveSessionId(sessionId);
    setMessages([]);
    await loadSessionMessages(sessionId);
    inputRef.current?.focus();
  };

  // Create a new session
  const createNewSession = async () => {
    try {
      const token = await getToken();
      if (!token) return;
      const res = await fetch(`${API_URL}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: 'New Chat' }),
      });
      if (res.ok) {
        const { session } = await res.json();
        setSessions((prev) => [session, ...prev]);
        setActiveSessionId(session.id);
        setMessages([{
          id: 'welcome',
          role: 'assistant',
          content: 'Starting a new conversation. How can I help?',
          timestamp: new Date(),
        }]);
        inputRef.current?.focus();
      }
    } catch (err) {
      console.error('Failed to create session:', err);
    }
  };

  // Delete a session
  const deleteSessionById = async (e, sessionId) => {
    e.stopPropagation();
    try {
      const token = await getToken();
      if (!token) return;
      await fetch(`${API_URL}/api/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (activeSessionId === sessionId) {
        const remaining = sessions.filter((s) => s.id !== sessionId);
        if (remaining.length > 0) {
          switchSession(remaining[0].id);
        } else {
          createNewSession();
        }
      }
    } catch (err) {
      console.error('Failed to delete session:', err);
    }
  };

  // Save message to DB
  const saveMessageToDB = async (role, content) => {
    try {
      const token = await getToken();
      if (!token) return;
      await fetch(`${API_URL}/api/chats/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ role, content, session_id: activeSessionId }),
      });
      // If it's a user message, update session title in sidebar
      if (role === 'user') {
        const title = content.substring(0, 50) + (content.length > 50 ? '...' : '');
        setSessions((prev) =>
          prev.map((s) => s.id === activeSessionId ? { ...s, title, updated_at: new Date().toISOString() } : s)
        );
      }
    } catch (err) {
      console.error('Failed to save message:', err);
    }
  };

  const sendMessage = async () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    // If no active session, create one first
    if (!activeSessionId) {
      await createNewSession();
    }

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
      const { data: { session } } = await supabase.auth.getSession();
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

      const response = await fetch(`${API_URL}/api/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message: trimmed, session_id: activeSessionId }),
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

        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          const trimmedPart = part.trim();
          if (!trimmedPart) continue;

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
            continue;
          }

          if (eventType === 'status') {
            setAgentStatus(payload.detail || 'Processing...');
          } else if (eventType === 'tool') {
            setAgentStatus(`Running Tool: ${payload.name || 'unknown'}`);
          } else if (eventType === 'confirm') {
            // HITL: Store pending action for confirmation card
            setPendingConfirm({ action_id: payload.action_id, tool: payload.tool, args: payload.args });
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
      // Refresh tasks panel (in case a task was just scheduled/cancelled)
      fetchScheduledTasks();
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

  const formatSessionDate = (dateStr) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
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
          <div>
            <div style={{ fontWeight: 700, fontSize: '0.938rem' }}>AgenticAI</div>
            <div style={{ fontSize: '0.688rem', color: '#8b8fad', fontWeight: 400 }}>AI Digital Soul</div>
          </div>
        </div>

        <button className="new-chat-btn" onClick={createNewSession}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 3V13M3 8H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          + NEW CHAT
        </button>

        {/* Chat Session History */}
        <div className="session-list">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`session-item ${session.id === activeSessionId ? 'session-active' : ''}`}
              onClick={() => switchSession(session.id)}
            >
              <div className="session-item-content">
                <svg className="session-icon" width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M2 3h12M2 7h8M2 11h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
                <div className="session-text">
                  <span className="session-title">{session.title || 'New Chat'}</span>
                  <span className="session-time">{formatSessionDate(session.updated_at || session.created_at)}</span>
                </div>
              </div>
              <button
                className="session-delete-btn"
                onClick={(e) => deleteSessionById(e, session.id)}
                title="Delete chat"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          ))}
        </div>

        {/* Scheduled Tasks Panel */}
        <div className="tasks-section">
          <button className="tasks-toggle" onClick={() => { setShowTasks(!showTasks); if (!showTasks) fetchScheduledTasks(); }}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M8 1v6l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" fill="none" />
            </svg>
            Scheduled Tasks
            {scheduledTasks.length > 0 && (
              <span className="tasks-badge">{scheduledTasks.length}</span>
            )}
            <svg className={`tasks-chevron ${showTasks ? 'tasks-chevron-open' : ''}`} width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          {showTasks && (
            <div className="tasks-list">
              {scheduledTasks.length === 0 ? (
                <div className="tasks-empty">No scheduled tasks</div>
              ) : (
                scheduledTasks.map((task) => (
                  <div key={task.id} className="task-card">
                    <div className="task-card-header">
                      <span className="task-instruction">{task.instruction.length > 50 ? task.instruction.substring(0, 50) + '...' : task.instruction}</span>
                      <button className="task-cancel-btn" onClick={() => cancelTask(task.id)} title="Cancel task">
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                      </button>
                    </div>
                    <div className="task-card-details">
                      <span>⏰ {new Date(task.scheduled_time).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' })}</span>
                      {task.repeat_pattern && <span>🔄 {task.repeat_pattern}</span>}
                      {task.max_runs && <span>🔢 {task.run_count || 0}/{task.max_runs} runs</span>}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Memory Brain Panel */}
        <div className="tasks-section">
          <button className="tasks-toggle" onClick={() => { setShowMemories(!showMemories); if (!showMemories) fetchMemories(); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" fill="currentColor" opacity="0.7"/>
            </svg>
            Brain (Memories)
            {memories.length > 0 && (
              <span className="tasks-badge">{memories.length}</span>
            )}
            <svg className={`tasks-chevron ${showMemories ? 'tasks-chevron-open' : ''}`} width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          {showMemories && (
            <div className="tasks-list">
              {memories.length === 0 ? (
                <div className="tasks-empty">No memories stored yet</div>
              ) : (
                memories.map((mem) => (
                  <div key={mem.id} className="task-card">
                    <div className="task-card-header">
                      <span className="task-instruction">{mem.preview}</span>
                      <button className="task-cancel-btn" onClick={() => deleteMemory(mem.id)} title="Delete memory">
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                      </button>
                    </div>
                    <div className="task-card-details">
                      <span>{new Date(mem.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' })}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

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
                <div className="message-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
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

          {/* HITL Confirmation Card */}
          {pendingConfirm && (
            <div className="message message-assistant">
              <div className="message-body">
                <div className="confirm-card">
                  <div className="confirm-header">⚠️ Confirmation Required</div>
                  <div className="confirm-details">
                    <span className="confirm-tool">{pendingConfirm.tool === 'gmail_send' ? '📧 Send Email' : pendingConfirm.tool}</span>
                    {pendingConfirm.args?.to && <span>To: <strong>{pendingConfirm.args.to}</strong></span>}
                    {pendingConfirm.args?.subject && <span>Subject: <strong>{pendingConfirm.args.subject}</strong></span>}
                  </div>
                  <div className="confirm-actions">
                    <button className="confirm-btn confirm-approve" onClick={() => approveAction(pendingConfirm.action_id)}>
                      ✅ Approve & Send
                    </button>
                    <button className="confirm-btn confirm-reject" onClick={() => rejectAction(pendingConfirm.action_id)}>
                      ❌ Reject
                    </button>
                  </div>
                </div>
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
              className={`btn-mic ${isListening ? 'btn-mic-active' : ''}`}
              onClick={toggleVoiceInput}
              disabled={isLoading}
              title={isListening ? 'Stop listening' : 'Voice input'}
              id="mic-button"
            >
              {isListening ? (
                <span className="mic-pulse" />
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  <path d="M12 19v4M8 23h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              )}
            </button>
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

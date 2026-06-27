// ─── Socket.io Hook ─────────────────────────────
// Provides a Socket.io connection with auth for real-time chat
// Falls back gracefully - SSE is still the primary transport

import { useEffect, useRef, useState, useCallback } from 'react';
import { io } from 'socket.io-client';
import { supabase } from '../lib/supabaseClient';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

export function useSocket() {
  const socketRef = useRef(null);
  const [isConnected, setIsConnected] = useState(false);
  const [useWebSocket, setUseWebSocket] = useState(false);

  const connect = useCallback(async () => {
    if (socketRef.current?.connected) return;

    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return;

    const socket = io(API_URL, {
      auth: { token: session.access_token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 2000,
    });

    socket.on('connect', () => {
      console.log('[Socket.io] Connected');
      setIsConnected(true);
    });

    socket.on('disconnect', (reason) => {
      console.log('[Socket.io] Disconnected:', reason);
      setIsConnected(false);
    });

    socket.on('connect_error', (err) => {
      console.warn('[Socket.io] Connection error:', err.message);
      setIsConnected(false);
    });

    socketRef.current = socket;
  }, []);

  const disconnect = useCallback(() => {
    socketRef.current?.disconnect();
    socketRef.current = null;
    setIsConnected(false);
  }, []);

  // Send chat message via WebSocket
  const sendChat = useCallback((message, sessionId, file, callbacks) => {
    const socket = socketRef.current;
    if (!socket?.connected) {
      callbacks.onError?.('WebSocket not connected');
      return false;
    }

    // Set up one-time listeners for this chat
    const cleanup = () => {
      socket.off('status', onStatus);
      socket.off('tool', onTool);
      socket.off('confirm', onConfirm);
      socket.off('done', onDone);
      socket.off('error', onError);
    };

    const onStatus = (data) => callbacks.onStatus?.(data);
    const onTool = (data) => callbacks.onTool?.(data);
    const onConfirm = (data) => callbacks.onConfirm?.(data);
    const onDone = (data) => { cleanup(); callbacks.onDone?.(data); };
    const onError = (data) => { cleanup(); callbacks.onError?.(data.message); };

    socket.on('status', onStatus);
    socket.on('tool', onTool);
    socket.on('confirm', onConfirm);
    socket.on('done', onDone);
    socket.on('error', onError);

    // Send the message
    const payload = { message, session_id: sessionId };
    if (file) payload.file = file;
    socket.emit('chat', payload);

    return true;
  }, []);

  useEffect(() => {
    return () => disconnect();
  }, [disconnect]);

  return {
    connect,
    disconnect,
    sendChat,
    isConnected,
    useWebSocket,
    setUseWebSocket,
    socket: socketRef.current,
  };
}

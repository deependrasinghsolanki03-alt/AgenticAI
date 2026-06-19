import { useState, useEffect, useRef } from 'react';

// Map status text to minion video state
function getMinionState(statusText) {
  if (!statusText) return 'idle';
  const text = statusText.toLowerCase();

  if (text.includes('calendar') || text.includes('scheduler')) return 'calendar';
  if (text.includes('email') || text.includes('gmail')) return 'email';
  if (text.includes('memory') || text.includes('retrieving')) return 'memory';
  if (text.includes('search') || text.includes('research') || text.includes('worker') || text.includes('web')) return 'searching';
  if (text.includes('rate limit') || text.includes('waiting') || text.includes('retrying')) return 'waiting';
  if (text.includes('planning') || text.includes('thinking') || text.includes('preparing') || text.includes('responding')) return 'thinking';

  return 'thinking'; // Default when processing
}

const VIDEO_MAP = {
  idle: '/minion/idle.webm',
  thinking: '/minion/thinking.webm',
  calendar: '/minion/calendar.webm',
  email: '/minion/email.webm',
  memory: '/minion/memory.webm',
  searching: '/minion/searching.webm',
  waiting: '/minion/waiting.webm',
};

const STATE_LABELS = {
  idle: '',
  thinking: '🧠 Thinking...',
  calendar: '📅 Calendar',
  email: '✉️ Email',
  memory: '💾 Memory',
  searching: '🔍 Searching',
  waiting: '⏳ Waiting...',
};

export default function MinionCharacter({ status, isActive }) {
  const [currentState, setCurrentState] = useState('idle');
  const [isTransitioning, setIsTransitioning] = useState(false);
  const videoRef = useRef(null);

  useEffect(() => {
    const newState = isActive ? getMinionState(status) : 'idle';
    if (newState !== currentState) {
      setIsTransitioning(true);
      // Small delay for fade transition
      setTimeout(() => {
        setCurrentState(newState);
        setIsTransitioning(false);
      }, 200);
    }
  }, [status, isActive]);

  // Restart video when state changes
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.load();
      videoRef.current.play().catch(() => {});
    }
  }, [currentState]);

  return (
    <div className={`minion-container ${isActive ? 'minion-active' : 'minion-idle'}`}>
      <div className={`minion-video-wrapper ${isTransitioning ? 'minion-fading' : ''}`}>
        <video
          ref={videoRef}
          src={VIDEO_MAP[currentState]}
          autoPlay
          loop
          muted
          playsInline
          className="minion-video"
        />
      </div>
      {isActive && status && (
        <div className="minion-status-label">
          <span className="minion-status-text">{status}</span>
        </div>
      )}
    </div>
  );
}

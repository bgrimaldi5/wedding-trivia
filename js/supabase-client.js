// ============================================================
// js/supabase-client.js
// Central Supabase connection — imported by all other JS files
// ============================================================

// ⚠️  REPLACE THESE TWO VALUES with your own from Supabase:
//     Dashboard → Settings → API → Project URL & anon/public key
const SUPABASE_URL = 'https://ewnhleajhqirptacrazx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV3bmhsZWFqaHFpcnB0YWNyYXp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg4NDk3MjcsImV4cCI6MjA5NDQyNTcyN30.MdH9_RuOJ064aQWUO-15ZNvhl7abi15VVDva1a8QdiU';

// This loads the Supabase library (included via CDN in each HTML file)
const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================================
// SESSION HELPER
// Keeps the player "remembered" even if they close the browser
// ============================================================

// Generate a random ID to identify this browser session
function generateSessionId() {
  return 'session_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
}

// Get or create a session ID stored in localStorage
function getSessionId() {
  let sessionId = localStorage.getItem('wedding_trivia_session');
  if (!sessionId) {
    sessionId = generateSessionId();
    localStorage.setItem('wedding_trivia_session', sessionId);
  }
  return sessionId;
}

// Save player info to localStorage (survives page refresh)
function savePlayerSession(player) {
  localStorage.setItem('wedding_trivia_player', JSON.stringify(player));
}

// Retrieve saved player info
function getPlayerSession() {
  const saved = localStorage.getItem('wedding_trivia_player');
  return saved ? JSON.parse(saved) : null;
}

// Clear saved session (used on game end or reset)
function clearPlayerSession() {
  localStorage.removeItem('wedding_trivia_player');
  localStorage.removeItem('wedding_trivia_session');
  localStorage.removeItem('wedding_trivia_reset_token');
}

// Save the reset token this player joined under
function saveResetToken(token) {
  localStorage.setItem('wedding_trivia_reset_token', token);
}

// Get the reset token this player joined under
function getResetToken() {
  return localStorage.getItem('wedding_trivia_reset_token');
}


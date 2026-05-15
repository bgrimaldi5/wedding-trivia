// ============================================================
// js/landing.js
// Handles the "enter your name and join" page
// ============================================================

// When the page loads, check if this player already has a session
// (i.e. they refreshed or came back) — if so, send them straight to /play.html
window.addEventListener('DOMContentLoaded', async () => {
  const existingPlayer = getPlayerSession();
  if (existingPlayer) {
    // Verify the player still exists in the database
    const { data } = await db
      .from('players')
      .select('id, name')
      .eq('id', existingPlayer.id)
      .single();

    if (data) {
      // Player exists — send them back to the game
      window.location.href = 'play.html';
      return;
    } else {
      // Player was removed (game reset) — clear local session
      clearPlayerSession();
    }
  }
});

// Allow pressing Enter to submit
document.getElementById('playerName').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') joinGame();
});

// Main join function — called when button is clicked
async function joinGame() {
  const nameInput = document.getElementById('playerName');
  const errorMsg = document.getElementById('errorMsg');
  const joinBtn = document.getElementById('joinBtn');

  const name = nameInput.value.trim();

  // --- Validate ---
  if (!name) {
    showError('Please enter your name to join! 💌');
    nameInput.focus();
    return;
  }

  if (name.length < 2) {
    showError('Name must be at least 2 characters.');
    return;
  }

  // --- Disable button while working ---
  joinBtn.disabled = true;
  joinBtn.textContent = 'Joining...';
  hideError();

  try {
    const sessionId = getSessionId();

    // Check if this session already has a player (edge case)
    const { data: existingBySession } = await db
      .from('players')
      .select('*')
      .eq('session_id', sessionId)
      .single();

    let player;

    if (existingBySession) {
      // Session already registered — just use that player
      player = existingBySession;
    } else {
      // Create a new player record in Supabase
      const { data: newPlayer, error } = await db
        .from('players')
        .insert({ session_id: sessionId, name: name, score: 0 })
        .select()
        .single();

      if (error) {
        // Handle duplicate name (optional: you can remove this restriction)
        if (error.code === '23505') {
          showError('Someone already joined with that name. Try a different one!');
        } else {
          showError('Something went wrong. Please try again.');
          console.error('Join error:', error);
        }
        joinBtn.disabled = false;
        joinBtn.innerHTML = '💌 &nbsp; Join the Celebration';
        return;
      }

      player = newPlayer;
    }

    // Save player info to localStorage so we remember them on refresh
    savePlayerSession(player);

    // Save the current reset token so we can detect future resets
    const { data: gameState } = await db
      .from('game_state')
      .select('reset_token')
      .eq('id', 1)
      .single();
    if (gameState) saveResetToken(gameState.reset_token);

    // Send them to the game waiting room
    window.location.href = 'play.html';

  } catch (err) {
    console.error('Unexpected error:', err);
    showError('Connection error. Please check your internet and try again.');
    joinBtn.disabled = false;
    joinBtn.innerHTML = '💌 &nbsp; Join the Celebration';
  }
}

function showError(msg) {
  const el = document.getElementById('errorMsg');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideError() {
  document.getElementById('errorMsg').classList.add('hidden');
}

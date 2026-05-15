// ============================================================
// js/play.js
// Guest game experience — listens to Supabase realtime and
// updates the screen based on game_state changes
// ============================================================

// ---- State ----
let currentPlayer = null;     // The player object from localStorage
let currentQuestion = null;   // The current question object
let myAnswer = null;          // What the player selected (null = not yet answered)
let allQuestions = [];        // All questions loaded from DB

// ============================================================
// INITIALIZATION
// ============================================================

window.addEventListener('DOMContentLoaded', async () => {
  // 1. Check if this player has a session
  currentPlayer = getPlayerSession();
  if (!currentPlayer) {
    // No session found — redirect to the join page
    window.location.href = 'index.html';
    return;
  }

  // 2. Verify the player still exists in the database
  const { data: freshPlayer } = await db
    .from('players')
    .select('*')
    .eq('id', currentPlayer.id)
    .single();

  if (!freshPlayer) {
    // Player was removed — clear session and go back to join
    clearPlayerSession();
    window.location.href = 'index.html';
    return;
  }

  // Update local player with fresh data (score may have changed)
  currentPlayer = freshPlayer;
  savePlayerSession(currentPlayer);

  // 3. Load all questions
  const { data: questions } = await db
    .from('questions')
    .select('*')
    .order('order_index', { ascending: true });
  allQuestions = questions || [];

  // 4. Get current game state and render accordingly
  const { data: gameState } = await db
    .from('game_state')
    .select('*')
    .eq('id', 1)
    .single();

  if (gameState) {
    await renderScreen(gameState);
  }

  // 5. Subscribe to real-time game state changes
  subscribeToGameState();

  // 6. Subscribe to player count changes (for lobby)
  subscribeToPlayerCount();
});

// ============================================================
// REALTIME SUBSCRIPTIONS
// ============================================================

function subscribeToGameState() {
  // This is like a "radio receiver" — whenever game_state changes
  // in Supabase, this function fires and updates the screen
  db
    .channel('game-state-channel')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'game_state', filter: 'id=eq.1' },
      async (payload) => {
        console.log('Game state changed:', payload.new);
        await renderScreen(payload.new);
      }
    )
    .subscribe();
}

function subscribeToPlayerCount() {
  // Update lobby player count in real time
  db
    .channel('player-count-channel')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'players' },
      async () => {
        await updateLobbyCount();
      }
    )
    .subscribe();
}

// ============================================================
// SCREEN ROUTER
// Based on game_state, decide which screen to show
// ============================================================

async function renderScreen(gameState) {
  const { status, current_question_index, answers_locked, answers_revealed } = gameState;

  if (status === 'lobby') {
    showScreen('screen-lobby');
    document.getElementById('lobby-player-name').textContent = currentPlayer.name;
    await updateLobbyCount();

  } else if (status === 'active' || status === 'answers_locked') {
    // Show question screen
    const question = allQuestions[current_question_index];
    if (!question) return;

    // If this is a new question (different from what we're showing), reset answer
    if (!currentQuestion || currentQuestion.id !== question.id) {
      currentQuestion = question;
      myAnswer = null;

      // Check if player already answered this question (e.g. after refresh)
      const { data: existingAnswer } = await db
        .from('answers')
        .select('chosen_answer')
        .eq('player_id', currentPlayer.id)
        .eq('question_id', question.id)
        .single();

      if (existingAnswer) {
        myAnswer = existingAnswer.chosen_answer;
      }
    }

    showScreen('screen-question');
    renderQuestion(question, current_question_index, answers_locked);

  } else if (status === 'answer_reveal') {
    // Show the answer reveal screen
    const question = allQuestions[current_question_index];
    if (!question) return;
    currentQuestion = question;

    // Refresh player score from DB
    const { data: freshPlayer } = await db
      .from('players')
      .select('score')
      .eq('id', currentPlayer.id)
      .single();
    if (freshPlayer) {
      currentPlayer.score = freshPlayer.score;
      savePlayerSession(currentPlayer);
    }

    showScreen('screen-reveal');
    renderReveal(question);

  } else if (status === 'finished') {
    // Load final leaderboard
    await renderLeaderboard();
    showScreen('screen-leaderboard');
  }
}

// ============================================================
// RENDER: LOBBY PLAYER COUNT
// ============================================================

async function updateLobbyCount() {
  const { count } = await db
    .from('players')
    .select('*', { count: 'exact', head: true });

  const el = document.getElementById('lobby-player-count');
  if (el) {
    el.textContent = `${count || 0} player${count === 1 ? '' : 's'} joined`;
  }
}

// ============================================================
// RENDER: QUESTION SCREEN
// ============================================================

function renderQuestion(question, index, answersLocked) {
  // Question number
  document.getElementById('q-number').textContent = `Question ${index + 1} of ${allQuestions.length}`;

  // Score
  document.getElementById('q-score').textContent = `⭐ ${currentPlayer.score} pts`;

  // Question text
  document.getElementById('q-text').textContent = question.question_text;

  // Build answer buttons
  const choices = getChoices(question);
  const container = document.getElementById('answer-choices');
  container.innerHTML = '';

  const alreadyAnswered = myAnswer !== null;
  const isLocked = answersLocked || alreadyAnswered;

  choices.forEach(({ letter, text }) => {
    const btn = document.createElement('button');
    btn.className = 'answer-btn';
    btn.disabled = isLocked;

    if (myAnswer === letter) btn.classList.add('selected');

    btn.innerHTML = `
      <span class="choice-letter">${letter}</span>
      <span>${text}</span>
    `;

    btn.onclick = () => submitAnswer(letter, question);
    container.appendChild(btn);
  });

  // Show waiting message if already answered
  const waitingMsg = document.getElementById('q-waiting-msg');
  if (alreadyAnswered) {
    waitingMsg.classList.remove('hidden');
  } else {
    waitingMsg.classList.add('hidden');
  }
}

// ============================================================
// SUBMIT ANSWER
// ============================================================

async function submitAnswer(chosenLetter, question) {
  if (myAnswer !== null) return;  // Already answered, ignore

  myAnswer = chosenLetter;

  // Optimistically update UI
  const buttons = document.querySelectorAll('#answer-choices .answer-btn');
  buttons.forEach(btn => {
    btn.disabled = true;
    const letter = btn.querySelector('.choice-letter').textContent;
    if (letter === chosenLetter) btn.classList.add('selected');
  });

  document.getElementById('q-waiting-msg').classList.remove('hidden');

  // Save to database
  const isCorrect = chosenLetter === question.correct_answer;

  const { error } = await db
    .from('answers')
    .insert({
      player_id: currentPlayer.id,
      question_id: question.id,
      chosen_answer: chosenLetter,
      is_correct: isCorrect,
    });

  if (error) {
    console.error('Error submitting answer:', error);
    // If duplicate (already answered), that's fine
  }

  // If correct, update player score
  if (isCorrect) {
    const newScore = currentPlayer.score + 1;
    await db
      .from('players')
      .update({ score: newScore })
      .eq('id', currentPlayer.id);
    currentPlayer.score = newScore;
    savePlayerSession(currentPlayer);
  }
}

// ============================================================
// RENDER: ANSWER REVEAL SCREEN
// ============================================================

function renderReveal(question) {
  const choices = getChoices(question);
  const correctLetter = question.correct_answer;

  // Did the player answer correctly?
  const playerGotItRight = myAnswer === correctLetter;
  const playerDidAnswer = myAnswer !== null;

  // Result emoji and message
  const resultEl = document.getElementById('reveal-result');
  const messageEl = document.getElementById('reveal-message');

  if (!playerDidAnswer) {
    resultEl.textContent = '😶';
    messageEl.textContent = "You didn't answer in time";
    messageEl.className = '';
  } else if (playerGotItRight) {
    resultEl.textContent = '🎉';
    messageEl.textContent = 'Correct! Well done!';
    messageEl.className = 'text-success';
  } else {
    resultEl.textContent = '💙';
    messageEl.textContent = 'Not quite — better luck next round!';
    messageEl.className = 'text-error';
  }

  // Repeat the question
  document.getElementById('reveal-question').textContent = question.question_text;

  // Show answer choices with correct/wrong highlighting
  const container = document.getElementById('reveal-choices');
  container.innerHTML = '';

  choices.forEach(({ letter, text }) => {
    const btn = document.createElement('button');
    btn.className = 'answer-btn';
    btn.disabled = true;

    if (letter === correctLetter) {
      btn.classList.add('correct');
    } else if (letter === myAnswer && myAnswer !== correctLetter) {
      btn.classList.add('wrong');
    }

    btn.innerHTML = `
      <span class="choice-letter">${letter}</span>
      <span>${text}</span>
    `;

    container.appendChild(btn);
  });

  // Updated score
  document.getElementById('reveal-score').textContent = currentPlayer.score;
}

// ============================================================
// RENDER: FINAL LEADERBOARD
// ============================================================

async function renderLeaderboard() {
  const { data: players } = await db
    .from('players')
    .select('name, score')
    .order('score', { ascending: false });

  document.getElementById('my-final-score').textContent = currentPlayer.score;

  const list = document.getElementById('final-leaderboard');
  list.innerHTML = '';

  if (!players) return;

  players.forEach((player, index) => {
    const li = document.createElement('li');
    li.className = 'leaderboard-item';

    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '';
    const isMe = player.name === currentPlayer.name;

    li.innerHTML = `
      <span class="rank-number">${medal || (index + 1)}</span>
      <span class="player-name">${player.name}${isMe ? ' 👈 You' : ''}</span>
      <span class="player-score">${player.score} pts</span>
    `;

    list.appendChild(li);
  });
}

// ============================================================
// HELPERS
// ============================================================

// Returns the answer choices for a question (2 or 3 options, no blanks)
function getChoices(question) {
  const choices = [
    { letter: 'A', text: question.option_a },
    { letter: 'B', text: question.option_b },
  ];
  // Only include C if it has content
  if (question.option_c && question.option_c.trim() !== '') {
    choices.push({ letter: 'C', text: question.option_c });
  }
  return choices;
}

// Show only the specified screen, hide all others
function showScreen(screenId) {
  const screens = [
    'screen-lobby',
    'screen-question',
    'screen-reveal',
    'screen-leaderboard',
  ];
  screens.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      if (id === screenId) {
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    }
  });
}

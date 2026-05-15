// ============================================================
// js/play.js
// Guest game experience — listens to Supabase realtime and
// updates the screen based on game_state changes
// ============================================================

// ---- State ----
let currentPlayer = null;     // The player object from localStorage
let currentQuestion = null;   // The current question object
let myAnswer = null;          // What the player has selected this round (null = none yet)
let allQuestions = [];        // All questions loaded from DB

// ============================================================
// INITIALIZATION
// ============================================================

window.addEventListener('DOMContentLoaded', async () => {
  // 1. Check if this player has a session
  currentPlayer = getPlayerSession();
  if (!currentPlayer) {
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
    clearPlayerSession();
    window.location.href = 'index.html';
    return;
  }

  currentPlayer = freshPlayer;
  savePlayerSession(currentPlayer);

  // 3. Load all questions
  const { data: questions } = await db
    .from('questions')
    .select('*')
    .order('order_index', { ascending: true });
  allQuestions = questions || [];

  // 4. Get current game state and render
  const { data: gameState } = await db
    .from('game_state')
    .select('*')
    .eq('id', 1)
    .single();

  if (gameState) {
    await renderScreen(gameState);
  }

  // 5. Subscribe to game state changes
  subscribeToGameState();

  // 6. Subscribe to player deletions — this is how we detect a game reset
  subscribeToPlayerDeletion();

  // 7. Subscribe to player count changes (for lobby counter)
  subscribeToPlayerCount();
});

// ============================================================
// REALTIME SUBSCRIPTIONS
// ============================================================

function subscribeToGameState() {
  db
    .channel('game-state-channel')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'game_state', filter: 'id=eq.1' },
      async (payload) => {
        await renderScreen(payload.new);
      }
    )
    .subscribe();
}

function subscribeToPlayerDeletion() {
  // Watch for DELETE events on the players table.
  // When the admin resets the game, all players are deleted.
  // If our own player record gets deleted, boot us back to the join page.
  db
    .channel('player-delete-channel')
    .on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'players' },
      async (payload) => {
        // payload.old contains the deleted row's id
        if (payload.old && payload.old.id === currentPlayer.id) {
          clearPlayerSession();
          window.location.href = 'index.html';
        }
      }
    )
    .subscribe();
}

function subscribeToPlayerCount() {
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
// ============================================================

async function renderScreen(gameState) {
  const { status, current_question_index, answers_locked } = gameState;

  if (status === 'lobby') {
    showScreen('screen-lobby');
    document.getElementById('lobby-player-name').textContent = currentPlayer.name;
    await updateLobbyCount();

  } else if (status === 'active' || status === 'answers_locked') {
    const question = allQuestions[current_question_index];
    if (!question) return;

    // Detect if this is a brand new question we haven't seen yet
    const isNewQuestion = !currentQuestion || currentQuestion.id !== question.id;

    if (isNewQuestion) {
      // Always start fresh — no answer selected for a new question
      currentQuestion = question;
      myAnswer = null;

      // Only restore a previous answer if answers are already locked
      // (handles the refresh-mid-lock-phase case)
      if (answers_locked) {
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
    }

    showScreen('screen-question');
    renderQuestion(question, current_question_index, answers_locked);

  } else if (status === 'answer_reveal') {
    const question = allQuestions[current_question_index];
    if (!question) return;
    currentQuestion = question;

    // Make sure myAnswer reflects whatever was last saved to DB
    const { data: savedAnswer } = await db
      .from('answers')
      .select('chosen_answer')
      .eq('player_id', currentPlayer.id)
      .eq('question_id', question.id)
      .single();
    if (savedAnswer) myAnswer = savedAnswer.chosen_answer;

    // Calculate and save score for this question (only adds points once)
    await updateScoreForQuestion(question);

    // Refresh score from DB after update
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
  document.getElementById('q-number').textContent = `Question ${index + 1} of ${allQuestions.length}`;
  document.getElementById('q-score').textContent = `⭐ ${currentPlayer.score} pts`;
  document.getElementById('q-text').textContent = question.question_text;

  const choices = getChoices(question);
  const container = document.getElementById('answer-choices');
  container.innerHTML = '';

  choices.forEach(({ letter, text }) => {
    const btn = document.createElement('button');
    btn.className = 'answer-btn';

    // Disable buttons only when admin has locked answers
    btn.disabled = answersLocked;

    // Highlight whichever answer is currently selected
    if (myAnswer === letter) btn.classList.add('selected');

    btn.innerHTML = `
      <span class="choice-letter">${letter}</span>
      <span>${text}</span>
    `;

    btn.onclick = () => selectAnswer(letter, question);
    container.appendChild(btn);
  });

  // Show "waiting" message only after answers are locked
  const waitingMsg = document.getElementById('q-waiting-msg');
  if (answersLocked && myAnswer !== null) {
    waitingMsg.classList.remove('hidden');
  } else {
    waitingMsg.classList.add('hidden');
  }
}

// ============================================================
// SELECT / CHANGE ANSWER
// Players can freely change their answer until admin locks
// ============================================================

async function selectAnswer(chosenLetter, question) {
  // Do nothing if answers are locked (button should be disabled anyway, but belt-and-suspenders)
  if (!currentQuestion || currentQuestion.id !== question.id) return;

  const previousAnswer = myAnswer;
  myAnswer = chosenLetter;

  // Update button highlight immediately for responsiveness
  document.querySelectorAll('#answer-choices .answer-btn').forEach(btn => {
    const letter = btn.querySelector('.choice-letter').textContent;
    btn.classList.toggle('selected', letter === chosenLetter);
  });

  const isCorrect = chosenLetter === question.correct_answer;

  if (previousAnswer === null) {
    // First time answering — INSERT a new record
    await db.from('answers').insert({
      player_id: currentPlayer.id,
      question_id: question.id,
      chosen_answer: chosenLetter,
      is_correct: isCorrect,
    });
  } else {
    // Changing answer — UPDATE the existing record
    await db.from('answers')
      .update({ chosen_answer: chosenLetter, is_correct: isCorrect })
      .eq('player_id', currentPlayer.id)
      .eq('question_id', question.id);
  }
  // Note: scores are NOT updated here.
  // Scoring happens when the host clicks Reveal Answer,
  // which triggers the answer_reveal status, which calls updateScoreForQuestion().
}

// ============================================================
// RENDER: ANSWER REVEAL SCREEN
// ============================================================

// ============================================================
// SCORING — runs at reveal time, not at answer submission
// Uses the answer already saved in the DB (the player's final choice)
// ============================================================

async function updateScoreForQuestion(question) {
  const { data: savedAnswer } = await db
    .from('answers')
    .select('chosen_answer, is_correct')
    .eq('player_id', currentPlayer.id)
    .eq('question_id', question.id)
    .single();

  if (!savedAnswer) return; // Player didn't answer

  if (savedAnswer.is_correct) {
    // Count ALL correct answers to get total score — avoids double-counting on refresh
    const { count } = await db
      .from('answers')
      .select('*', { count: 'exact', head: true })
      .eq('player_id', currentPlayer.id)
      .eq('is_correct', true);

    await db
      .from('players')
      .update({ score: count || 0 })
      .eq('id', currentPlayer.id);
  }
}

// ---- EDIT YOUR RESPONSES HERE ----
// Each entry has an emoji and a text message.
// Add, remove, or change any of them freely.

const correctResponses = [
  { emoji: '💃', text: 'You're not confused Greg, you nailed it!' },
  { emoji: '👀', text: 'Correct!! Were you eavesdropping at brunch?' },
  { emoji: '🎂', text: 'Correct! You get an extra slice of cake (Mentally... the cake budget is unfortunetly maxed out).' },
  { emoji: '🥂', text: 'You got it — Ben's crunching the numbers and... it's confirmed, you're a genius!' },
  { emoji: '🤌', text: 'Absolutely flawless. Just like Ben.' },
  { emoji: '👑', text: "Correct! At least someone's been listening to Josie ramble!" },
  { emoji: '🕵️', text: 'How did you know that? Are you stalking us?' }
  { emoji: '🫶', text: 'Yayy! Josie always knew you were her biggest fan.' }
  { emoji: '🍾', text: 'Sparkling answer! Just like a nice glass of Josie's favorite moscato!' }
  { emoji: '🕺', text: 'Nailed it! Save that winner energy for the dance floor!' },
];

const wrongResponses = [
  { emoji: '💀', text: 'Wrong! Did you even come to the right wedding??' },
  { emoji: '😬', text: 'Ooh, so close! (Not really, but it's fine)' },
  { emoji: '🫣', text: 'That was bad, keep in mind Ben will get a spreadsheet with all your answers.' },
  { emoji: '😭', text: 'Incorrect! Don\'t cry though — there\'s still some chocolate covered strawberries left.' }
  { emoji: '🤔', text: 'Interesting choice... but no.' },
  { emoji: '🥲', text: 'A bold choice. A terrible choice, but bold.' },
  { emoji: '📉', text: 'Incorrect! Your stock is dropping fast at this table.' },
  { emoji: '🙃', text: 'Are you just guessing? Take a sip and reflect on your choices.' }
  { emoji: '👎', text: 'Why did you even come here if you weren't going to take this seriously???' }
  { emoji: '😅', text: 'Nope. We\'re going to pretend that didn\'t happen.' },
];

const noAnswerResponses = [
  { emoji: '😶', text: "You didn't answer in time! Stop thinking about the beach and FOCUS" },
  { emoji: '🙈', text: "No answer? Bold strategy." },
  { emoji: '🍷', text: "Too busy at the bar to answer? Fair." }
  { emoji: '🤐', text: "Silence is not a valid answer, but Josie respects the audacity." },
];

// ---- END OF EDITABLE RESPONSES ----

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function renderReveal(question) {
  const choices = getChoices(question);
  const correctLetter = question.correct_answer;
  const playerGotItRight = myAnswer === correctLetter;
  const playerDidAnswer = myAnswer !== null;

  const resultEl = document.getElementById('reveal-result');
  const messageEl = document.getElementById('reveal-message');

  if (!playerDidAnswer) {
    const r = pickRandom(noAnswerResponses);
    resultEl.textContent = r.emoji;
    messageEl.textContent = r.text;
    messageEl.className = '';
  } else if (playerGotItRight) {
    const r = pickRandom(correctResponses);
    resultEl.textContent = r.emoji;
    messageEl.textContent = r.text;
    messageEl.className = 'text-success';
  } else {
    const r = pickRandom(wrongResponses);
    resultEl.textContent = r.emoji;
    messageEl.textContent = r.text;
    messageEl.className = 'text-error';
  }

  document.getElementById('reveal-question').textContent = question.question_text;

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

  const myRank = players.findIndex(p => p.name === currentPlayer.name) + 1;
  const total = players.length;

  let rankMessage = '';
  if (myRank === 1) {
    rankMessage = "🏆 You won! Someone's been stalking the couple's Instagram.";
  } else if (myRank === 2) {
    rankMessage = '🥈 So close! First loser, but still a winner in our hearts.';
  } else if (myRank === 3) {
    rankMessage = '🥉 Third place! The bronze medal is basically gold if you squint.';
  } else if (total > 4 && myRank === total) {
    rankMessage = '💀 Dead last. Do you even know these people?';
  } else if (total > 6 && myRank >= Math.floor(total * 0.75)) {
    rankMessage = '😬 Bottom of the pack. Were you even paying attention?';
  } else if (myRank <= Math.ceil(total / 2)) {
    rankMessage = '👏 Top half! Not bad for someone who found their seat 10 minutes late.';
  } else {
    rankMessage = '🤷 Middle of the road. Solidly average — just like the dinner rolls.';
  }

  document.getElementById('leaderboard-rank-message').textContent = rankMessage;

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

function getChoices(question) {
  const choices = [
    { letter: 'A', text: question.option_a },
    { letter: 'B', text: question.option_b },
  ];
  if (question.option_c && question.option_c.trim() !== '') {
    choices.push({ letter: 'C', text: question.option_c });
  }
  return choices;
}

function showScreen(screenId) {
  const screens = ['screen-lobby', 'screen-question', 'screen-reveal', 'screen-leaderboard'];
  screens.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', id !== screenId);
  });
}


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

  // If game resets to lobby, check if this player still exists —
  // if they were wiped, send them back to enter their name
  if (status === 'lobby') {
    const { data: stillExists } = await db
      .from('players')
      .select('id')
      .eq('id', currentPlayer.id)
      .single();

    if (!stillExists) {
      clearPlayerSession();
      window.location.href = 'index.html';
      return;
    }

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

// Rotating response pools
const correctResponses = [
  { emoji: '🎉', text: 'Correct! You nailed it!' },
  { emoji: '🌟', text: 'Yes! Look at you go!' },
  { emoji: '💃', text: 'Correct! Get on the dance floor!' },
  { emoji: '🥂', text: 'Right answer — cheers to you!' },
  { emoji: '🎯', text: 'Bullseye! Correct!' },
  { emoji: '👑', text: 'Correct! Someone\'s been paying attention!' },
  { emoji: '🕺', text: 'Nailed it! Save that energy for the reception!' },
];

const wrongResponses = [
  { emoji: '💙', text: 'Not quite — but we still love you!' },
  { emoji: '😬', text: 'Ooh, so close! (Not really, but still.)' },
  { emoji: '🫣', text: 'Wrong! Have you even met the couple?' },
  { emoji: '🤔', text: 'Interesting choice... but no.' },
  { emoji: '🥲', text: 'Wrong answer, but great effort energy.' },
  { emoji: '🍰', text: 'Incorrect! Go eat some cake, you\'ll feel better.' },
  { emoji: '😅', text: 'That\'s a no — but the open bar awaits!' },
];

const noAnswerResponses = [
  { emoji: '😶', text: "You didn't answer in time!" },
  { emoji: '🙈', text: "No answer? Bold strategy." },
  { emoji: '⏰', text: "Too slow! The answer flew right past you." },
];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

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
    const r = pickRandom(noAnswerResponses);
    resultEl.textContent = r.emoji;
    messageEl.textContent = r.text;
    messageEl.className = '';
  } else if (playerGotItRight) {
    const r = pickRandom(correctResponses);
    resultEl.textContent = r.emoji;
    messageEl.textContent = r.text;
    messageEl.className = 'text-success';
  } else {
    const r = pickRandom(wrongResponses);
    resultEl.textContent = r.emoji;
    messageEl.textContent = r.text;
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

  // Find this player's rank (1-based)
  const myRank = players.findIndex(p => p.name === currentPlayer.name) + 1;
  const total = players.length;

  // Rank-based personalized messages
  let rankMessage = '';
  if (myRank === 1) {
    rankMessage = '🏆 You won! Someone\'s been stalking the couple\'s Instagram.';
  } else if (myRank === 2) {
    rankMessage = '🥈 So close! First loser, but still a winner in our hearts.';
  } else if (myRank === 3) {
    rankMessage = '🥉 Third place! The bronze medal is basically gold if you squint.';
  } else if (total > 4 && myRank === total) {
    rankMessage = '💀 Dead last. Do you even know these people?';
  } else if (total > 6 && myRank >= Math.floor(total * 0.75)) {
    rankMessage = '😬 Bottom of the pack. Were you even paying attention?';
  } else if (myRank <= Math.ceil(total / 2)) {
    rankMessage = '👏 Top half! Not bad for someone who found their seat 10 minutes late.';
  } else {
    rankMessage = '🤷 Middle of the road. Solidly average — just like the dinner rolls.';
  }

  document.getElementById('leaderboard-rank-message').textContent = rankMessage;

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

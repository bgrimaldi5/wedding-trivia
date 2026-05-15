// ============================================================
// js/play.js
// Guest game experience — listens to Supabase realtime and
// updates the screen based on game_state changes
// ============================================================

// ---- State ----
let currentPlayer = null;
let currentQuestion = null;
let myAnswer = null;
let allQuestions = [];

// ============================================================
// INITIALIZATION
// ============================================================

window.addEventListener('DOMContentLoaded', async () => {
  currentPlayer = getPlayerSession();
  if (!currentPlayer) {
    window.location.href = 'index.html';
    return;
  }

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

  const { data: questions } = await db
    .from('questions')
    .select('*')
    .order('order_index', { ascending: true });
  allQuestions = questions || [];

  const { data: gameState } = await db
    .from('game_state')
    .select('*')
    .eq('id', 1)
    .single();

  if (gameState) {
    await renderScreen(gameState);
  }

  subscribeToGameState();
  subscribeToPlayerDeletion();
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
  // When admin resets the game, all players are deleted.
  // If our own record is deleted, boot us back to the join page.
  db
    .channel('player-delete-channel')
    .on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'players' },
      (payload) => {
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

    const isNewQuestion = !currentQuestion || currentQuestion.id !== question.id;

    if (isNewQuestion) {
      currentQuestion = question;
      myAnswer = null;

      // Only restore a saved answer if answers are already locked
      // (covers the case of someone refreshing mid-lock)
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

    // Load the player's final saved answer for this question
    const { data: savedAnswer } = await db
      .from('answers')
      .select('chosen_answer')
      .eq('player_id', currentPlayer.id)
      .eq('question_id', question.id)
      .single();
    if (savedAnswer) myAnswer = savedAnswer.chosen_answer;

    // Calculate score based on final answer
    await updateScoreForQuestion(question);

    // Refresh score from DB
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
    btn.disabled = answersLocked;
    if (myAnswer === letter) btn.classList.add('selected');

    btn.innerHTML = `
      <span class="choice-letter">${letter}</span>
      <span>${text}</span>
    `;

    btn.onclick = () => selectAnswer(letter, question);
    container.appendChild(btn);
  });

  // Show waiting message only after admin has locked answers
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
  if (!currentQuestion || currentQuestion.id !== question.id) return;

  const previousAnswer = myAnswer;
  myAnswer = chosenLetter;

  // Update button highlights immediately
  document.querySelectorAll('#answer-choices .answer-btn').forEach(btn => {
    const letter = btn.querySelector('.choice-letter').textContent;
    btn.classList.toggle('selected', letter === chosenLetter);
  });

  const isCorrect = chosenLetter === question.correct_answer;

  if (previousAnswer === null) {
    // First selection — insert new record
    await db.from('answers').insert({
      player_id: currentPlayer.id,
      question_id: question.id,
      chosen_answer: chosenLetter,
      is_correct: isCorrect,
    });
  } else {
    // Changed answer — update existing record
    await db.from('answers')
      .update({ chosen_answer: chosenLetter, is_correct: isCorrect })
      .eq('player_id', currentPlayer.id)
      .eq('question_id', question.id);
  }
  // Scores are NOT updated here — scoring happens at reveal time only
}

// ============================================================
// SCORING
// Runs when host reveals the answer, not at submission time.
// Counts all correct answers to calculate score safely.
// ============================================================

async function updateScoreForQuestion(question) {
  const { data: savedAnswer } = await db
    .from('answers')
    .select('is_correct')
    .eq('player_id', currentPlayer.id)
    .eq('question_id', question.id)
    .single();

  if (!savedAnswer || !savedAnswer.is_correct) return;

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

// ============================================================
// RENDER: ANSWER REVEAL SCREEN
// ============================================================

// ---- EDIT YOUR RESPONSES HERE ----
// Each entry has an emoji and a text message.
// Add, remove, or change any of them freely.

const correctResponses = [
  { emoji: '💃', text: "You're not confused Greg, you nailed it!" },
  { emoji: '👀', text: 'Correct!! Were you eavesdropping at brunch?' },
  { emoji: '🎂', text: 'Correct! You get an extra slice of cake (Mentally... the cake budget is unfortunately maxed out).' },
  { emoji: '🥂', text: "You got it — Ben's crunching the numbers and... it's confirmed, you're a genius!" },
  { emoji: '🤌', text: 'Absolutely flawless. Just like Ben.' },
  { emoji: '👑', text: "Correct! At least someone's been listening to Josie ramble!" },
  { emoji: '🕵️', text: 'How did you know that? Are you stalking us?' },
  { emoji: '🫶', text: 'Yayy! Josie always knew you were her biggest fan.' },
  { emoji: '🍾', text: "Sparkling answer! Just like a nice glass of Josie's favorite moscato!" },
  { emoji: '🕺', text: 'Nailed it! Save that winner energy for the dance floor!' },
];

const wrongResponses = [
  { emoji: '💀', text: 'Wrong! Did you even come to the right wedding??' },
  { emoji: '😬', text: "Ooh, so close! (Not really, but it's fine)" },
  { emoji: '🫣', text: "That was bad, keep in mind Ben will get a spreadsheet with all your answers." },
  { emoji: '😭', text: "Incorrect! Don't cry though — there's still some chocolate covered strawberries left." },
  { emoji: '🤔', text: 'Interesting choice... but no.' },
  { emoji: '🥲', text: 'A bold choice. A terrible choice, but bold.' },
  { emoji: '📉', text: 'Incorrect! Your stock is dropping fast at this table.' },
  { emoji: '🙃', text: 'Are you just guessing? Take a sip and reflect on your choices.' },
  { emoji: '👎', text: "Why did you even come here if you weren't going to take this seriously???" },
  { emoji: '😅', text: "Nope. We're going to pretend that didn't happen." },
];

const noAnswerResponses = [
  { emoji: '😶', text: "You didn't answer in time! Stop thinking about the beach and FOCUS" },
  { emoji: '🙈', text: "No answer? Bold strategy." },
  { emoji: '🍷', text: "Too busy at the bar to answer? Fair." },
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

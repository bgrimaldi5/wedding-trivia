// ============================================================
// js/admin.js
// Host control panel — manages all game state transitions
// ============================================================

let gameState = null;       // Current game_state row
let allQuestions = [];      // All questions from DB
let answerPollInterval = null;  // Polling timer for live answer counts

// ============================================================
// INITIALIZATION
// ============================================================

window.addEventListener('DOMContentLoaded', async () => {
  // Load questions
  const { data: questions } = await db
    .from('questions')
    .select('*')
    .order('order_index', { ascending: true });
  allQuestions = questions || [];

  if (allQuestions.length === 0) {
    showToast('⚠️ No questions found! Use the Import page first.');
  }

  // Load current game state
  const { data: state } = await db
    .from('game_state')
    .select('*')
    .eq('id', 1)
    .single();

  if (state) {
    gameState = state;
    await refreshUI();
  }

  // Subscribe to realtime updates (in case host opens two tabs, etc.)
  subscribeToChanges();

  // Start polling for player count and answers
  setInterval(refreshStats, 3000);
  await refreshStats();
});

// ============================================================
// REALTIME SUBSCRIPTIONS
// ============================================================

function subscribeToChanges() {
  // Watch for new players joining
  db.channel('admin-players')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, async () => {
      await refreshStats();
    })
    .subscribe();

  // Watch for new answers coming in
  db.channel('admin-answers')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'answers' }, async () => {
      await refreshAnswerTally();
    })
    .subscribe();
}

// ============================================================
// GAME STATE MUTATIONS
// Each function updates the game_state row in Supabase,
// which instantly broadcasts to all connected players.
// ============================================================

async function startGame() {
  if (allQuestions.length === 0) {
    showToast('⚠️ Import questions first!');
    return;
  }

  if (!confirm('Start the game? All joined players will see the first question.')) return;

  await updateGameState({
    status: 'active',
    current_question_index: 0,
    answers_locked: false,
    answers_revealed: false,
  });

  showToast('▶ Game started!');
}

async function lockAnswers() {
  await updateGameState({
    status: 'answers_locked',
    answers_locked: true,
  });
  showToast('🔒 Answers locked');
}

async function revealAnswer() {
  await updateGameState({
    status: 'answer_reveal',
    answers_revealed: true,
  });
  showToast('✨ Answer revealed!');
}

async function nextQuestion() {
  const nextIndex = gameState.current_question_index + 1;

  if (nextIndex >= allQuestions.length) {
    showToast('That was the last question! Use "End Game" instead.');
    return;
  }

  await updateGameState({
    status: 'active',
    current_question_index: nextIndex,
    answers_locked: false,
    answers_revealed: false,
  });

  showToast(`⏭ Question ${nextIndex + 1} of ${allQuestions.length}`);
}

async function endGame() {
  if (!confirm('End the game and show the final leaderboard to all players?')) return;

  await updateGameState({ status: 'finished' });
  showToast('🏁 Game over!');
}

async function resetGame() {
  if (!confirm('⚠️ RESET the entire game?\n\nThis will remove ALL players and answers.\nQuestions will be kept.\n\nThis cannot be undone!')) return;

  // Delete answers one by one
  const { data: allAnswers } = await db.from('answers').select('id');
  if (allAnswers) {
    for (const a of allAnswers) {
      await db.from('answers').delete().eq('id', a.id);
    }
  }

  // Delete players one by one
  const { data: allPlayers } = await db.from('players').select('id');
  if (allPlayers) {
    for (const p of allPlayers) {
      await db.from('players').delete().eq('id', p.id);
    }
  }

  // Reset game state back to lobby — players still on play.html will
  // detect their session is gone on the next check and be sent back
  // to the name entry screen automatically
  await updateGameState({
    status: 'lobby',
    current_question_index: 0,
    answers_locked: false,
    answers_revealed: false,
  });

  showToast('🔄 Game reset to lobby');
}

// ============================================================
// CORE: UPDATE GAME STATE
// ============================================================

async function updateGameState(changes) {
  const { data, error } = await db
    .from('game_state')
    .update({ ...changes, updated_at: new Date().toISOString() })
    .eq('id', 1)
    .select()
    .single();

  if (error) {
    console.error('Failed to update game state:', error);
    showToast('❌ Error updating game state');
    return;
  }

  gameState = data;
  await refreshUI();
}

// ============================================================
// UI REFRESH: sync all UI elements to current game state
// ============================================================

async function refreshUI() {
  if (!gameState) return;

  const { status, current_question_index, answers_locked, answers_revealed } = gameState;
  const question = allQuestions[current_question_index];
  const isLastQuestion = current_question_index >= allQuestions.length - 1;

  // --- Status bar ---
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-label');
  const detail = document.getElementById('status-detail');

  dot.className = 'status-indicator';

  if (status === 'lobby') {
    dot.classList.add('lobby');
    label.textContent = 'Lobby — Waiting for players';
    detail.textContent = '';
  } else if (status === 'active') {
    dot.classList.add('active');
    label.textContent = `Question ${current_question_index + 1} — Players answering`;
    detail.textContent = `${current_question_index + 1} / ${allQuestions.length}`;
  } else if (status === 'answers_locked') {
    dot.classList.add('active');
    label.textContent = `Question ${current_question_index + 1} — Answers locked`;
    detail.textContent = `${current_question_index + 1} / ${allQuestions.length}`;
  } else if (status === 'answer_reveal') {
    dot.classList.add('reveal');
    label.textContent = `Question ${current_question_index + 1} — Answer revealed`;
    detail.textContent = `${current_question_index + 1} / ${allQuestions.length}`;
  } else if (status === 'finished') {
    dot.classList.add('finished');
    label.textContent = 'Game finished — Leaderboard showing';
    detail.textContent = '';
  }

  document.getElementById('stat-question').textContent =
    status === 'lobby' || status === 'finished' ? '—' : `${current_question_index + 1}/${allQuestions.length}`;

  // --- Show/hide control buttons ---
  setVisible('btn-start',  status === 'lobby');
  setVisible('btn-lock',   status === 'active');
  setVisible('btn-reveal', status === 'answers_locked');
  setVisible('btn-next',   status === 'answer_reveal' && !isLastQuestion);
  setVisible('btn-end',    status === 'answer_reveal' && isLastQuestion);

  // --- Question preview ---
  if (question && status !== 'lobby' && status !== 'finished') {
    renderQuestionPreview(question, current_question_index, answers_revealed);
  } else if (status === 'lobby') {
    document.getElementById('question-preview').innerHTML =
      '<div class="q-label">Waiting to start...</div>';
  } else if (status === 'finished') {
    document.getElementById('question-preview').innerHTML =
      '<div class="q-label">Game finished 🏁</div>';
  }

  // --- Answer tally ---
  if (question && status !== 'lobby') {
    await refreshAnswerTally();
  }

  // --- Leaderboard ---
  await refreshLeaderboard();
}

// ============================================================
// QUESTION PREVIEW
// ============================================================

function renderQuestionPreview(question, index, revealed) {
  const choices = getChoices(question);
  const correct = question.correct_answer;

  const optionsHTML = choices.map(({ letter, text }) => `
    <div class="opt ${revealed && letter === correct ? 'correct' : ''}">
      <span class="ltr">${letter}</span>
      <span>${text}${revealed && letter === correct ? ' ✓' : ''}</span>
    </div>
  `).join('');

  document.getElementById('question-preview').innerHTML = `
    <div class="q-label">Question ${index + 1} of ${allQuestions.length}</div>
    <div class="q-text">${question.question_text}</div>
    <div class="options">${optionsHTML}</div>
  `;
}

// ============================================================
// ANSWER TALLY
// ============================================================

async function refreshAnswerTally() {
  if (!gameState || gameState.status === 'lobby' || gameState.status === 'finished') return;

  const question = allQuestions[gameState.current_question_index];
  if (!question) return;

  const { data: answers } = await db
    .from('answers')
    .select('chosen_answer')
    .eq('question_id', question.id);

  const total = answers ? answers.length : 0;
  document.getElementById('stat-answers').textContent = total;

  const choices = getChoices(question);
  const counts = { A: 0, B: 0, C: 0 };

  if (answers) {
    answers.forEach(a => { if (counts[a.chosen_answer] !== undefined) counts[a.chosen_answer]++; });
  }

  const container = document.getElementById('answer-tally');

  if (total === 0) {
    container.innerHTML = '<p style="font-size:0.85rem; color:var(--text-light)">Waiting for answers...</p>';
    return;
  }

  container.innerHTML = choices.map(({ letter }) => {
    const count = counts[letter] || 0;
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    const isCorrect = letter === question.correct_answer;

    return `
      <div class="tally-row">
        <span class="tally-letter" style="${gameState.answers_revealed && isCorrect ? 'background:var(--success);color:white;' : ''}">${letter}</span>
        <div class="tally-bar-wrap">
          <div class="tally-bar-fill" style="width:${pct}%; ${gameState.answers_revealed && isCorrect ? 'background:var(--success);' : ''}"></div>
        </div>
        <span class="tally-count">${count}</span>
        <span style="font-size:0.75rem; color:var(--text-light); min-width:2rem;">${pct}%</span>
      </div>
    `;
  }).join('');
}

// ============================================================
// STATS REFRESH (players + leaderboard)
// ============================================================

async function refreshStats() {
  // Player count
  const { count } = await db
    .from('players')
    .select('*', { count: 'exact', head: true });

  document.getElementById('stat-players').textContent = count || 0;

  // Player chips
  const { data: players } = await db
    .from('players')
    .select('name')
    .order('joined_at', { ascending: true });

  const list = document.getElementById('player-list');
  if (players && players.length > 0) {
    list.innerHTML = players.map(p => `
      <li class="player-chip">${p.name}</li>
    `).join('');
  } else {
    list.innerHTML = '<li style="font-size:0.85rem; color:var(--text-light)">No players yet...</li>';
  }
}

async function refreshLeaderboard() {
  const { data: players } = await db
    .from('players')
    .select('name, score')
    .order('score', { ascending: false })
    .limit(10);

  const list = document.getElementById('admin-leaderboard');
  if (!players || players.length === 0) {
    list.innerHTML = '<li><span class="mini-lb-name" style="color:var(--text-light)">Waiting for scores...</span></li>';
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  list.innerHTML = players.map((p, i) => `
    <li>
      <span class="mini-lb-rank">${medals[i] || (i + 1)}</span>
      <span class="mini-lb-name">${p.name}</span>
      <span class="mini-lb-score">${p.score} pts</span>
    </li>
  `).join('');
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

function setVisible(id, visible) {
  const el = document.getElementById(id);
  if (!el) return;
  if (visible) el.classList.remove('hidden');
  else el.classList.add('hidden');
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2800);
}

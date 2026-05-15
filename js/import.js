// ============================================================
// js/import.js
// Reads an Excel file and uploads questions to Supabase
// ============================================================

let parsedQuestions = [];   // Questions parsed from the Excel file

// ============================================================
// DRAG & DROP SUPPORT
// ============================================================

const uploadZone = document.getElementById('upload-zone');

uploadZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadZone.classList.add('drag-over');
});

uploadZone.addEventListener('dragleave', () => {
  uploadZone.classList.remove('drag-over');
});

uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) processFile(file);
});

// ============================================================
// FILE SELECT HANDLER
// ============================================================

function handleFileSelect(event) {
  const file = event.target.files[0];
  if (file) processFile(file);
}

// ============================================================
// PROCESS FILE: Read Excel → parse rows → preview
// ============================================================

function processFile(file) {
  // Validate it's an xlsx
  if (!file.name.endsWith('.xlsx')) {
    alert('Please upload a .xlsx file (Excel format).');
    return;
  }

  document.getElementById('file-name-display').textContent = `📄 ${file.name}`;
  document.getElementById('file-name-display').classList.remove('hidden');

  // Use FileReader to read the file as binary data
  const reader = new FileReader();

  reader.onload = (e) => {
    try {
      // Parse the Excel file using SheetJS
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });

      // Use the first sheet
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];

      // Convert to a plain array of arrays (like rows and columns)
      // defval: '' fills in blank cells as empty string instead of undefined
      const rows = XLSX.utils.sheet_to_json(worksheet, {
        header: 1,           // Return as array of arrays
        defval: '',          // Empty cells become ''
        blankrows: false,    // Skip completely empty rows
      });

      if (rows.length === 0) {
        alert('The Excel file appears to be empty.');
        return;
      }

      // Parse each row into a question object
      parsedQuestions = [];
      const errors = [];

      rows.forEach((row, rowIndex) => {
        const rowNum = rowIndex + 1;  // 1-based for human-readable messages

        // Skip entirely blank rows
        if (row.every(cell => String(cell).trim() === '')) return;

        const questionText = String(row[0] || '').trim();   // Column A
        const optionA      = String(row[1] || '').trim();   // Column B
        const optionB      = String(row[2] || '').trim();   // Column C
        const optionC      = String(row[3] || '').trim();   // Column D (may be blank)
        const correctAnswer = String(row[4] || '').trim().toUpperCase(); // Column E

        // --- Validate each row ---
        if (!questionText) {
          errors.push(`Row ${rowNum}: Column A (question text) is empty.`);
          return;
        }
        if (!optionA) {
          errors.push(`Row ${rowNum}: Column B (Option A) is empty.`);
          return;
        }
        if (!optionB) {
          errors.push(`Row ${rowNum}: Column C (Option B) is empty.`);
          return;
        }
        if (!['A', 'B', 'C'].includes(correctAnswer)) {
          errors.push(`Row ${rowNum}: Column E must be A, B, or C. Found: "${correctAnswer}"`);
          return;
        }
        if (correctAnswer === 'C' && !optionC) {
          errors.push(`Row ${rowNum}: Correct answer is C but Column D (Option C) is blank.`);
          return;
        }

        parsedQuestions.push({
          order_index: parsedQuestions.length + 1,
          question_text: questionText,
          option_a: optionA,
          option_b: optionB,
          option_c: optionC || null,   // Store null if blank
          correct_answer: correctAnswer,
        });
      });

      // Show preview
      renderPreview(parsedQuestions, errors);

    } catch (err) {
      console.error('Error parsing Excel file:', err);
      alert('Could not read the Excel file. Please make sure it is a valid .xlsx file.');
    }
  };

  reader.readAsArrayBuffer(file);
}

// ============================================================
// RENDER PREVIEW TABLE
// ============================================================

function renderPreview(questions, errors) {
  const previewCard = document.getElementById('preview-card');
  const previewBody = document.getElementById('preview-body');
  const previewCount = document.getElementById('preview-count');
  const importBtn = document.getElementById('import-btn');
  const validationErrors = document.getElementById('validation-errors');
  const errorList = document.getElementById('error-list');

  previewCard.classList.remove('hidden');
  previewCount.textContent = questions.length;

  // Build table rows
  previewBody.innerHTML = questions.map((q, i) => {
    const choices = [
      `<strong>A:</strong> ${q.option_a}`,
      `<strong>B:</strong> ${q.option_b}`,
      q.option_c ? `<strong>C:</strong> ${q.option_c}` : '',
    ].filter(Boolean).join('<br>');

    return `
      <tr>
        <td>${i + 1}</td>
        <td>${q.question_text}</td>
        <td>${choices}</td>
        <td><span class="correct-badge">${q.correct_answer}</span></td>
      </tr>
    `;
  }).join('');

  // Show errors if any
  if (errors.length > 0) {
    validationErrors.classList.remove('hidden');
    errorList.innerHTML = errors.map(e => `<li>${e}</li>`).join('');
    importBtn.disabled = true;
    importBtn.textContent = '⚠️ Fix errors before importing';
  } else {
    validationErrors.classList.add('hidden');
    importBtn.disabled = false;
    importBtn.innerHTML = '📥 &nbsp; Import to Database';
  }
}

// ============================================================
// IMPORT TO SUPABASE
// ============================================================

async function importQuestions() {
  if (parsedQuestions.length === 0) {
    alert('No questions to import.');
    return;
  }

  const importBtn = document.getElementById('import-btn');
  importBtn.disabled = true;
  importBtn.textContent = 'Importing...';

  // Show the log box
  document.getElementById('log-card').classList.remove('hidden');
  const logBox = document.getElementById('log-box');
  logBox.innerHTML = '';

  const log = (msg, type = 'info') => {
    logBox.innerHTML += `<div class="log-${type}">${msg}</div>`;
    logBox.scrollTop = logBox.scrollHeight;
  };

  log('📊 Starting import...', 'info');

  // Step 1: Clear existing questions (and answers — they'd be orphaned)
  log('🗑  Clearing existing questions and answers...', 'info');

  const { error: deleteAnswersErr } = await db
    .from('answers')
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000');

  if (deleteAnswersErr) {
    log(`⚠️  Could not clear answers: ${deleteAnswersErr.message}`, 'err');
  }

  const { error: deleteQErr } = await db
    .from('questions')
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000');

  if (deleteQErr) {
    log(`❌ Could not clear questions: ${deleteQErr.message}`, 'err');
    log('Import aborted.', 'err');
    importBtn.disabled = false;
    importBtn.innerHTML = '📥 &nbsp; Import to Database';
    return;
  }

  log(`✓ Cleared. Importing ${parsedQuestions.length} questions...`, 'ok');

  // Step 2: Insert all questions
  let successCount = 0;
  let failCount = 0;

  for (const question of parsedQuestions) {
    const { error } = await db
      .from('questions')
      .insert(question);

    if (error) {
      log(`❌ Q${question.order_index} failed: ${error.message}`, 'err');
      failCount++;
    } else {
      log(`✓ Q${question.order_index}: ${question.question_text.substring(0, 50)}${question.question_text.length > 50 ? '...' : ''}`, 'ok');
      successCount++;
    }
  }

  // Step 3: Also reset game state to lobby
  await db
    .from('game_state')
    .update({
      status: 'lobby',
      current_question_index: 0,
      answers_locked: false,
      answers_revealed: false,
    })
    .eq('id', 1);

  log('', 'info');
  log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'info');

  if (failCount === 0) {
    log(`🎉 All ${successCount} questions imported successfully!`, 'ok');
    log(`Game has been reset to lobby.`, 'ok');
  } else {
    log(`⚠️  ${successCount} succeeded, ${failCount} failed.`, 'err');
    log(`Check the errors above and re-import.`, 'err');
  }
}

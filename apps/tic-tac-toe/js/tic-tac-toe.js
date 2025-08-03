document.addEventListener('DOMContentLoaded', () => {
  const X_CLASS = 'x';
  const CIRCLE_CLASS = 'circle';
  const WINNING_COMBINATIONS = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6]
  ];
  const cellElements = document.querySelectorAll('[data-cell]');
  const board = document.getElementById('board');
  const winningMessageElement = document.getElementById('winningMessage');
  const restartButton = document.getElementById('restartButton');
  const winningMessageTextElement = document.querySelector('[data-winning-message-text]');
  const errorMessage = document.getElementById('errorMessage');
  const line = document.getElementById('line');
  const startSelection = document.getElementById('startSelection');
  const starterSelection = document.getElementById('starterSelection');
  let circleTurn;
  let playerStartsFirst = true;
  let difficulty = 'medium'; // Default difficulty
  let isOpponentTurn = false; // Flag to prevent player moves during opponent's turn

  // Don't start the game automatically, wait for player selection
  // startGame();

  restartButton.addEventListener('click', resetToStartSelection);

  // Handle difficulty selection
  window.selectDifficulty = function(level) {
    difficulty = level;
    document.querySelector('.difficulty-options').style.display = 'none';
    starterSelection.style.display = 'block';
  }

  // Handle starting player selection
  window.selectStarter = function(starter) {
    playerStartsFirst = starter === 'player';
    startSelection.style.display = 'none';
    board.style.display = 'grid';
    document.getElementById('gameControls').style.display = 'block';
    startGame();
  }

  // Handle mid-game restart
  window.confirmRestart = function() {
    document.getElementById('restartModal').style.display = 'flex';
  }
  
  window.confirmRestartYes = function() {
    document.getElementById('restartModal').style.display = 'none';
    resetToStartSelection();
  }
  
  window.confirmRestartNo = function() {
    document.getElementById('restartModal').style.display = 'none';
  }

  function resetToStartSelection() {
    winningMessageElement.classList.remove('show');
    board.style.display = 'none';
    document.getElementById('gameControls').style.display = 'none';
    startSelection.style.display = 'flex';
    document.querySelector('.difficulty-options').style.display = 'flex';
    starterSelection.style.display = 'none';
  }

  function startGame() {
    circleTurn = !playerStartsFirst;
    isOpponentTurn = false; // Reset opponent turn flag
    cellElements.forEach(cell => {
      cell.classList.remove(X_CLASS);
      cell.classList.remove(CIRCLE_CLASS);
      cell.removeEventListener('click', handleClick);
      cell.addEventListener('click', handleClick, { once: true });
    });
    setBoardHoverClass();
    winningMessageElement.classList.remove('show');
    errorMessage.style.display = 'none';
    line.style.display = 'none';
    
    // If Opponent starts first, make its move
    if (!playerStartsFirst) {
      isOpponentTurn = true; // Set flag when opponent starts first
      setTimeout(() => {
        bestMove();
      }, 500);
    }
  }

  function handleClick(e) {
    // Prevent clicks during opponent's turn
    if (isOpponentTurn) {
      return;
    }
    
    const cell = e.target;
    const currentClass = circleTurn ? CIRCLE_CLASS : X_CLASS;
    if (cell.classList.contains(X_CLASS) || cell.classList.contains(CIRCLE_CLASS)) {
      errorMessage.style.display = 'block';
      setTimeout(() => {
        errorMessage.style.display = 'none';
      }, 2000);
      return;
    }
    placeMark(cell, currentClass);
    if (checkWin(currentClass)) {
      endGame(false, currentClass);
    } else if (isDraw()) {
      endGame(true);
    } else {
      swapTurns();
      setBoardHoverClass();
      if (circleTurn) {
        isOpponentTurn = true; // Set flag before opponent's move
        setTimeout(bestMove, 300); // Opponent makes a move after a short delay
      }
    }
  }

  function endGame(draw, winningClass) {
    isOpponentTurn = false; // Reset flag when game ends
    document.getElementById('gameControls').style.display = 'none'; // Hide restart button when game ends
    if (draw) {
      winningMessageTextElement.innerText = 'Draw!';
      winningMessageTextElement.style.color = 'black';
    } else {
      winningMessageTextElement.innerText = `${winningClass === CIRCLE_CLASS ? "O's" : "X's"} Wins!`;
      winningMessageTextElement.style.color = winningClass === CIRCLE_CLASS ? '#4287f5' : '#f44b42';
      drawWinningLine(winningClass);
    }
    winningMessageElement.classList.add('show');
  }

  function isDraw() {
    return [...cellElements].every(cell => {
      return cell.classList.contains(X_CLASS) || cell.classList.contains(CIRCLE_CLASS);
    });
  }

  function placeMark(cell, currentClass) {
    cell.classList.add(currentClass);
  }

  function swapTurns() {
    circleTurn = !circleTurn;
  }

  function setBoardHoverClass() {
    board.classList.remove(X_CLASS);
    board.classList.remove(CIRCLE_CLASS);
    if (circleTurn) {
      board.classList.add(CIRCLE_CLASS);
    } else {
      board.classList.add(X_CLASS);
    }
  }

  function checkWin(currentClass) {
    return WINNING_COMBINATIONS.some(combination => {
      return combination.every(index => {
        return cellElements[index].classList.contains(currentClass);
      });
    });
  }

  function drawWinningLine(winningClass) {
    WINNING_COMBINATIONS.forEach((combination, index) => {
      if (combination.every(idx => cellElements[idx].classList.contains(winningClass))) {
        let lineClass = '';
        let startCell = cellElements[combination[0]];
        let endCell = cellElements[combination[2]];
        let startX = startCell.offsetLeft + startCell.offsetWidth / 2;
        let startY = startCell.offsetTop + startCell.offsetHeight / 2;
        let endX = endCell.offsetLeft + endCell.offsetWidth / 2;
        let endY = endCell.offsetTop + endCell.offsetHeight / 2;
        let length = Math.sqrt(Math.pow(endX - startX, 2) + Math.pow(endY - startY, 2));
        let angle = Math.atan2(endY - startY, endX - startX) * (180 / Math.PI);

        line.style.width = `${length}px`;
        line.style.height = `5px`;
        line.style.left = `${startX}px`;
        line.style.top = `${startY}px`;
        line.style.transform = `rotate(${angle}deg)`;
        line.style.transformOrigin = '0 0';
        line.style.display = 'block';
      }
    });
  }

  function bestMove() {
    const emptyCells = [];
    cellElements.forEach((cell, index) => {
      if (!cell.classList.contains(X_CLASS) && !cell.classList.contains(CIRCLE_CLASS)) {
        emptyCells.push(index);
      }
    });

    let move;
    
    if (difficulty === 'easy') {
      // Easy: 70% random moves, 30% optimal moves
      if (Math.random() < 0.7) {
        move = emptyCells[Math.floor(Math.random() * emptyCells.length)];
      } else {
        move = getOptimalMove(emptyCells);
      }
    } else if (difficulty === 'medium') {
      // Medium: 30% random moves, 70% optimal moves
      if (Math.random() < 0.3) {
        move = emptyCells[Math.floor(Math.random() * emptyCells.length)];
      } else {
        move = getOptimalMove(emptyCells);
      }
    } else {
      // Hard: Always optimal moves
      move = getOptimalMove(emptyCells);
    }
    
    placeMark(cellElements[move], CIRCLE_CLASS);
    if (checkWin(CIRCLE_CLASS)) {
      endGame(false, CIRCLE_CLASS);
    } else if (isDraw()) {
      endGame(true);
    } else {
      swapTurns();
      setBoardHoverClass();
    }
    isOpponentTurn = false; // Reset flag after opponent's move
  }

  function getOptimalMove(emptyCells) {
    // If it's the first move, prefer center
    if (emptyCells.length === 8) {
      return cellElements[4].classList.contains(X_CLASS) ? 0 : 4;
    }
    
    // Use minimax with alpha-beta pruning for other moves
    let bestScore = -Infinity;
    let bestMove = emptyCells[0];
    const maxDepth = emptyCells.length > 6 ? 4 : 10; // Limit depth for performance
    
    emptyCells.forEach(index => {
      cellElements[index].classList.add(CIRCLE_CLASS);
      let score = minimax(0, false, -Infinity, Infinity, maxDepth);
      cellElements[index].classList.remove(CIRCLE_CLASS);
      if (score > bestScore) {
        bestScore = score;
        bestMove = index;
      }
    });
    
    return bestMove;
  }

  function minimax(depth, isMaximizing, alpha, beta, maxDepth) {
    // Check terminal states
    if (checkWin(CIRCLE_CLASS)) {
      return 10 - depth; // Prefer winning sooner
    } else if (checkWin(X_CLASS)) {
      return depth - 10; // Prefer losing later
    } else if (isDraw() || depth >= maxDepth) {
      return 0;
    }

    if (isMaximizing) {
      let bestScore = -Infinity;
      for (let i = 0; i < cellElements.length; i++) {
        if (!cellElements[i].classList.contains(X_CLASS) && !cellElements[i].classList.contains(CIRCLE_CLASS)) {
          cellElements[i].classList.add(CIRCLE_CLASS);
          let score = minimax(depth + 1, false, alpha, beta, maxDepth);
          cellElements[i].classList.remove(CIRCLE_CLASS);
          bestScore = Math.max(score, bestScore);
          alpha = Math.max(alpha, bestScore);
          if (beta <= alpha) {
            break; // Alpha-beta pruning
          }
        }
      }
      return bestScore;
    } else {
      let bestScore = Infinity;
      for (let i = 0; i < cellElements.length; i++) {
        if (!cellElements[i].classList.contains(X_CLASS) && !cellElements[i].classList.contains(CIRCLE_CLASS)) {
          cellElements[i].classList.add(X_CLASS);
          let score = minimax(depth + 1, true, alpha, beta, maxDepth);
          cellElements[i].classList.remove(X_CLASS);
          bestScore = Math.min(score, bestScore);
          beta = Math.min(beta, bestScore);
          if (beta <= alpha) {
            break; // Alpha-beta pruning
          }
        }
      }
      return bestScore;
    }
  }
});
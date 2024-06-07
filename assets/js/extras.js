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
  let circleTurn;

  startGame();

  restartButton.addEventListener('click', startGame);

  function startGame() {
    circleTurn = false;
    cellElements.forEach(cell => {
      cell.classList.remove(X_CLASS);
      cell.classList.remove(CIRCLE_CLASS);
      cell.removeEventListener('click', handleClick);
      cell.addEventListener('click', handleClick, { once: true });
    });
    setBoardHoverClass();
    winningMessageElement.classList.remove('show');
  }

  function handleClick(e) {
    const cell = e.target;
    const currentClass = circleTurn ? CIRCLE_CLASS : X_CLASS;
    placeMark(cell, currentClass);
    if (checkWin(currentClass)) {
      endGame(false, currentClass);
    } else if (isDraw()) {
      endGame(true);
    } else {
      swapTurns();
      setBoardHoverClass();
      if (!circleTurn) {
        bestMove();
      }
    }
  }

  function endGame(draw, winningClass) {
    if (draw) {
      winningMessageTextElement.innerText = 'Draw!';
    } else {
      winningMessageTextElement.innerText = `${circleTurn ? "O's" : "X's"} Wins!`;
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

  function bestMove() {
    let bestScore = -Infinity;
    let move;
    cellElements.forEach((cell, index) => {
      if (!cell.classList.contains(X_CLASS) && !cell.classList.contains(CIRCLE_CLASS)) {
        cell.classList.add(CIRCLE_CLASS);
        let score = minimax(board, 0, false);
        cell.classList.remove(CIRCLE_CLASS);
        if (score > bestScore) {
          bestScore = score;
          move = index;
        }
      }
    });
    placeMark(cellElements[move], CIRCLE_CLASS);
    if (checkWin(CIRCLE_CLASS)) {
      endGame(false, CIRCLE_CLASS);
    } else if (isDraw()) {
      endGame(true);
    } else {
      swapTurns();
      setBoardHoverClass();
    }
  }

  function minimax(board, depth, isMaximizing) {
    if (checkWin(CIRCLE_CLASS)) {
      return 1;
    } else if (checkWin(X_CLASS)) {
      return -1;
    } else if (isDraw()) {
      return 0;
    }

    if (isMaximizing) {
      let bestScore = -Infinity;
      cellElements.forEach((cell, index) => {
        if (!cell.classList.contains(X_CLASS) && !cell.classList.contains(CIRCLE_CLASS)) {
          cell.classList.add(CIRCLE_CLASS);
          let score = minimax(board, depth + 1, false);
          cell.classList.remove(CIRCLE_CLASS);
          bestScore = Math.max(score, bestScore);
        }
      });
      return bestScore;
    } else {
      let bestScore = Infinity;
      cellElements.forEach((cell, index) => {
        if (!cell.classList.contains(X_CLASS) && !cell.classList.contains(CIRCLE_CLASS)) {
          cell.classList.add(X_CLASS);
          let score = minimax(board, depth + 1, true);
          cell.classList.remove(X_CLASS);
          bestScore = Math.min(score, bestScore);
        }
      });
      return bestScore;
    }
  }

  function drawWinningLine(winningClass) {
    const winningCombination = WINNING_COMBINATIONS.find(combination => {
      return combination.every(index => {
        return cellElements[index].classList.contains(winningClass);
      });
    });
    if (winningCombination) {
      const [start, , end] = winningCombination;
      const startPos = cellElements[start].getBoundingClientRect();
      const endPos = cellElements[end].getBoundingClientRect();
      const line = document.createElement('div');
      line.classList.add('winning-line');
      line.style.top = `${(startPos.top + endPos.top) / 2}px`;
      line.style.left = `${(startPos.left + endPos.left) / 2}px`;
      document.body.appendChild(line);
    }
  }
});

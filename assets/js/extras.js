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
    errorMessage.style.display = 'none';
    line.style.display = 'none';
  }

  function handleClick(e) {
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
        setTimeout(bestMove, 300); // AI makes a move after a short delay
      }
    }
  }

  function endGame(draw, winningClass) {
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
    let bestScore = -Infinity;
    let move;
    cellElements.forEach((cell, index) => {
      if (!cell.classList.contains(X_CLASS) && !cell.classList.contains(CIRCLE_CLASS)) {
        cell.classList.add(CIRCLE_CLASS);
        let score = minimax(cellElements, 0, false);
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

  function minimax(newBoard, depth, isMaximizing) {
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
          let score = minimax(cellElements, depth + 1, false);
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
          let score = minimax(cellElements, depth + 1, true);
          cell.classList.remove(X_CLASS);
          bestScore = Math.min(score, bestScore);
        }
      });
      return bestScore;
    }
  }
});

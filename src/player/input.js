// Клавиатура + мышь (pointer lock). Присед — C или Ctrl
// (Ctrl+W закрывает вкладку — браузер не даёт это перехватить, поэтому основная клавиша C).
const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyC', 'ShiftLeft', 'ShiftRight',
  'ControlLeft', 'ControlRight', 'Backquote', 'KeyE', 'KeyR',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6',
]);

export class Input {
  constructor() {
    this.keys = new Set();
    this.yaw = 0;
    this.pitch = 0;
    this.sensitivity = 0.0023;
    this.pointerLocked = false;
    this.onKeyDown = null; // (code) => void — одиночные нажатия (редактор)

    window.addEventListener('keydown', e => {
      if (e.metaKey) return; // Cmd-комбинации (копирование и т.п.) — не игровой ввод
      if (e.repeat) { if (GAME_KEYS.has(e.code)) e.preventDefault(); return; }
      this.keys.add(e.code);
      if (GAME_KEYS.has(e.code)) e.preventDefault();
      if (this.onKeyDown) this.onKeyDown(e.code);
    });
    window.addEventListener('keyup', e => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    document.addEventListener('mousemove', e => {
      if (!this.pointerLocked) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch -= e.movementY * this.sensitivity;
      const lim = Math.PI / 2 - 0.017;
      this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
    });

    // кнопки мыши учитываем только под pointer lock — клики по меню не стреляют
    document.addEventListener('mousedown', e => {
      if (this.pointerLocked) this.keys.add('Mouse' + e.button);
    });
    document.addEventListener('mouseup', e => this.keys.delete('Mouse' + e.button));
  }

  has(code) { return this.keys.has(code); }

  snapshot() {
    return {
      move: {
        x: (this.has('KeyD') ? 1 : 0) - (this.has('KeyA') ? 1 : 0),
        y: (this.has('KeyW') ? 1 : 0) - (this.has('KeyS') ? 1 : 0),
      },
      yaw: this.yaw,
      pitch: this.pitch,
      jump: this.has('Space'),
      crouch: this.has('KeyC') || this.has('ControlLeft') || this.has('ControlRight'),
      walk: this.has('ShiftLeft') || this.has('ShiftRight'),
      fire: this.has('Mouse0'),
      reload: this.has('KeyR'),
    };
  }
}

// Управление pointer lock: ESC всегда снимает захват (браузер, не перехватить),
// возврат — только по клику, у браузера есть ~1.3 с кулдаун на повторный захват.
export function setupPointerLock(canvas, input, { onLock, onUnlock }) {
  async function request() {
    try {
      // unadjustedMovement: сырая мышь без ускорения ОС (не везде поддерживается)
      await canvas.requestPointerLock({ unadjustedMovement: true });
    } catch {
      // в новых браузерах requestPointerLock возвращает Promise — отказ
      // (например, клик в ~1.3 с кулдаун после Esc) прилетает асинхронно,
      // синхронный try/catch его не ловит
      try {
        const p = canvas.requestPointerLock();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch { /* старые браузеры кидают синхронно */ }
    }
  }
  document.addEventListener('pointerlockchange', () => {
    input.pointerLocked = document.pointerLockElement === canvas;
    if (input.pointerLocked) onLock(); else onUnlock();
  });
  return { request };
}

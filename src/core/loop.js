// Цикл с фиксированным шагом симуляции (аккумулятор) и отвязанным рендером.
// Фиксированные тики дадут номера тиков для неткода в фазе 2.
// В render передаётся alpha = acc/dt — доля пути к следующему тику: рендер
// интерполирует позиции, иначе на 120/144 Гц мониторах мир дёргается
// относительно плавной мыши (и даже на 60 Гц бывают 0/2-тиковые кадры).
export function startLoop({ tick, render, dt = 1 / 60, maxDelta = 0.1 }) {
  let last = performance.now();
  let acc = 0;
  let tickCount = 0;
  let fps = 0, frames = 0, fpsTime = 0;

  function frame(now) {
    requestAnimationFrame(frame);
    let delta = (now - last) / 1000;
    last = now;
    if (delta > maxDelta) delta = maxDelta; // сворачивание вкладки не взрывает симуляцию
    acc += delta;
    while (acc >= dt) {
      tick(dt, tickCount++);
      acc -= dt;
    }
    frames++; fpsTime += delta;
    if (fpsTime >= 0.5) { fps = Math.round(frames / fpsTime); frames = 0; fpsTime = 0; }
    render(delta, fps, acc / dt);
  }
  requestAnimationFrame(frame);
}

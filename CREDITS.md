# Источники ассетов

Приватная игра на двоих. Тем не менее фиксируем происхождение и лицензии
сторонних ассетов — часть требует указания авторства (CC-BY).

## Модели

- **Боец (соперник по сети + тренировочные мишени)** — `assets/player.glb`
  «SAS | CS2 Agent Model Blue» by **gettan (kill6lucius)**, Sketchfab, **CC-BY 4.0**
  (указание автора обязательно). Источник:
  https://sketchfab.com/3d-models/sas-cs2-agent-model-blue-7f18aaccd0ee4694a36646101a12339e .
  Реалистичный агент SAS из Counter-Strike 2 (Valve) — противогаз, тактическая
  экипировка. Рип из CS2; для приватной игры допустимо. **Пока БЕЗ анимаций**
  (родные 394 «клипа» — технические позы CS2, непригодны): модель статична,
  анимации idle/бег/смерть — следующий заход (Mixamo или ретаргет).
  Обработка: пере-экспорт через three GLTFExporter (срезал 127k мусорных
  accessor-ов) → meshopt+webp: 42 МБ → 1.4 МБ.
  (Ранее: Quaternius «Character Soldier», CC0 — заменён по просьбе игрока на
  реалистичный вид.)

- **Glock-18 + руки (viewmodel)** — `assets/glock.glb`
  «Fps Rig» by **J-Toastie** через Poly Pizza, **CC-BY** — авторство обязательно.

- **AK-47 (viewmodel)** — `assets/ak47.glb`
  из ассетов проекта `fps-threejs-game` (three.js FPS-демо).

- **Карта de_dust2** — `assets/de_dust2.glb`
  геометрия карты Valve (Counter-Strike). Используется только в приватной игре.

## Звуки

- `assets/sounds/*` — выстрелы/перезарядка/шаги/попадания из наборов CS:Source
  (sourcesounds). Для приватного использования.

## Планы на замену

- Для «настоящего» вида T/CT (военный силуэт) — путь через **Mixamo** (Soldier/Swat
  + idle/run/death/strafe/crouch), лицензия «free-to-use in game», но FBX per-clip →
  нужна сборка в один GLB (Blender/FBX2glTF + gltf-transform). Отложено.

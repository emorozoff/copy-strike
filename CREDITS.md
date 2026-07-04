# Источники ассетов

Приватная игра на двоих. Тем не менее фиксируем происхождение и лицензии
сторонних ассетов — часть требует указания авторства (CC-BY).

## Модели

- **Боец (соперник по сети)** — `assets/player.glb`
  «Character Soldier» by **Quaternius** (quaternius.com), **CC0 / Public Domain**.
  Источник: https://poly.pizza/m/PpLF4rt4ah . Милитари-боец с каской и винтовкой;
  клипы Idle/Run/Run_Gun/Death/Duck. Атрибуция не обязательна; указываем из уважения.
  (Ранее использовалась их же «Character Animated» — заменена на более «боевой» вид.)

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

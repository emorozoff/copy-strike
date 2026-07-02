# COPY-STRIKE

Браузерный клон Counter-Strike для двоих (1v1 по сети, WebRTC P2P). Приватный хобби-проект.

**Играть:** https://emorozoff.github.io/copy-strike/
**Сетевой тест:** https://emorozoff.github.io/copy-strike/net-test.html
**План разработки:** [PLAN.md](PLAN.md)

## Запуск локально

Нужен любой статический сервер (ES-модули не работают с file://):

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

## Статус: фаза 0

Бегаем по Dust2: загрузка карты, коллизии (three-mesh-bvh), капсульный контроллер
(бег/прыжок/присед/ходьба), pointer lock, дев-редактор точек (клавиша `).

## Стек

Three.js + three-mesh-bvh + Trystero (WebRTC, сигналинг Nostr). Без сборщика:
ES-модули + importmap, все библиотеки свендорены в `vendor/`. Хостинг — GitHub Pages.

## Ассеты

- Карта: [de_dust2 — CS map](https://sketchfab.com/3d-models/de-dust2-cs-map-056008d59eb849a29c0ab6884c0c3d87) by pancakesbassoondonut (CC-BY)
- Звуки (с фазы 1): [sourcesounds/cstrike](https://github.com/sourcesounds/cstrike)

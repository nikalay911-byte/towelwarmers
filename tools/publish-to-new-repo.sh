#!/usr/bin/env bash
#
# Публикует «Остатки Ника 41» из ветки Arena в целевой репозиторий и настраивает его:
# код + тег + релиз с zip + GitHub Pages + описание.
#
# Нужен доступ на запись в целевой репозиторий (у вашего аккаунта он есть по определению).
#
#   bash tools/publish-to-new-repo.sh              # всё сразу
#   DRY=1 bash tools/publish-to-new-repo.sh        # только показать команды
#   DST_BRANCH=master bash tools/publish-to-new-repo.sh
#   PAGES=0 bash tools/publish-to-new-repo.sh      # не трогать GitHub Pages
#
set -euo pipefail

SRC=${SRC:-https://github.com/nikalay911-byte/towelwarmers.git}
SRC_BRANCH=${SRC_BRANCH:-arena/fc651909-towelwarmers}
OWNER_REPO=${OWNER_REPO:-nikalay911-byte/ostatki-nika-41}
DST=${DST:-https://github.com/${OWNER_REPO}.git}
DST_BRANCH=${DST_BRANCH:-main}
TAG=${TAG:-v1.0.0}
WORK=${WORK:-/tmp/ostatki-nika-41-publish}
PAGES=${PAGES:-1}
DRY=${DRY:-0}

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
run() { echo "\$ $*"; if [ "$DRY" = "1" ]; then return 0; fi; "$@"; }

say "Клонируем $SRC_BRANCH из $SRC"
if [ "$DRY" = "1" ]; then
  echo "+ rm -rf $WORK && git clone --branch $SRC_BRANCH $SRC $WORK && cd $WORK"
else
  rm -rf "$WORK"
  run git clone --quiet --branch "$SRC_BRANCH" "$SRC" "$WORK"
  cd "$WORK"
fi

say "Проверки перед публикацией ($(git rev-parse --short HEAD))"
if [ "$DRY" != "1" ]; then
  if [ -d node_modules ] || npm install --silent --no-audit --no-fund; then :; fi
  node tools/test.mjs | tail -3
else
  echo "+ node tools/test.mjs"
fi

say "Пуш в $DST ($DST_BRANCH) и тег $TAG"
run git push --quiet "$DST" "HEAD:refs/heads/$DST_BRANCH"
run git tag -f "$TAG"
run git push --quiet -f "$DST" "refs/tags/$TAG"

if command -v gh >/dev/null 2>&1; then
  say "Описание и темы репозитория"
  run gh repo edit "$OWNER_REPO" \
    --description "Прайс-лист из XLS со складскими остатками: Chrome-расширение (MV3) и веб-страница с поиском по любой части слова, живыми фильтрами по цвету/складу/остатку, группировкой и экспортом. Всё локально, без сервера." \
    --add-topic chrome-extension --add-topic xlsx --add-topic price-list \
    --add-topic search --add-topic facets --add-topic "manifest-v3" || true

  say "Релиз $TAG с архивом расширения"
  if [ "$DRY" != "1" ] && gh release view "$TAG" --repo "$OWNER_REPO" >/dev/null 2>&1; then
    echo "релиз $TAG уже есть — пропускаем"
  else
    run npm run --silent package
    run gh release create "$TAG" "dist/ostatki-nika-41-1.0.0.zip" \
      --repo "$OWNER_REPO" --target "$DST_BRANCH" \
      --title "Остатки Ника 41 $TAG — прайс из XLS с поиском и фильтрами" \
      --notes "$(cat <<'NOTES'
**Установка в Chrome:** распаковать `ostatki-nika-41-<версия>.zip` → `chrome://extensions` → режим разработчика → «Загрузить распакованное расширение» → выбрать папку с `manifest.json`. Разрешение одно — `storage`; файл читается локально, без сети.

**Что внутри:** страница прайса (`app/index.html` — работает и как обычный сайт), попап с быстрым поиском, настройки, сервис-воркер с переиспользованием вкладки и бейджем, вендорный SheetJS (сборка не нужна), демо-прайс в `demo/price-demo.xls`.

**Возможности:** поиск по любой части слова по всем колонкам (`-слово` — исключить, «фраза» — точно, поиск понимает забытую раскладку), фасетные фильтры с пересчётом счётчиков «кроме своего», свотчи цветов, режим «Спецификации» со сводом остатков по номенклатуре, панель подробностей, перечитывание того же файла и автообновление, экспорт XLSX/CSV/TSV/JSON, ссылка на выборку через `#q=…&color=…`, светлая/тёмная темы.

**Проверки:** `node tools/test.mjs` — 50 тестов, включая прогон реальной страницы в jsdom; `node tools/bench.mjs 100000` — 100k строк: импорт 0.6 с, пересчёт фильтра 20–90 мс.
NOTES
)" || echo "не удалось создать релиз (возможно, тег уже выпущен) — код и тег на месте"
  fi

  say "GitHub Pages — страница прайса по постоянному URL"
  OWNER=$(echo "$OWNER_REPO" | cut -d/ -f1 | tr 'A-Z' 'a-z')
  NAME=$(basename "$OWNER_REPO")
  PAGES_URL="https://$OWNER.github.io/$NAME/app/index.html"
  if [ "$PAGES" = "legacy" ]; then
    # вариант «деплой из ветки» (без workflow); строчка пути = корень репозитория
    run gh api -X POST "repos/$OWNER_REPO/pages" \
      --input <(printf '{"source":{"branch":"%s","path":"/"},"build_type":"legacy"}' "$DST_BRANCH") \
      || run gh api -X PUT "repos/$OWNER_REPO/pages" -f "source[branch]=$DST_BRANCH" -f "source[path]=/" || true
  else
    # вариант «деплой через GitHub Actions» — совпадает с .github/workflows/pages.yml
    run gh api -X POST "repos/$OWNER_REPO/pages" -f build_type=workflow \
      || run gh api -X PUT "repos/$OWNER_REPO/pages" -f build_type=workflow || true
    run gh workflow run pages.yml --repo "$OWNER_REPO" --ref "$DST_BRANCH" || true
  fi
  run gh repo edit "$OWNER_REPO" --homepage "$PAGES_URL" || true
  echo "Pages: $PAGES_URL  (лендинг: https://$OWNER.github.io/$NAME/)"
  echo "Домен может появиться не сразу: gh api repos/$OWNER_REPO/pages --jq .status"

else
  echo "\ngh не найден — описание/релиз/Pages надо настроить вручную (код и тег уже запушены)." >&2
fi

say "Готово"
echo "Репозиторий:   https://github.com/$OWNER_REPO"
echo "Страница:      https://github.com/$OWNER_REPO/tree/$DST_BRANCH"
echo "Релиз:         https://github.com/$OWNER_REPO/releases/tag/$TAG"
if [ "$DRY" = "1" ]; then echo "(это был dry-run: команды не выполнялись)"; fi

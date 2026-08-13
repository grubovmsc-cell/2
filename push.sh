#!/bin/bash
echo ""
echo "Вставьте GitHub токен и нажмите Enter:"
read -r TOKEN

if [ -z "$TOKEN" ]; then
  echo "Токен не введён. Выход."
  exit 1
fi

git remote set-url origin "https://grubovmsc-cell:${TOKEN}@github.com/grubovmsc-cell/2.git"
git push -u origin main --force

echo ""
echo "Готово! Откройте Railway: https://railway.app/project/c3743bd0-caec-4acc-b803-699e0b6645d0"

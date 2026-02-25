#!/bin/bash
# EC2 初期セットアップスクリプト
# 使い方: SSM Session Manager で EC2 に接続してから実行
#   bash setup.sh
#
# 実行後、EC2 上で Claude Code が使えるようになる

set -euo pipefail

echo "========================================"
echo " Claude Code on EC2 - セットアップ開始"
echo "========================================"

# ── システムアップデート ─────────────────────────
echo "[1/5] システムパッケージを更新中..."
sudo dnf update -y

# ── Node.js インストール ─────────────────────────
echo "[2/5] Node.js (LTS) をインストール中..."
# Amazon Linux 2023 では nvm 経由でインストールするのが安定
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash

# nvm を現在のシェルで有効化
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

nvm install --lts
nvm use --lts
nvm alias default node

echo "  Node.js バージョン: $(node -v)"
echo "  npm バージョン: $(npm -v)"

# ── Claude Code インストール ─────────────────────
echo "[3/5] Claude Code をインストール中..."
npm install -g @anthropic-ai/claude-code

echo "  Claude Code バージョン: $(claude --version)"

# ── tmux インストール ────────────────────────────
echo "[4/5] tmux をインストール中..."
sudo dnf install -y tmux git

echo "  tmux バージョン: $(tmux -V)"

# ── .bashrc への追記（nvm の永続化） ────────────
echo "[5/5] シェル設定を更新中..."
cat >> ~/.bashrc << 'EOF'

# nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
EOF

echo ""
echo "========================================"
echo " セットアップ完了！"
echo "========================================"
echo ""
echo "次のステップ:"
echo "  1. source ~/.bashrc"
echo "  2. claude  （claude.ai アカウントでログイン）"
echo "  3. bash start-claude.sh  （Remote Control 起動）"
echo ""

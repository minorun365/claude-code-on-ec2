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
echo "[1/3] システムパッケージを更新中..."
sudo dnf update -y

# ── tmux / git インストール ──────────────────────
echo "[2/3] tmux・git をインストール中..."
sudo dnf install -y tmux git

echo "  tmux バージョン: $(tmux -V)"

# ── Claude Code ネイティブインストール ────────────
echo "[3/3] Claude Code をインストール中..."
# 公式推奨の直接インストール（Node.js 不要）
curl -fsSL https://claude.ai/install.sh | bash

echo "  Claude Code バージョン: $(~/.local/bin/claude --version)"

echo ""
echo "========================================"
echo " セットアップ完了！"
echo "========================================"
echo ""
echo "次のステップ:"
echo "  1. source ~/.bashrc  （PATH に ~/.local/bin を追加）"
echo "  2. claude  （claude.ai アカウントでログイン）"
echo "  3. bash start-claude.sh  （Remote Control 起動）"
echo ""

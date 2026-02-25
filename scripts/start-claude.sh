#!/bin/bash
# Claude Code Remote Control 起動スクリプト
# 使い方: EC2 上で実行する
#   bash start-claude.sh
#
# tmux セッション "claude" を作成し、Claude Code Remote Control を起動する。
# EC2 から SSH/SSM 接続を切っても tmux セッションは継続する。

set -euo pipefail

SESSION_NAME="claude"

# nvm のロード
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# claude コマンドが使えるか確認
if ! command -v claude &> /dev/null; then
  echo "エラー: claude コマンドが見つかりません。"
  echo "先に setup.sh を実行してください。"
  exit 1
fi

# 既存の tmux セッションがあればアタッチ、なければ新規作成
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "既存の tmux セッション '$SESSION_NAME' にアタッチします..."
  tmux attach -t "$SESSION_NAME"
else
  echo "tmux セッション '$SESSION_NAME' を新規作成して Claude Code を起動します..."
  tmux new-session -d -s "$SESSION_NAME" -x 220 -y 50
  # Claude Code Remote Control を起動
  tmux send-keys -t "$SESSION_NAME" "claude remote-control" Enter
  echo ""
  echo "======================================"
  echo " Claude Code Remote Control 起動中！"
  echo "======================================"
  echo ""
  echo "tmux セッションにアタッチします（Ctrl+B, D でデタッチできます）"
  echo ""
  tmux attach -t "$SESSION_NAME"
fi

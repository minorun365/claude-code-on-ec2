# Claude Code on EC2

AWS EC2 上で Claude Code を常時稼働させ、スマホ・Mac・VSCode などどこからでも
Remote Control でアクセスできる**パーソナル Claude Code サーバー**を CDK で構築します。

```
スマホ / Mac / VSCode
    ↕ Remote Control（HTTPS）または SSM Session Manager
EC2 t4g.large（Amazon Linux 2023 / Graviton2）
    └── tmux セッション「claude」
          └── Claude Code（systemd + tmux で常時稼働）
```

## 主な機能

接続は SSM Session Manager 経由なので、SSH のポートを開けずに済みます。スマホ・Mac・VS Code のどれからでも、Remote Control で同じ Claude Code を操作できます。

Claude Code は EC2 上の tmux セッションで動き続けるので、Mac を閉じても作業は止まりません。EC2 を再起動しても systemd が自動で立ち上げ直します。Claude Code を終了したあとは、別のプロジェクトのディレクトリで起動し直せます。

## 必要なもの

- AWS アカウント
- claude.ai の **Pro または Max プラン**（Remote Control 機能に必要）
- ローカル PC: AWS CLI、CDK (`npm install -g aws-cdk`)、`session-manager-plugin`

## セットアップ

### 1. session-manager-plugin のインストール

```bash
# macOS Apple Silicon（AWS 公式 pkg）
curl "https://session-manager-downloads.s3.amazonaws.com/plugin/latest/mac_arm64/sessionmanager-bundle.zip" -o /tmp/sm.zip
unzip /tmp/sm.zip -d /tmp/
sudo /tmp/sessionmanager-bundle/install -i /usr/local/sessionmanagerplugin -b /usr/local/bin/session-manager-plugin

# macOS Intel（Homebrew）
brew install --cask session-manager-plugin
```

### 2. CDK デプロイ

```bash
git clone https://github.com/minorun365/claude-code-on-ec2.git
cd claude-code-on-ec2/cdk
npm install
./node_modules/.bin/cdk bootstrap  # 初回のみ
./node_modules/.bin/cdk deploy
```

デプロイ後に `InstanceId` が出力されます。セットアップ完了まで約 5〜10 分かかります。

```bash
# 完了確認
aws ssm send-command --instance-id <InstanceId> --region us-east-1 \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["cat /home/ec2-user/.setup-complete"]'
```

### 3. EC2 に接続して Claude Code にログイン

```bash
aws ssm start-session --target <InstanceId> --region us-east-1
```

接続後：

```bash
sudo su - ec2-user   # tmux セッションに自動アタッチされる
claude               # ブラウザ認証 → claude.ai にログイン
```

> AWS コンソールからも接続可: EC2 → 「接続」→「Session Manager」タブ

### 4. Remote Control を有効化

```
/config
```

「すべてのセッションでリモートコントロールを有効にする」を `true` に設定すると、
以降は `claude` 起動時に自動で Remote Control が有効になります。

### 5. スマホから接続

- `claude.ai/code` を開くと緑ドットのアクティブセッションが一覧表示されます
- またはターミナルに表示された URL、もしくはスペースキーで出る QR コードから接続

### 6. VSCode Remote-SSH 連携（オプション）

`~/.ssh/config` に追記（ProxyCommand は **1行で**書くこと）：

```
Host claude-ec2
    HostName <InstanceId>
    User ec2-user
    StrictHostKeyChecking accept-new
    ProxyCommand aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p --region us-east-1
```

SSH 公開鍵の登録：

```bash
aws ssm send-command --instance-id <InstanceId> --region us-east-1 \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["echo \"<公開鍵>\" >> /home/ec2-user/.ssh/authorized_keys"]'
```

## ワークスペース変更

Claude Code を exit した後、bash シェルに落ちるので別ディレクトリで再起動できます。

```bash
# 方法1: cd + claude
cd ~/git/my-project && claude

# 方法2: cw ヘルパー関数（.bashrc 定義済み）
cw ~/git/my-project
```

## tmux 基本操作

| 操作 | キー | 覚え方 |
|------|------|--------|
| デタッチ（切断せず離れる） | `Ctrl+B, D` | **D**etach |
| 新しいウィンドウ作成 | `Ctrl+B, C` | **C**reate |
| 次のウィンドウ | `Ctrl+B, N` | **N**ext |
| 前のウィンドウ | `Ctrl+B, P` | **P**revious |
| ウィンドウ番号で移動 | `Ctrl+B, 数字` | — |
| スクロールモード | `Ctrl+B, [` | `q` で終了 |

> `Ctrl+B` は tmux への「合図キー」。その後に押す1文字が命令（すべて英単語の頭文字）。

## コスト目安（us-east-1）

| リソース | 月額 |
|---------|------|
| EC2 t4g.large（24h稼働） | 約 $49 |
| EBS gp3 30GB | 約 $2.4 |
| AWS Backup 週次スナップショット | 約 $1〜3 |
| SSM / Elastic IP（使用中） | 無料 |
| **合計** | **約 $52〜55** |

## データ保護

| 対策 | 内容 |
|------|------|
| EC2 終了保護 | 誤 terminate を防止（削除時は AWS コンソールで手動解除） |
| EBS 削除保護 | EC2 terminate 後もデータ保持（`deleteOnTermination: false`） |
| AWS Backup | 週次 EBS スナップショット・30日保持 |

## トラブルシューティング

| 症状 | 対処 |
|------|------|
| `SessionManagerPlugin is not found` | Step 1 で session-manager-plugin をインストール |
| `claude` コマンドが見つからない | `source ~/.bashrc` を実行（PATH に `~/.local/bin` を追加） |
| Bash ツールで `not a terminal` エラー | `export TERM=xterm-256color` を実行（本 CDK では自動設定済み） |
| VSCode で `Unexpected line break` | `~/.ssh/config` の ProxyCommand を1行にまとめる |
| CDK CLI バージョン不一致エラー | `npm install aws-cdk@latest --save-dev` でアップデート |
